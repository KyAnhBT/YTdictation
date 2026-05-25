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
import re
import html
from typing import Optional

app = FastAPI(title="YT Dictation")
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

_yt_api = YouTubeTranscriptApi()


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
    """
    Match each grouped EN segment to VI snippets by timestamp overlap,
    then join them as the translation for that segment.
    """
    vi_snippets = [to_dict(s) for s in vi_raw]
    translations = []
    for seg in en_segments:
        end = seg['start'] + seg['duration']
        parts = [
            clean_text(s['text'])
            for s in vi_snippets
            if s['start'] >= seg['start'] - 0.5 and s['start'] < end + 0.5
            and clean_text(s['text'])
        ]
        translations.append(' '.join(parts) if parts else None)
    return translations


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

    # Pick best EN transcript
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

    # Fetch Vietnamese translation using YouTube's own translation service
    translations: list[Optional[str]] = [None] * len(segments)
    if not transcript.language_code.startswith('vi'):
        try:
            vi_raw = transcript.translate('vi').fetch()
            translations = align_translations(segments, vi_raw)
        except Exception:
            pass  # translation unavailable for this video — silently skip

    return {
        "video_id": video_id,
        "language": transcript.language,
        "language_code": transcript.language_code,
        "is_generated": transcript.is_generated,
        "segments": segments,
        "translations": translations,
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
