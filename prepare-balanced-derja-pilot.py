import argparse
import json
import shutil
from pathlib import Path

from datasets import Dataset
from datasets.arrow_writer import ArrowWriter


def load_split(folder: Path, split: str) -> tuple[Dataset, list[float]]:
    dataset = Dataset.from_file(str(folder / f"{split}.arrow"))
    durations = json.loads((folder / f"{split}-duration.json").read_text(encoding="utf-8"))["duration"]
    if len(dataset) != len(durations):
        raise ValueError(f"{folder.name}/{split}: row and duration counts differ")
    return dataset, durations


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--blasa-replay", type=Path, required=True)
    parser.add_argument("--hyati-replay", type=Path, required=True)
    parser.add_argument("--attribution", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    args.output.mkdir(parents=True, exist_ok=True)
    for split in ("train", "dev"):
        sources = [args.base]
        if split == "train":
            sources.extend((args.blasa_replay, args.hyati_replay))

        datasets = [load_split(source, split) for source in sources]
        total = sum(len(dataset) for dataset, _ in datasets)
        with ArrowWriter(path=str(args.output / f"{split}.arrow"), writer_batch_size=100) as writer:
            for dataset, _ in datasets:
                for example in dataset:
                    writer.write(example)
            if len(writer) != total:
                raise RuntimeError(f"{split}: Arrow count mismatch")
            writer.finalize()

        durations = [duration for _, values in datasets for duration in values]
        (args.output / f"{split}-duration.json").write_text(
            json.dumps({"duration": durations}), encoding="utf-8"
        )
        print(f"{split}: {total} examples, {sum(durations) / 3600:.2f} hours")

    shutil.copy2(args.attribution, args.output / "ATTRIBUTION.txt")


if __name__ == "__main__":
    main()
