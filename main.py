from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse
from youtube_transcript_api import YouTubeTranscriptApi
from pydantic import BaseModel
import asyncio
import re
import html
import json
import tempfile
import os
import httpx
from typing import Optional

app = FastAPI(title="YT Dictation")
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# Use cookies.txt if present (Netscape format — export via browser extension)
_cookies_path = "cookies.txt" if os.path.exists("cookies.txt") else None
_yt_api = YouTubeTranscriptApi(cookies=_cookies_path) if _cookies_path else YouTubeTranscriptApi()

# Persistent transcript cache — survives server restarts
_CACHE_FILE = "transcript_cache.json"

def _load_cache() -> dict:
    try:
        with open(_CACHE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

def _save_cache(cache: dict) -> None:
    try:
        with open(_CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False)
    except Exception:
        pass

_cache: dict = _load_cache()


# ── helpers ──────────────────────────────────────────────────────────────────

def extract_video_id(url: str) -> Optional[str]:
    url = url.strip()
    for pattern in [
        r'(?:youtube\.com/watch\?v=|youtube\.com/embed/|youtube\.com/shorts/)([0-9A-Za-z_-]{11})',
        r'youtu\.be/([0-9A-Za-z_-]{11})',
    ]:
        m = re.search(pattern, url)
        if m:
            return m.group(1)
    if re.match(r'^[0-9A-Za-z_-]{11}$', url):
        return url
    return None


def clean_text(text: str) -> str:
    text = re.sub(r'<[^>]+>', '', text)
    text = html.unescape(text)
    return re.sub(r'\s+', ' ', text).strip()


def to_dict(seg) -> dict:
    if isinstance(seg, dict):
        return seg
    return {'text': seg.text, 'start': float(seg.start), 'duration': float(seg.duration)}


def group_segments(raw, target: float = 6.0, max_dur: float = 14.0) -> list[dict]:
    result, cur = [], None
    for raw_seg in raw:
        seg = to_dict(raw_seg)
        text = clean_text(seg['text'])
        if not text:
            continue
        if cur is None:
            cur = {'text': text, 'start': seg['start'], 'duration': seg['duration']}
        else:
            new_end = seg['start'] + seg['duration']
            merged = new_end - cur['start']
            ends = cur['text'].rstrip().endswith(('.', '!', '?'))
            if merged > max_dur or (merged >= target and ends):
                result.append(cur)
                cur = {'text': text, 'start': seg['start'], 'duration': seg['duration']}
            else:
                cur['text'] += ' ' + text
                cur['duration'] = new_end - cur['start']
    if cur:
        result.append(cur)
    return result


def align_translations(en_segments: list[dict], vi_raw) -> list[Optional[str]]:
    """Map YouTube VI snippets onto grouped EN segments by timestamp."""
    vi_snippets = [to_dict(s) for s in vi_raw]
    out = []
    for seg in en_segments:
        end = seg['start'] + seg['duration']
        parts = [
            clean_text(s['text'])
            for s in vi_snippets
            if s['start'] >= seg['start'] - 0.5 and s['start'] < end + 0.5
            and clean_text(s['text'])
        ]
        out.append(' '.join(parts) if parts else None)
    return out


# ── shared subtitle helpers ───────────────────────────────────────────────────

def _parse_json3(data: dict) -> list[dict]:
    snippets = []
    for ev in data.get('events', []):
        if 'segs' not in ev:
            continue
        text = clean_text(''.join(s.get('utf8', '') for s in ev['segs']))
        if not text:
            continue
        start = ev.get('tStartMs', 0) / 1000.0
        dur   = ev.get('dDurationMs', 2000) / 1000.0
        snippets.append({'text': text, 'start': start, 'duration': dur})
    return snippets


# ── yt-dlp fallback ───────────────────────────────────────────────────────────

def _ytdlp_fetch_subtitles(video_id: str) -> Optional[dict]:
    """
    Fallback: use yt-dlp to download subtitle JSON and return
    { 'lang': str, 'lang_code': str, 'is_generated': bool, 'snippets': list[dict] }
    Returns None if yt-dlp is unavailable or no subtitles found.
    """
    try:
        import yt_dlp
    except ImportError:
        return None

    url = f"https://www.youtube.com/watch?v={video_id}"
    with tempfile.TemporaryDirectory() as tmpdir:
        ydl_opts = {
            'skip_download': True,
            'writesubtitles': True,
            'writeautomaticsub': True,
            'subtitleslangs': ['en', 'en-US', 'en-GB'],
            'subtitlesformat': 'json3',
            'outtmpl': os.path.join(tmpdir, '%(id)s'),
            'quiet': True,
            'no_warnings': True,
        }
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=True)
        except Exception:
            return None

        # Determine which subtitle was actually downloaded via info dict
        sub_file = None
        is_generated = False
        lang_code = 'en'
        lang = 'English'

        # Check manual subtitles first, then auto-generated
        for lc in ['en', 'en-US', 'en-GB']:
            if info.get('subtitles', {}).get(lc):
                lang_code = lc
                lang = info['subtitles'][lc][0].get('name', 'English')
                is_generated = False
                break
            if info.get('automatic_captions', {}).get(lc):
                lang_code = lc
                lang = info['automatic_captions'][lc][0].get('name', 'English (auto)')
                is_generated = True
                break

        for fname in os.listdir(tmpdir):
            if fname.endswith('.json3'):
                sub_file = os.path.join(tmpdir, fname)
                break

        if not sub_file:
            return None

        try:
            with open(sub_file, encoding='utf-8') as f:
                data = json.load(f)
        except Exception:
            return None

        snippets = _parse_json3(data)
        if not snippets:
            return None

        return {'lang': lang, 'lang_code': lang_code, 'is_generated': is_generated, 'snippets': snippets}


