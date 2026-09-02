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

load_dotenv()

GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
youtube = build(
    "youtube",
    "v3",
    developerKey=GOOGLE_API_KEY
)

log = ""
for v in data:
    print(f"Processing {v['rank']}: {v['vtuber_name']}")
    for channel in v['channels']:
        if TAIL_REGEX.search(channel['channel_link']):
            continue
        a, b, c = channel['channel_link'].partition("channel/")
        if len(c) > 24:
            channel['channel_link'] = a + b + c[:24]
        
        try:
            response = youtube.channels().list(
                part="statistics",
                id=c[:24]
            ).execute()
            
            sub_count = int(response['items'][0]['statistics']['subscriberCount'])
            noted_sub_count = int(v['subscribers'].replace(',', ''))
            
            if abs(sub_count - noted_sub_count) / (noted_sub_count + 1) > 0.1:
                log += f"{channel['channel_name']} ({v['rank']})\n"
                print("Noted")
        except:
            log += f"{channel['channel_name']} ({v['rank']})\n"
            print("Noted")
        
with open(Path("logs") / "possibly_wrong_channels.log", 'w', encoding='utf-8') as f:
    f.write(log)