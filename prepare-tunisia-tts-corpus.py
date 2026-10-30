import argparse
import csv
import json
import shutil
import subprocess
import wave
from pathlib import Path

from datasets.arrow_writer import ArrowWriter
from imageio_ffmpeg import get_ffmpeg_exe


def resolve_audio(corpus_root: Path, reference: str) -> Path:
    name = Path(reference).name
    relative = Path(reference.replace("\\", "/"))
    candidates = (corpus_root / relative, corpus_root / name, corpus_root / name.replace(":", "_"))
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(f"Audio file is missing for {reference!r}")


def prepare_split(
    corpus_root: Path,
    output_root: Path,
    split: str,
    vocab: set[str],
    ffmpeg: str,
) -> tuple[list[dict[str, object]], set[str]]:
    source_csv = corpus_root / f"{split}.csv"
    split_root = output_root / f"{split}_input"
    wavs_root = split_root / "wavs"
    wavs_root.mkdir(parents=True, exist_ok=True)
    characters: set[str] = set()
    examples: list[dict[str, object]] = []
    metadata_rows: list[tuple[str, str]] = []

    with source_csv.open(encoding="utf-8-sig", newline="") as source:
        for row in csv.DictReader(source):
            text = row["wrd"].strip()
            if not text:
                continue
            source_audio = resolve_audio(corpus_root, row["wav"])
            target_audio = wavs_root / f"{source_audio.stem}.wav"
            is_wave = False
            if target_audio.exists():
                with target_audio.open("rb") as existing:
                    is_wave = existing.read(4) == b"RIFF"
            if not is_wave:
                subprocess.run(
                    [
                        ffmpeg,
                        "-nostdin",
                        "-hide_banner",
                        "-loglevel",
                        "error",
                        "-y",
                        "-i",
                        str(source_audio),
                        "-vn",
                        "-ac",
                        "1",
                        "-ar",
                        "24000",
                        "-c:a",
                        "pcm_s16le",
                        str(target_audio),
                    ],
                    check=True,
                    timeout=120,
                )
            with wave.open(str(target_audio), "rb") as audio:
                duration = audio.getnframes() / audio.getframerate()
            if not 0.3 <= duration <= 30:
                continue
            characters.update(text)
            metadata_rows.append((f"wavs/{target_audio.name}", text))
            examples.append({"audio_path": str(target_audio.resolve()), "text": list(text), "duration": duration})

    metadata_path = split_root / "metadata.csv"
    with metadata_path.open("w", encoding="utf-8", newline="") as metadata:
        writer = csv.writer(metadata, delimiter="|", lineterminator="\n")
        writer.writerow(("audio_file", "text"))
        writer.writerows(metadata_rows)

    unsupported = sorted(characters - vocab)
    if unsupported:
        display = " ".join(repr(character) for character in unsupported[:40])
        raise ValueError(f"{split}: transcript characters absent from SILMA vocab: {display}")

    return examples, characters


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--vocab", type=Path, required=True)
    parser.add_argument("--prepared-data", type=Path, required=True)
    args = parser.parse_args()

    vocab = set(args.vocab.read_text(encoding="utf-8").splitlines())
    ffmpeg = get_ffmpeg_exe()
    args.output.mkdir(parents=True, exist_ok=True)
    for split in ("train", "dev"):
        examples, characters = prepare_split(args.corpus, args.output, split, vocab, ffmpeg)
        print(f"{split}: {len(examples)} utterances; {len(characters)} transcript characters")
        if split == "train":
            args.prepared_data.mkdir(parents=True, exist_ok=True)
            with ArrowWriter(path=str(args.prepared_data / "raw.arrow"), writer_batch_size=100) as writer:
                for example in examples:
                    writer.write(example)
                if len(writer) != len(examples):
                    raise RuntimeError("Arrow writer count does not match the training examples")
                writer.finalize()
            (args.prepared_data / "duration.json").write_text(
                json.dumps({"duration": [example["duration"] for example in examples]}), encoding="utf-8"
            )
            shutil.copy2(args.vocab, args.prepared_data / "vocab.txt")

    attribution = (
        "TunSwitchTO corpus, Zenodo record 8370566, DOI: 10.5281/zenodo.8370566.\n"
        "Licensed under Creative Commons Attribution 4.0 International (CC BY 4.0).\n"
        "Source: https://zenodo.org/records/8370566\n"
        "License: https://creativecommons.org/licenses/by/4.0/\n"
        "Retain the record's author citation when redistributing derived data or models.\n"
    )
    (args.output / "ATTRIBUTION.txt").write_text(attribution, encoding="utf-8")


if __name__ == "__main__":
    main()
