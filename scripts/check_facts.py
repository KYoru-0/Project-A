"""Check VTuber entries missing fact fields in the Knowledge Base."""

import json
from pathlib import Path

DATA_ROOT = Path(__file__).resolve().parent.parent / "dataset"
KB_DIR = DATA_ROOT / "kb"

with open(KB_DIR / "vtubers.json", "r", encoding="utf-8") as f:
    data = json.load(f)

for v in data:
    if not v.get("facts"):
        print(f"Missing facts: VTuber ID {v['vtuber_id']} ({v.get('vtuber_name', 'Unknown')})")
