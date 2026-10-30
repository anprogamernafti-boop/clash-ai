import runpy
import os
import random
import re
import sys
import tempfile
from pathlib import Path

numba_cache = Path(__file__).resolve().parent / "tunisia-tts-checkpoint-800" / "numba-cache"
numba_cache.mkdir(parents=True, exist_ok=True)
os.environ["NUMBA_CACHE_DIR"] = str(numba_cache)

import numpy as np
import soundfile as sf
import torch
import torchaudio
import f5_tts.infer.utils_infer as utils_infer
from f5_tts.model.cfm import CFM


def tokenize_recorded_characters(texts, polyphone=True):
    return [list(text) for text in texts]


utils_infer.convert_char_to_pinyin = tokenize_recorded_characters

seed = int(os.environ.get("F5_SEED", "0"))
random.seed(seed)
np.random.seed(seed)
torch.manual_seed(seed)
if torch.cuda.is_available():
    torch.cuda.manual_seed_all(seed)

original_soundfile_write = sf.write


def write_with_peak_guard(file, data, samplerate, *args, **kwargs):
    audio = np.asarray(data)
    peak_limit = float(os.environ.get("F5_OUTPUT_PEAK", "0.92"))
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    if peak > peak_limit:
        audio = audio * (peak_limit / peak)
    if isinstance(file, (str, os.PathLike)):
        path = Path(file)
        safe_stem = re.sub(r'[<>:"/\\|?*]', "_", path.stem)[:100]
        file = path.with_name(safe_stem + path.suffix)
    return original_soundfile_write(file, audio, samplerate, *args, **kwargs)


sf.write = write_with_peak_guard


def load_with_soundfile(path, *args, **kwargs):
    audio, sample_rate = sf.read(path, dtype="float32", always_2d=True)
    return torch.from_numpy(np.ascontiguousarray(audio.T)), sample_rate


torchaudio.load = load_with_soundfile
original_load_checkpoint = utils_infer.load_checkpoint


def load_checkpoint_with_native_dtype(model, checkpoint_path, device, dtype=None, use_ema=True):
    use_ema = use_ema and os.environ.get("F5_USE_EMA", "1") != "0"
    if dtype is None and os.environ.get("F5_FORCE_FLOAT32") == "1":
        dtype = torch.float32
    return original_load_checkpoint(model, checkpoint_path, device, dtype=dtype, use_ema=use_ema)


utils_infer.load_checkpoint = load_checkpoint_with_native_dtype
original_infer_batch_process = utils_infer.infer_batch_process


def infer_batch_process_with_signal_report(*args, **kwargs):
    for wave, sample_rate, spectrogram in original_infer_batch_process(*args, **kwargs):
        if wave is not None:
            if not np.isfinite(wave).all():
                raise RuntimeError("Le moteur a produit un signal audio non fini; aucun WAV exploitable ne peut être exporté.")
            print(
                f"Generated signal: min={np.min(wave):.6f}, "
                f"max={np.max(wave):.6f}, std={np.std(wave):.6f}",
                flush=True,
            )
        yield wave, sample_rate, spectrogram


utils_infer.infer_batch_process = infer_batch_process_with_signal_report
original_sample = CFM.sample


def sample_with_signal_report(self, *args, **kwargs):
    kwargs.setdefault("no_ref_audio", os.environ.get("F5_NO_REF_AUDIO", "1") != "0")
    output, trajectory = original_sample(self, *args, **kwargs)
    if not torch.isfinite(output).all():
        raise RuntimeError("Le modèle a produit un spectrogramme non fini; vérifiez le dtype FP32 et le checkpoint.")
    print(
        f"Generated mel: shape={tuple(output.shape)}, "
        f"min={output.min().item():.6f}, max={output.max().item():.6f}",
        flush=True,
    )
    return output, trajectory


CFM.sample = sample_with_signal_report
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name="__main__")
