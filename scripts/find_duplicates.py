"""Identify potential duplicate VTuber entries in the Knowledge Base dataset."""

from difflib import SequenceMatcher
import json
from pathlib import Path
import re

DATA_ROOT = Path(__file__).resolve().parent.parent / "dataset"
KB_DIR = DATA_ROOT / "kb"

BRACKET_PATTERN = re.compile(r"[\[【「『〈].*?[\]】」』〉]")


def normalize(s: str) -> str:
    """Normalize channel and VTuber names by stripping bracket tags and channel suffixes."""
    query = BRACKET_PATTERN.sub("", s)
    query = query.replace("Chanel", "").strip()
    query = query.replace("Ch.", "").strip()
    query = query.replace("チャンネル", "").strip()
    return query


with open(KB_DIR / "vtubers.json", "r", encoding="utf-8") as f:
    data = json.load(f)

seen_names = set()

for v in data:
    name = v.get("vtuber_name", "")
    norm_name = normalize(name)

    for seen_name in seen_names:
        norm_seen_name = normalize(seen_name)
        similarity = SequenceMatcher(None, norm_name, norm_seen_name).ratio()
        is_sub = any(w in norm_name for w in ["sub", "SUB", "さぶ", "サブ"])

        if similarity > 0.8 or is_sub:
            print(f"Possible Duplicate: {name} (#{v.get('rank', '?')}) <=> {seen_name}")
            break

    seen_names.add(name)