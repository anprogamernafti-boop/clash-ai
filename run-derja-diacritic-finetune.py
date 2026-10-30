import importlib.resources
import json
import os
import runpy
import shutil
import sys
from pathlib import Path

numba_cache = Path(__file__).resolve().parent / "tunisia-tts-checkpoint-800" / "numba-cache"
numba_cache.mkdir(parents=True, exist_ok=True)
os.environ["NUMBA_CACHE_DIR"] = str(numba_cache)

import numpy as np
import soundfile
import torch
import torchaudio
from datasets import Dataset as ArrowDataset
from torch.utils.data import DataLoader, Subset

from f5_tts.model import dataset as dataset_module
from f5_tts.model.dataset import CustomDataset
from f5_tts.model.trainer import Trainer


def load_wave(path, *args, **kwargs):
    samples, sample_rate = soundfile.read(str(path), dtype="float32", always_2d=True)
    return torch.from_numpy(np.ascontiguousarray(samples.T)), sample_rate


torchaudio.load = load_wave
pilot_root = Path(os.environ["TUNISIA_TTS_PILOT_DATA"]).resolve()


def load_pilot_dataset(dataset_name, tokenizer="char", mel_spec_kwargs=None, **kwargs):
    dataset = ArrowDataset.from_file(str(pilot_root / "train.arrow"))
    duration_file = pilot_root / "train-duration.json"
    durations = json.loads(duration_file.read_text(encoding="utf-8"))["duration"]
    if os.environ.get("TUNISIA_TTS_SMOKE") == "1":
        dataset = Subset(dataset, range(min(4, len(dataset))))
        durations = durations[: len(dataset)]
    return CustomDataset(dataset, durations=durations, **(mel_spec_kwargs or {}))


dataset_module.load_dataset = load_pilot_dataset
original_dataloader_init = DataLoader.__init__


def dataloader_without_persistence(self, *args, **kwargs):
    if kwargs.get("num_workers", 0) == 0:
        kwargs["persistent_workers"] = False
    return original_dataloader_init(self, *args, **kwargs)


DataLoader.__init__ = dataloader_without_persistence
original_train = Trainer.train


def train_without_workers(self, train_dataset, num_workers=0, resumable_with_seed=None):
    print(f"Diacritic pilot: epochs={self.epochs}, samples={len(train_dataset)}, workers=0", flush=True)
    return original_train(self, train_dataset, num_workers=0, resumable_with_seed=resumable_with_seed)


Trainer.train = train_without_workers
if os.environ.get("TUNISIA_TTS_SMOKE") == "1":
    Trainer.save_checkpoint = lambda *args, **kwargs: None


class RoutedResources:
    def __init__(self, package, resources):
        self.package = package
        self.resources = resources

    def joinpath(self, *parts):
        if self.package == "f5_tts" and parts and str(parts[0]).replace("\\", "/").startswith("../../ckpts/"):
            return Path(os.environ["TUNISIA_TTS_PILOT_CHECKPOINT"]).resolve()
        return self.resources.joinpath(*parts)


original_files = importlib.resources.files


def files_with_workspace_checkpoint(package):
    return RoutedResources(package, original_files(package))


importlib.resources.files = files_with_workspace_checkpoint
checkpoint_dir = Path(os.environ["TUNISIA_TTS_PILOT_CHECKPOINT"]).resolve()
checkpoint_dir.mkdir(parents=True, exist_ok=True)
pretrain = Path(os.environ["TUNISIA_TTS_PRETRAIN"]).resolve()
pretrained_link = checkpoint_dir / f"pretrained_{pretrain.name}"
if not pretrained_link.exists():
    shutil.copy2(pretrain, pretrained_link)

if len(sys.argv) < 2:
    raise SystemExit("usage: run-derja-diacritic-finetune.py FINETUNE_SCRIPT [ARGS ...]")

target = Path(sys.argv[1]).resolve()
sys.argv = [str(target), *sys.argv[2:]]
runpy.run_path(str(target), run_name="__main__")
