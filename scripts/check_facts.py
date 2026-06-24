import json
import re
from pathlib import Path

DATA_ROOT = Path("dataset")
KB_DIR = DATA_ROOT / "kb"

TAIL_REGEX = re.compile(r'\@.*&')

with open(KB_DIR / "vtubers.json", 'r', encoding='utf-8') as f:
    data = json.load(f)
with open(KB_DIR / "offices.json", 'r', encoding='utf-8') as f:
    offices = json.load(f)
    
for v in data:
    if not v.get('facts', None):
        print(v['vtuber_id'])
