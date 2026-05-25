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

# v1.x requires instantiation
_yt_api = YouTubeTranscriptApi()


def extract_video_id(url: str) -> Optional[str]:
    url = url.strip()
    patterns = [
        r'(?:youtube\.com/watch\?v=|youtube\.com/embed/|youtube\.com/shorts/)([0-9A-Za-z_-]{11})',
        r'youtu\.be/([0-9A-Za-z_-]{11})',
    ]
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    if re.match(r'^[0-9A-Za-z_-]{11}$', url):
        return url
    return None


def clean_text(text: str) -> str:
    text = re.sub(r'<[^>]+>', '', text)
    text = html.unescape(text)
    text = re.sub(r'\s+', ' ', text)
    return text.strip()


def snippet_to_dict(seg) -> dict:
    """Normalise both dict (v0.x) and object (v1.x) snippets."""
    if isinstance(seg, dict):
        return seg
    return {'text': seg.text, 'start': float(seg.start), 'duration': float(seg.duration)}


def group_segments(raw, target: float = 6.0, max_dur: float = 14.0) -> list:
    result = []
    current = None

    for raw_seg in raw:
        seg = snippet_to_dict(raw_seg)
        text = clean_text(seg['text'])
        if not text:
            continue

        if current is None:
            current = {'text': text, 'start': seg['start'], 'duration': seg['duration']}
        else:
            new_end = seg['start'] + seg['duration']
            merged_dur = new_end - current['start']
            ends_sentence = current['text'].rstrip().endswith(('.', '!', '?'))

            if merged_dur > max_dur or (merged_dur >= target and ends_sentence):
                result.append(current)
                current = {'text': text, 'start': seg['start'], 'duration': seg['duration']}
            else:
                current['text'] += ' ' + text
                current['duration'] = new_end - current['start']

    if current:
        result.append(current)

    return result


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/api/transcript")
async def get_transcript(url: str):
    video_id = extract_video_id(url)
    if not video_id:
        raise HTTPException(status_code=400, detail="URL YouTube không hợp lệ. Vui lòng kiểm tra lại.")

    try:
        transcript_list = _yt_api.list(video_id)
    except TranscriptsDisabled:
        raise HTTPException(status_code=404, detail="Video này đã tắt phụ đề.")
    except NoTranscriptFound:
        raise HTTPException(status_code=404, detail="Không tìm thấy phụ đề cho video này.")
    except VideoUnavailable:
        raise HTTPException(status_code=404, detail="Video không tồn tại hoặc không thể truy cập.")
    except YouTubeRequestFailed as e:
        raise HTTPException(status_code=503, detail=f"YouTube từ chối kết nối: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Lỗi khi tải danh sách phụ đề: {str(e)}")

    transcript = None
    # Prefer manual English → any manual → auto English → anything
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
        raise HTTPException(status_code=404, detail="Không có phụ đề khả dụng cho video này.")

    try:
        raw = transcript.fetch()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Lỗi khi tải nội dung phụ đề: {str(e)}")

    segments = group_segments(raw)
    if not segments:
        raise HTTPException(status_code=404, detail="Phụ đề trống hoặc không đọc được.")

    return {
        "video_id": video_id,
        "language": transcript.language,
        "language_code": transcript.language_code,
        "is_generated": transcript.is_generated,
        "segments": segments,
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, reload=True)
