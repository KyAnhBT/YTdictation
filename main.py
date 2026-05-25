from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse
from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api._errors import (
    TranscriptsDisabled,
    NoTranscriptFound,
    VideoUnavailable,
    YouTubeRequestFailed,
)
from pydantic import BaseModel
import asyncio
import re
import html
from typing import Optional

app = FastAPI(title="YT Dictation")
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

_yt_api = YouTubeTranscriptApi()


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


# ── routes ────────────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse(request, "index.html")


@app.get("/api/transcript")
async def get_transcript(url: str):
    video_id = extract_video_id(url)
    if not video_id:
        raise HTTPException(400, "URL YouTube không hợp lệ.")

    try:
        transcript_list = _yt_api.list(video_id)
    except TranscriptsDisabled:
        raise HTTPException(404, "Video này đã tắt phụ đề.")
    except NoTranscriptFound:
        raise HTTPException(404, "Không tìm thấy phụ đề cho video này.")
    except VideoUnavailable:
        raise HTTPException(404, "Video không tồn tại hoặc không thể truy cập.")
    except YouTubeRequestFailed as e:
        raise HTTPException(503, f"YouTube từ chối kết nối: {e}")
    except Exception as e:
        raise HTTPException(500, f"Lỗi khi tải danh sách phụ đề: {e}")

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
        raise HTTPException(404, "Không có phụ đề khả dụng.")

    try:
        en_raw = transcript.fetch()
    except Exception as e:
        raise HTTPException(500, f"Lỗi khi tải phụ đề: {e}")

    segments = group_segments(en_raw)
    if not segments:
        raise HTTPException(404, "Phụ đề trống hoặc không đọc được.")

    # Try YouTube's built-in VI translation (instant, no extra cost)
    translations: list[Optional[str]] = [None] * len(segments)
    has_yt_vi = False
    if not transcript.language_code.startswith('vi'):
        try:
            vi_raw = transcript.translate('vi').fetch()
            translations = align_translations(segments, vi_raw)
            has_yt_vi = any(t for t in translations)
        except Exception:
            pass

    return {
        "video_id": video_id,
        "language": transcript.language,
        "language_code": transcript.language_code,
        "is_generated": transcript.is_generated,
        "segments": segments,
        "translations": translations,
        # tells frontend whether to fetch translations separately
        "need_translate": not has_yt_vi and not transcript.language_code.startswith('vi'),
    }


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
