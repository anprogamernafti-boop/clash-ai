import argparse
import json
from pathlib import Path

from datasets import Dataset
from datasets.arrow_writer import ArrowWriter


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prepared-data", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--target", default="بْلَاصَة")
    parser.add_argument("--copies", type=int, default=4)
    args = parser.parse_args()
    if args.copies < 1:
        raise ValueError("--copies must be at least 1")

    dataset = Dataset.from_file(str(args.prepared_data / "train.arrow"))
    durations = json.loads((args.prepared_data / "train-duration.json").read_text(encoding="utf-8"))["duration"]
    selected = []
    for example, duration in zip(dataset, durations, strict=True):
        text = "".join(example["text"])
        if args.target in text:
            selected.append({**example, "duration": duration})
    if not selected:
        raise ValueError(f"No marked target examples found for {args.target!r}")

    args.output.mkdir(parents=True, exist_ok=True)
    repeated = selected * args.copies
    with ArrowWriter(path=str(args.output / "train.arrow"), writer_batch_size=100) as writer:
        for example in repeated:
            writer.write(example)
        if len(writer) != len(repeated):
            raise RuntimeError("Arrow count mismatch")
        writer.finalize()
    (args.output / "train-duration.json").write_text(
        json.dumps({"duration": [example["duration"] for example in repeated]}), encoding="utf-8"
    )
    print(f"Unique utterances: {len(selected)}; replay copies: {args.copies}; training rows: {len(repeated)}")


if __name__ == "__main__":
    main()
