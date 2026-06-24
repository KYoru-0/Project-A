import json
import re
from pathlib import Path
from difflib import SequenceMatcher
from selenium import webdriver
from selenium.webdriver.edge.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from urllib.parse import quote

INDEP_ID = 28
DATA_ROOT = Path("dataset")
KB_DIR = DATA_ROOT / "kb"

with open(KB_DIR / "vtubers.json", 'r', encoding='utf-8') as f:
    data = json.load(f)
with open(KB_DIR / "offices.json", 'r', encoding='utf-8') as f:
    offices = json.load(f)

seen_names = set()
BRACKET_PATTERN = re.compile(r'[\[【「『〈].*?[\]】」』〉]')

def normalize(s):
    query = BRACKET_PATTERN.sub("", s)
    query = query.replace("Chanel", "").strip()
    query = query.replace("Ch.", "").strip()
    query = query.replace("チャンネル", "").strip()
    return query

for v in data:
    norm_name = normalize(v['vtuber_name'])
    for seen_name in seen_names:
        norm_seen_name = normalize(seen_name)
        if SequenceMatcher(None, norm_name, norm_seen_name).ratio() > 0.8 or any(w in norm_name for w in ['sub', 'SUB', 'さぶ', 'サブ']):
            print(f"{v['vtuber_name']} ({v['rank']}) {seen_name}")
            break
    seen_names.add(v['vtuber_name'])