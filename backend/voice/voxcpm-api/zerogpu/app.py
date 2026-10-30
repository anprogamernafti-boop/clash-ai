import os
import re
import tempfile
import threading

os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")

import gradio as gr
import numpy as np
import soundfile as sf
import spaces
from voxcpm import VoxCPM
from gpu_budget import MAX_TEXT_CHARS, gpu_duration_for_text, split_at_pauses


MODEL_ID = "Code-Quasar/voxcpm-tn"
REFERENCE_WAV = os.path.join(os.path.dirname(__file__), "voice-reference.wav")
ARABIC_RE = re.compile(r"[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]")
generation_lock = threading.Lock()
model = VoxCPM.from_pretrained(MODEL_ID, load_denoiser=False)


def prepare_audio(audio: np.ndarray, sample_rate: int, text_length: int) -> np.ndarray:
    audio = np.asarray(audio, dtype=np.float32).squeeze()
    if audio.ndim != 1 or audio.size == 0 or not np.isfinite(audio).all():
        raise ValueError("sortie vide ou non finie")
    duration = audio.size / sample_rate
    if duration < 0.3 or duration > 90:
        raise ValueError("durée audio anormale")
    peak = float(np.max(np.abs(audio)))
    rms = float(np.sqrt(np.mean(np.square(audio, dtype=np.float64))))
    if peak < 0.02 or rms < 0.002:
        raise ValueError("sortie presque silencieuse")
    if float(np.mean(np.abs(audio) >= 0.999)) > 0.005:
        raise ValueError("saturation détectée")

    active = np.flatnonzero(np.abs(audio) >= max(0.002, peak * 0.025))
    if active.size == 0:
        raise ValueError("aucune zone parlée détectée")
    padding = int(sample_rate * 0.04)
    start = max(0, int(active[0]) - padding)
    end = min(audio.size, int(active[-1]) + padding + 1)
    audio = audio[start:end].copy()

    peak = float(np.max(np.abs(audio)))
    rms = float(np.sqrt(np.mean(np.square(audio, dtype=np.float64))))
    gain = min(10 ** (-18 / 20) / max(rms, 1e-8), 0.94 / max(peak, 1e-8), 8.0)
    audio *= gain
    if float(np.mean(np.abs(audio) >= 0.999)) > 0.001:
        raise ValueError("saturation détectée")
    minimum_duration = min(8.0, max(0.3, text_length * 0.012))
    if audio.size / sample_rate < minimum_duration:
        raise ValueError("sortie possiblement tronquée")
    return audio


@spaces.GPU(duration=gpu_duration_for_text)
def synthesize(text: str) -> str:
    text = str(text or "").strip()
    if len(text) < 2 or len(text) > MAX_TEXT_CHARS:
        raise gr.Error(f"Le texte doit contenir entre 2 et {MAX_TEXT_CHARS} caractères.")
    if not ARABIC_RE.search(text):
        raise gr.Error("Colle la derja en lettres arabes vocalisées ; garde les mots français en orthographe française.")

    try:
        with generation_lock:
            segments = []
            for part in split_at_pauses(text):
                segment = np.asarray(
                    model.generate(
                        text=f"(Tunisian Dialect) {part}",
                        reference_wav_path=REFERENCE_WAV,
                        cfg_value=2.0,
                        inference_timesteps=20,
                        max_len=min(5000, max(1200, len(part) * 16)),
                        normalize=False,
                        denoise=False,
                        retry_badcase=False,
                    ),
                    dtype=np.float32,
                ).squeeze()
                if segment.ndim != 1 or segment.size == 0 or not np.isfinite(segment).all():
                    raise ValueError("segment audio invalide")
                segments.append(segment)
            pause = np.zeros(int(model.tts_model.sample_rate * 0.12), dtype=np.float32)
            audio = np.concatenate([chunk for index, segment in enumerate(segments)
                                    for chunk in ((pause, segment) if index else (segment,))])
        audio = prepare_audio(audio, int(model.tts_model.sample_rate), len(text))

        output = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        output.close()
        sf.write(output.name, audio, model.tts_model.sample_rate, subtype="PCM_16")
        return output.name
    except gr.Error:
        raise
    except Exception as exc:
        raise gr.Error(f"La synthèse a échoué : {type(exc).__name__}") from exc


with gr.Blocks(title="Clash AI — VoxCPM Derja beta") as demo:
    gr.Markdown(
        """
        # VoxCPM · voix Derja beta

        Prototype public de synthèse tunisienne. Colle la derja en **lettres arabes vocalisées** ; garde les mots français en orthographe française ;
        l’audio est généré à la demande. La qualité et la disponibilité ne sont pas garanties.
        Cette démo ne reçoit ni photo ni clash automatiquement depuis Clash AI.
        """
    )
    text = gr.Textbox(
        label="Texte derja vocalisé + mots français",
        lines=4,
        max_lines=8,
        max_length=600,
        placeholder="كِيفْ … photo d’identité …",
    )
    generate = gr.Button("Générer la voix", variant="primary")
    audio = gr.Audio(label="Résultat VoxCPM", type="filepath")
    generate.click(synthesize, inputs=text, outputs=audio, api_name="synthesize", concurrency_limit=1)

demo.queue(default_concurrency_limit=1, max_size=8, api_open=False)
demo.launch()
