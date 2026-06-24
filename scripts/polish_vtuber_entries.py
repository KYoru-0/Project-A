import os
import json
import re
from pathlib import Path
from difflib import SequenceMatcher
from dotenv import load_dotenv
from googleapiclient.discovery import build

DATA_ROOT = Path("dataset")
KB_DIR = DATA_ROOT / "kb"

TAIL_REGEX = re.compile(r'\@.*&')

with open(KB_DIR / "vtubers.json", 'r', encoding='utf-8') as f:
    data = json.load(f)
with open(KB_DIR / "offices.json", 'r', encoding='utf-8') as f:
    offices = json.load(f)

for i, v in enumerate(data):
    if i > 500 and i != len(data)-1:
        v['facts'] = []

with open(KB_DIR / "vtubers_temp.json", 'w', encoding='utf-8') as f:
    json.dump(data, f, indent=4, ensure_ascii=False)