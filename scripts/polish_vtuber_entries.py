"""Normalize and clean attributes across VTuber Knowledge Base entries."""

import json
from pathlib import Path

DATA_ROOT = Path(__file__).resolve().parent.parent / "dataset"
KB_DIR = DATA_ROOT / "kb"

with open(KB_DIR / "vtubers.json", "r", encoding="utf-8") as f:
    data = json.load(f)

for v in data:
    v.pop("fanbase_name", None)

with open(KB_DIR / "vtubers_temp.json", "w", encoding="utf-8") as f:
    json.dump(data, f, indent=4, ensure_ascii=False)

print(f"Polished {len(data)} VTuber records into vtubers_temp.json")