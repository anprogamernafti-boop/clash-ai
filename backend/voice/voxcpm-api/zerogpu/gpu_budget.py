MAX_TEXT_CHARS = 600


def split_at_pauses(text: str, max_chars: int = 180) -> list[str]:
    remaining = str(text or "").strip()
    if max_chars < 2:
        raise ValueError("max_chars doit être supérieur ou égal à 2")

    parts: list[str] = []
    pauses = ("؟", "!", "؛", "،", ".")
    while len(remaining) > max_chars:
        boundary = max((remaining.rfind(mark, 1, max_chars + 1) + 1 for mark in pauses), default=0)
        if boundary < max_chars // 2:
            boundary = remaining.rfind(" ", 1, max_chars + 1)
        if boundary <= 0:
            boundary = max_chars
        part = remaining[:boundary].strip()
        if part:
            parts.append(part)
        remaining = remaining[boundary:].strip()
    if remaining:
        parts.append(remaining)
    return parts


def gpu_duration_for_text(text: str) -> int:
    normalized_text = str(text or "").strip()
    if len(normalized_text) < 2 or len(normalized_text) > MAX_TEXT_CHARS:
        return 60
    segment_count = len(split_at_pauses(normalized_text))
    return min(150, max(60, 30 + 30 * segment_count))
