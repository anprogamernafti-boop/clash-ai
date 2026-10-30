import os
import runpy
import sys
import tempfile
import json
from pathlib import Path

numba_cache = Path(tempfile.gettempdir()) / "clash-numba-cache"
numba_cache.mkdir(parents=True, exist_ok=True)
os.environ["NUMBA_CACHE_DIR"] = str(numba_cache)

import soundfile
import torch
import torchaudio
from torch.utils.data import DataLoader, Subset
from f5_tts.model.trainer import Trainer

recorded_dataset_path = os.environ.get("TUNISIA_TTS_DATASET_PATH")
recorded_checkpoint_path = os.environ.get("TUNISIA_TTS_CHECKPOINT_PATH")
recorded_output_path = os.environ.get("TUNISIA_TTS_OUTPUT_PATH")
if recorded_dataset_path:
    from datasets import Dataset
    import f5_tts.model.dataset as dataset_module
    from f5_tts.model.dataset import CustomDataset

    def load_recorded_dataset(dataset_name, tokenizer, **kwargs):
        dataset_root = Path(recorded_dataset_path)
        source_dataset = Dataset.from_file(str(dataset_root / "raw.arrow"))
        durations = json.loads((dataset_root / "duration.json").read_text(encoding="utf-8"))["duration"]
        return CustomDataset(source_dataset, durations=durations, **kwargs.get("mel_spec_kwargs", {}))

    dataset_module.load_dataset = load_recorded_dataset

if recorded_output_path:
    import importlib.resources

    original_resources_files = importlib.resources.files

    class WorkspaceCheckpointResource:
        def joinpath(self, *parts):
            if len(parts) == 1 and str(parts[0]).startswith("../../ckpts/"):
                return Path(recorded_output_path)
            return original_resources_files("f5_tts").joinpath(*parts)

    def workspace_resources_files(package):
        if package == "f5_tts":
            return WorkspaceCheckpointResource()
        return original_resources_files(package)

    importlib.resources.files = workspace_resources_files
    original_trainer_init = Trainer.__init__

    def trainer_init_with_workspace_checkpoint(self, *args, **kwargs):
        kwargs["checkpoint_path"] = recorded_output_path
        original_trainer_init(self, *args, **kwargs)

    Trainer.__init__ = trainer_init_with_workspace_checkpoint


def load_wave(uri, *args, **kwargs):
    samples, sample_rate = soundfile.read(str(uri), dtype="float32", always_2d=True)
    return torch.from_numpy(samples.T.copy()), sample_rate


def train_without_workers(self, train_dataset, num_workers=0, resumable_with_seed=None):
    if os.environ.get("TUNISIA_TTS_SMOKE") == "1":
        train_dataset = Subset(train_dataset, [0, 1])
        print(f"Smoke dataset: {len(train_dataset)} examples", flush=True)
    print(
        f"F5 trainer: epochs={self.epochs}, batch_type={self.batch_size_type}, "
        f"batch_size={self.batch_size_per_gpu}, samples={len(train_dataset)}",
        flush=True,
    )
    result = original_train(self, train_dataset, num_workers=0, resumable_with_seed=resumable_with_seed)
    print("F5 trainer finished", flush=True)
    return result


def skip_checkpoint(self, *args, **kwargs):
    return None


def save_ema_checkpoint(self, update, last=False):
    if not self.is_main or not last:
        return
    output_path = Path(self.checkpoint_path) / "pretrained_model.pt"
    model = self.accelerator.unwrap_model(self.model)
    torch.save(
        {
            "ema_model_state_dict": self.ema_model.state_dict(),
            "model_state_dict": model.state_dict(),
            "update": update,
        },
        output_path,
    )
    print(f"Saved final EMA and online checkpoints at update {update}: {output_path}", flush=True)


def load_checkpoint_with_fresh_ema(self):
    update = original_load_checkpoint(self)
    if os.environ.get("TUNISIA_TTS_RESET_EMA") == "1":
        self.ema_model.step.zero_()
        self.ema_model.initted.fill_(False)
        print("Reset EMA age after loading pretrained weights", flush=True)
    return update


def init_dataloader_without_persistence(self, *args, **kwargs):
    if kwargs.get("num_workers", 0) == 0:
        kwargs["persistent_workers"] = False
    return original_dataloader_init(self, *args, **kwargs)


torchaudio.load = load_wave
original_train = Trainer.train
original_load_checkpoint = Trainer.load_checkpoint
original_dataloader_init = DataLoader.__init__
Trainer.train = train_without_workers
DataLoader.__init__ = init_dataloader_without_persistence
if os.environ.get("TUNISIA_TTS_RESET_EMA") == "1":
    Trainer.load_checkpoint = load_checkpoint_with_fresh_ema
if os.environ.get("TUNISIA_TTS_SMOKE") == "1":
    Trainer.save_checkpoint = skip_checkpoint
elif os.environ.get("TUNISIA_TTS_SAVE_EMA_ONLY") == "1":
    Trainer.save_checkpoint = save_ema_checkpoint


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: run-tunisia-silma-finetune.py FINETUNE_SCRIPT [TRAINING_ARGS ...]")
    target = Path(sys.argv[1]).resolve()
    sys.argv = [str(target), *sys.argv[2:]]
    runpy.run_path(str(target), run_name="__main__")


if __name__ == "__main__":
    main()
