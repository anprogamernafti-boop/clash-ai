import argparse
import csv
import json
import re
import wave
from collections import Counter
from pathlib import Path

from datasets.arrow_writer import ArrowWriter


WORD_MAP = {
    "أهو": "أَهُو",
    "الآخر": "الآخِر",
    "الأخر": "الآخِر",
    "اليوم": "اليُوم",
    "اللي": "اللِّي",
    "الليلة": "اللِّيلَة",
    "باش": "بَاشْ",
    "بش": "بَاشْ",
    "بلاصة": "بْلَاصَة",
    "البلاصة": "الْبْلَاصَة",
    "لبلاصة": "لْبْلَاصَة",
    "للبلاصة": "لِلْبْلَاصَة",
    "عالبلاصة": "عَلْبْلَاصَة",
    "بالبلاصة": "بِالْبْلَاصَة",
    "برشا": "بَرْشَا",
    "بارشا": "بَرْشَا",
    "باهي": "بَاهِي",
    "تسخنه": "تْسَخَّنُه",
    "تنجم": "تَنْجَمْ",
    "تنجّم": "تَنْجَمْ",
    "توا": "تَوَّة",
    "توة": "تَوَّة",
    "حياتي": "حْيْاتِي",
    "خاطر": "خَاطِرْ",
    "خاطرش": "خَاطِرْش",
    "شنوة": "شْنُوَّة",
    "شوية": "شْوَيَّة",
    "علاش": "عْلَاشْ",
    "عباد": "عْبَادْ",
    "على": "عْلَى",
    "عندي": "عَنْدِي",
    "عنا": "عَنَّا",
    "فما": "فَمَّا",
    "في": "فِي",
    "فيسع": "فِيسَعْ",
    "قداش": "قَدَّاشْ",
    "كل": "كُلّ",
    "معقول": "مَعْقُولْ",
    "موش": "مُوشْ",
    "مش": "مُوشْ",
    "نحب": "نْحِبّ",
    "نهار": "نْهَارْ",
    "نبدل": "نْبَدِّلْ",
    "نبدّل": "نْبَدِّلْ",
    "نكمل": "نْكَمِّلْ",
    "نقول": "نْقُولْ",
    "نقلك": "نْقُلِّك",
    "نرقد": "نِرْقُدْ",
    "هكا": "هَكَا",
    "هوني": "هُونِي",
    "وين": "وِينْ",
    "ياخي": "يَاخِي",
    "زوز": "زُوزْ",
    "يعيشك": "يْعَايْشِكْ",
    "متاع": "مْتَاعْ",
    "الناس": "النَّاسْ",
    "الكل": "الكُلّ",
    "هاذي": "هَاذِي",
    "كيفاش": "كِيفَاشْ",
    "إنت": "إِنْتِي",
    "انتي": "إِنْتِي",
    "انا": "أَنَا",
    "أنا": "أَنَا",
    "اما": "أَمَّا",
    "أما": "أَمَّا",
    "كان": "كَانْ",
    "ولا": "وَلَّا",
    "تحب": "تْحِبّ",
    "نمشي": "نِمْشِي",
    "ناخذ": "نَاخُذْ",
    "ديما": "دِيمَا",
    "ياسر": "يَاسِرْ",
    "منين": "مِنِينْ",
    "نشوف": "نْشُوفْ",
    "خويا": "خُويَا",
    "لازمني": "لَازِمْنِي",
    "بربي": "بَرْبِي",
    "مشيت": "مْشِيتْ",
    "شكون": "شْكُونْ",
}

ARABIC_WORD = re.compile(r"[\u0600-\u06ff\u0750-\u077f]+")
SHORT_VOWELS = str.maketrans("", "", "\u064b\u064c\u064d\u064e\u064f\u0650")
PRESERVED_FORMS = {"رْبِحْ", "رَدْهُم"}
TARGET_WORDS = {"ربح": "رْبِحْ", "ردهم": "رَدْهُم"}


def mark_dialect(text: str) -> str:
    def convert(match: re.Match[str]) -> str:
        word = match.group()
        if word in PRESERVED_FORMS:
            return word
        if word in TARGET_WORDS:
            return TARGET_WORDS[word]
        return WORD_MAP.get(word, word).translate(SHORT_VOWELS)

    return ARABIC_WORD.sub(convert, text)


def convert_split(
    source_dir: Path,
    output_dir: Path,
    vocab: set[str],
    split: str,
    repeat_contains: str,
    extra_copies: int,
) -> tuple[int, int, Counter[str]]:
    metadata_path = source_dir / "metadata.csv"
    examples = []
    rows = []
    mapped_words: Counter[str] = Counter()
    characters: set[str] = set()

    with metadata_path.open(encoding="utf-8-sig", newline="") as source:
        for row in csv.DictReader(source, delimiter="|"):
            original = row["text"].strip()
            converted = mark_dialect(original)
            audio_path = (source_dir / row["audio_file"]).resolve()
            with wave.open(str(audio_path), "rb") as audio:
                duration = audio.getnframes() / audio.getframerate()
            if not 0.3 <= duration <= 30:
                continue
            for word in ARABIC_WORD.findall(original):
                if word in WORD_MAP:
                    mapped_words[word] += 1
            characters.update(converted)
            example = {"audio_path": str(audio_path), "text": list(converted), "duration": duration}
            repeats = extra_copies if split == "train" and repeat_contains and repeat_contains in original else 0
            examples.extend([example] * (1 + repeats))
            rows.extend((row["audio_file"], original, converted) for _ in range(1 + repeats))

    unsupported = sorted(characters - vocab)
    if unsupported:
        raise ValueError(f"Characters absent from tokenizer: {unsupported!r}")

    output_dir.mkdir(parents=True, exist_ok=True)
    with ArrowWriter(path=str(output_dir / f"{split}.arrow"), writer_batch_size=100) as writer:
        for example in examples:
            writer.write(example)
        if len(writer) != len(examples):
            raise RuntimeError(f"{split}: Arrow count mismatch")
        writer.finalize()

    (output_dir / f"{split}-duration.json").write_text(
        json.dumps({"duration": [example["duration"] for example in examples]}), encoding="utf-8"
    )
    with (output_dir / f"{split}-review.csv").open("w", encoding="utf-8", newline="") as output:
        writer = csv.writer(output, lineterminator="\n")
        writer.writerow(("audio_file", "source_text", "diacritized_text"))
        writer.writerows(rows)
    return len(examples), len(characters), mapped_words


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--vocab", type=Path, required=True)
    parser.add_argument("--repeat-contains", default="")
    parser.add_argument("--extra-copies", type=int, default=0)
    args = parser.parse_args()
    if args.extra_copies < 0:
        raise ValueError("--extra-copies must be non-negative")

    vocab = set(args.vocab.read_text(encoding="utf-8").splitlines())
    total_mapped: Counter[str] = Counter()
    for split in ("train", "dev"):
        source_dir = args.source / f"{split}_input"
        count, character_count, mapped_words = convert_split(
            source_dir, args.output, vocab, split, args.repeat_contains, args.extra_copies
        )
        total_mapped.update(mapped_words)
        print(f"{split}: {count} recordings, {character_count} characters, {sum(mapped_words.values())} lexical annotations")
    print("Most annotated tokens:")
    for word, count in total_mapped.most_common(30):
        print(f"{word}: {WORD_MAP[word]} ({count})")


if __name__ == "__main__":
    main()
