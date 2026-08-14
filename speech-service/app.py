import asyncio
import io
import logging
import subprocess
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator

STT_MODEL_ID = "nvidia/parakeet-tdt-0.6b-v3"
TTS_MODEL_ID = "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"
VOICE = "Aiden"
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_DURATION_SECONDS = 90.0
READ_CHUNK_BYTES = 1024 * 1024
ALLOWED_SUFFIXES = {".webm", ".mp4", ".ogg", ".wav"}
ALLOWED_CONTENT_TYPES = {
    "application/ogg",
    "audio/mp4",
    "audio/ogg",
    "audio/vnd.wave",
    "audio/wav",
    "audio/webm",
    "audio/x-wav",
    "video/mp4",
    "video/webm",
}

logger = logging.getLogger("bb-speech-service")
stt_model: Any | None = None
tts_model: Any | None = None
stt_lock = asyncio.Lock()
tts_lock = asyncio.Lock()


class SpeechRequest(BaseModel):
    input: str = Field(min_length=1, max_length=8000)
    voice: Literal[VOICE]

    @field_validator("input")
    @classmethod
    def reject_blank_input(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("input must contain text")
        return value


def _load_models() -> tuple[Any, Any]:
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable; refusing to load speech models")

    from faster_qwen3_tts import FasterQwen3TTS
    from nano_parakeet import from_pretrained

    logger.info("Loading STT model %s", STT_MODEL_ID)
    loaded_stt = from_pretrained(STT_MODEL_ID, device="cuda")

    logger.info("Loading TTS model %s with the Torch backend", TTS_MODEL_ID)
    loaded_tts = FasterQwen3TTS.from_pretrained(
        TTS_MODEL_ID,
        device="cuda",
        dtype=torch.bfloat16,
        backend="torch",
    )
    loaded_tts.warmup(prefill_len=100)
    torch.cuda.synchronize()
    return loaded_stt, loaded_tts


@asynccontextmanager
async def lifespan(_: FastAPI):
    global stt_model, tts_model
    try:
        stt_model, tts_model = await asyncio.to_thread(_load_models)
    except Exception:
        logger.exception("Speech model startup failed")
        raise
    logger.info("Speech models are ready")
    yield
    stt_model = None
    tts_model = None


app = FastAPI(title="BB Speech Service", lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, str | bool]:
    stt_ready = stt_model is not None
    tts_ready = tts_model is not None
    return {
        "status": "ok" if stt_ready and tts_ready else "starting",
        "stt": stt_ready,
        "tts": tts_ready,
    }


def _validate_upload(file: UploadFile) -> str:
    suffix = Path(file.filename or "").suffix.lower()
    content_type = (file.content_type or "").lower().split(";", 1)[0]
    if suffix not in ALLOWED_SUFFIXES and content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=415,
            detail="Audio must be WebM, MP4, Ogg, or WAV",
        )
    return suffix if suffix in ALLOWED_SUFFIXES else ".audio"


async def _save_upload(file: UploadFile, destination: Path) -> None:
    size = 0
    try:
        with destination.open("wb") as output:
            while chunk := await file.read(READ_CHUNK_BYTES):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail="Audio exceeds the 25 MB limit",
                    )
                output.write(chunk)
    finally:
        await file.close()
    if size == 0:
        raise HTTPException(status_code=400, detail="Audio file is empty")


def _decode_audio(source: Path, destination: Path) -> None:
    command = [
        "ffmpeg",
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source),
        "-vn",
        "-t",
        str(MAX_DURATION_SECONDS + 0.05),
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        str(destination),
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=120)
    except FileNotFoundError as exc:
        raise RuntimeError("ffmpeg is not installed") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("ffmpeg decode timed out") from exc
    if result.returncode != 0:
        detail = result.stderr.strip() or "unknown ffmpeg error"
        raise RuntimeError(f"ffmpeg decode failed: {detail}")

    info = sf.info(destination)
    if info.frames == 0:
        raise RuntimeError("decoded audio is empty")
    if info.duration > MAX_DURATION_SECONDS:
        raise HTTPException(
            status_code=413,
            detail="Audio exceeds the 90 second limit",
        )


def _transcribe(wav_path: Path) -> str:
    if stt_model is None:
        raise RuntimeError("STT model is not ready")
    text = stt_model.transcribe(str(wav_path))
    if not isinstance(text, str):
        raise RuntimeError("STT model returned an invalid result")
    return text


@app.post("/v1/audio/transcriptions")
async def transcribe(file: UploadFile = File(...)) -> dict[str, str]:
    suffix = _validate_upload(file)
    with tempfile.TemporaryDirectory(prefix="bb-speech-") as temp_dir:
        source = Path(temp_dir) / f"input{suffix}"
        decoded = Path(temp_dir) / "decoded.wav"
        await _save_upload(file, source)
        try:
            await asyncio.to_thread(_decode_audio, source, decoded)
            async with stt_lock:
                text = await asyncio.to_thread(_transcribe, decoded)
        except HTTPException:
            raise
        except Exception as exc:
            logger.exception("Transcription failed")
            raise HTTPException(
                status_code=500,
                detail=f"Transcription failed: {exc}",
            ) from exc
    return {"text": text}


def _synthesize(text: str) -> bytes:
    if tts_model is None:
        raise RuntimeError("TTS model is not ready")
    audio_list, sample_rate = tts_model.generate_custom_voice(
        text=text,
        speaker=VOICE.lower(),
        language="English",
    )
    if not audio_list or not sample_rate:
        raise RuntimeError("TTS model returned no audio")

    audio = np.asarray(audio_list[0], dtype=np.float32).squeeze()
    if audio.ndim != 1 or audio.size == 0:
        raise RuntimeError("TTS model returned invalid audio")
    if not np.isfinite(audio).all() or not np.any(audio):
        raise RuntimeError("TTS model returned silent or non-finite audio")

    output = io.BytesIO()
    sf.write(output, audio, int(sample_rate), format="WAV", subtype="PCM_16")
    return output.getvalue()


@app.post("/v1/audio/speech")
async def speech(request: SpeechRequest) -> Response:
    try:
        async with tts_lock:
            wav = await asyncio.to_thread(_synthesize, request.input)
    except Exception as exc:
        logger.exception("Speech synthesis failed")
        raise HTTPException(
            status_code=500,
            detail=f"Speech synthesis failed: {exc}",
        ) from exc
    return Response(
        content=wav,
        media_type="audio/wav",
        headers={"Cache-Control": "no-store"},
    )