# ── Invidious fallback ────────────────────────────────────────────────────────

_INVIDIOUS_INSTANCES = [
    "https://invidious.privacyredirect.com",
    "https://yewtu.be",
    "https://inv.riverside.rocks",
    "https://invidious.lunar.icu",
    "https://iv.datura.network",
    "https://invidious.protokolla.fi",
]

async def _invidious_fetch_subtitles(video_id: str) -> Optional[dict]:
    """Try public Invidious instances — they proxy YouTube so cloud IP bans don't apply."""
    async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
        for instance in _INVIDIOUS_INSTANCES:
            try:
                r = await client.get(f"{instance}/api/v1/captions/{video_id}")
                if r.status_code != 200:
                    continue
                captions = r.json().get('captions', [])

                # Prefer manual English, then auto-generated English
                cap = None
                for c in captions:
                    lc = c.get('languageCode', '')
                    if lc.startswith('en') and 'auto' not in c.get('label', '').lower():
                        cap = c; break
                if not cap:
                    for c in captions:
                        if c.get('languageCode', '').startswith('en'):
                            cap = c; break
                if not cap:
                    continue

                # Build caption URL with json3 format
                cap_url = cap['url']
                if not cap_url.startswith('http'):
                    cap_url = instance + cap_url
                cap_url = re.sub(r'fmt=[^&]*', 'fmt=json3', cap_url)
                if 'fmt=' not in cap_url:
                    cap_url += '&fmt=json3'

                r2 = await client.get(cap_url)
                if r2.status_code != 200:
                    continue

                snippets = _parse_json3(r2.json())
                if not snippets:
                    continue

                label = cap.get('label', 'English')
                return {
                    'lang': label,
                    'lang_code': cap.get('languageCode', 'en'),
                    'is_generated': 'auto' in label.lower(),
                    'snippets': snippets,
                }
            except Exception:
                continue
    return None


# ── routes ────────────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse(request, "index.html")


