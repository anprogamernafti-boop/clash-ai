import io
import os
import re
import secrets
import threading
from typing import Optional

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from voxcpm import VoxCPM


MODEL_ID = os.getenv("VOXCPM_MODEL_ID", "Code-Quasar/voxcpm-tn")
API_TOKEN = os.getenv("VOXCPM_API_TOKEN", "")
ARABIC_RE = re.compile(r"[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]")
app = FastAPI(title="Clash AI VoxCPM Tunisian TTS", docs_url=None, redoc_url=None)
model: Optional[VoxCPM] = None
generation_lock = threading.Lock()


class SpeechRequest(BaseModel):
    text: str = Field(min_length=2, max_length=600)


@app.on_event("startup")
def load_model() -> None:
    global model
    if len(API_TOKEN) < 32:
        raise RuntimeError("VOXCPM_API_TOKEN must contain at least 32 characters")
    if not torch.cuda.is_available():
        raise RuntimeError("VoxCPM production inference requires a CUDA GPU")
    model = VoxCPM.from_pretrained(MODEL_ID, load_denoiser=False)


@app.get("/health")
def health() -> dict:
    return {"ok": model is not None, "model": MODEL_ID, "cuda": torch.cuda.is_available()}


@app.post("/v1/audio/speech")
def speech(payload: SpeechRequest, authorization: str = Header(default="")) -> Response:
    expected = f"Bearer {API_TOKEN}"
    if not API_TOKEN or not secrets.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="unauthorized")
    if model is None:
        raise HTTPException(status_code=503, detail="model_not_ready")
    text = payload.text.strip()
    if len(text) < 2 or not ARABIC_RE.search(text):
        raise HTTPException(status_code=422, detail="Arabic-script Tunisian Derja is required; French words may keep French spelling")

    try:
        with generation_lock, torch.inference_mode():
            audio = np.asarray(
                model.generate(
                    text=f"(Tunisian Dialect) {text}",
                    cfg_value=2.0,
                    inference_timesteps=20,
                    max_len=min(5000, max(1200, len(text) * 16)),
                    normalize=False,
                    denoise=False,
                    retry_badcase=False,
                ),
                dtype=np.float32,
            ).squeeze()
        if audio.size == 0 or not np.isfinite(audio).all():
            raise ValueError("invalid audio output")
        buffer = io.BytesIO()
        sf.write(buffer, audio, model.tts_model.sample_rate, format="WAV", subtype="PCM_16")
        return Response(content=buffer.getvalue(), media_type="audio/wav", headers={"Cache-Control": "no-store"})
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail="speech_generation_failed") from exc