@app.get("/api/transcript")
async def get_transcript(url: str):
    video_id = extract_video_id(url)
    if not video_id:
        raise HTTPException(400, "URL YouTube không hợp lệ.")

    if video_id in _cache:
        return _cache[video_id]

    # ── Primary path: youtube-transcript-api ──────────────────
    primary_error = None
    segments = None
    translations: list[Optional[str]] = []
    lang = 'English'
    lang_code = 'en'
    is_generated = True
    has_yt_vi = False

    try:
        transcript_list = _yt_api.list(video_id)

        transcript = None
        for finder in [
            lambda tl: tl.find_manually_created_transcript(['en', 'en-US', 'en-GB']),
            lambda tl: next((t for t in tl if not t.is_generated), None),
            lambda tl: tl.find_generated_transcript(['en', 'en-US', 'en-GB']),
            lambda tl: next(iter(tl), None),
        ]:
            try:
                t = finder(transcript_list)
                if t:
                    transcript = t
                    break
            except Exception:
                continue

        if not transcript:
            raise ValueError("Không có phụ đề khả dụng.")

        en_raw  = transcript.fetch()
        segments = group_segments(en_raw)
        lang     = transcript.language
        lang_code = transcript.language_code
        is_generated = transcript.is_generated

        translations = [None] * len(segments)
        if not lang_code.startswith('vi'):
            try:
                vi_raw = transcript.translate('vi').fetch()
                translations = align_translations(segments, vi_raw)
                has_yt_vi = any(t for t in translations)
            except Exception:
                pass

    except Exception as e:
        primary_error = str(e)

    # ── Fallback: yt-dlp ──────────────────────────────────────
    if not segments:
        loop = asyncio.get_event_loop()
        ytdlp_result = await loop.run_in_executor(None, _ytdlp_fetch_subtitles, video_id)
        if ytdlp_result:
            segments    = group_segments(ytdlp_result['snippets'])
            lang        = ytdlp_result['lang']
            lang_code   = ytdlp_result['lang_code']
            is_generated = ytdlp_result['is_generated']
            translations = [None] * len(segments)
    # ── Fallback: Invidious proxy ─────────────────────────────
    if not segments:
        inv_result = await _invidious_fetch_subtitles(video_id)
        if inv_result:
            segments     = group_segments(inv_result['snippets'])
            lang         = inv_result['lang']
            lang_code    = inv_result['lang_code']
            is_generated = inv_result['is_generated']
            translations = [None] * len(segments)

    if not segments:
        # All three paths failed
        msg = primary_error or "Không tìm thấy phụ đề cho video này."
        if 'blocking' in msg or 'IP' in msg or 'too many' in msg.lower() or '429' in msg:
            hint = " Đặt file cookies.txt vào thư mục app để dùng cookie YouTube của bạn." if not _cookies_path else ""
            raise HTTPException(429,
                f"YouTube tạm thời chặn IP do quá nhiều request.{hint} "
                "Thử lại sau vài phút hoặc dùng video khác trước.")
        raise HTTPException(500, f"Lỗi khi tải phụ đề: {msg}")

    if not segments:
        raise HTTPException(404, "Phụ đề trống hoặc không đọc được.")

    response = {
        "video_id": video_id,
        "language": lang,
        "language_code": lang_code,
        "is_generated": is_generated,
        "segments": segments,
        "translations": translations,
        "need_translate": not has_yt_vi and not lang_code.startswith('vi'),
    }
    _cache[video_id] = response
    _save_cache(_cache)
    return response


# ── translation endpoint ──────────────────────────────────────────────────────

class TranslateRequest(BaseModel):
    texts: list[str]
    target: str = "vi"


async def _translate_one(text: str, target: str) -> Optional[str]:
    """Translate a single text in a thread (deep-translator is synchronous)."""
    loop = asyncio.get_event_loop()
    def _do():
        try:
            from deep_translator import GoogleTranslator
            return GoogleTranslator(source="auto", target=target).translate(text)
        except Exception:
            try:
                from deep_translator import MyMemoryTranslator
                lang_map = {"vi": "vi-VN", "en": "en-US"}
                tgt = lang_map.get(target, target)
                return MyMemoryTranslator(source="en-US", target=tgt).translate(text)
            except Exception:
                return None
    return await loop.run_in_executor(None, _do)


@app.post("/api/translate")
async def translate_texts(body: TranslateRequest):
    if not body.texts:
        return {"translations": []}

    # Translate all segments concurrently (up to 8 at a time)
    sem = asyncio.Semaphore(8)

    async def bounded(text: str) -> Optional[str]:
        async with sem:
            return await _translate_one(text, body.target)

    results = await asyncio.gather(*[bounded(t) for t in body.texts])
    return {"translations": list(results)}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
