import os
import json
import re
from pathlib import Path
from difflib import SequenceMatcher
from dotenv import load_dotenv
from googleapiclient.discovery import build

DATA_ROOT = Path("dataset")
KB_DIR = DATA_ROOT / "kb"

HANDLE_REGEX = re.compile(r'@([A-Za-z0-9._-]+)$')
ID_REGEX = re.compile(r'UC[a-zA-Z0-9_-]{22}')

with open(KB_DIR / "vtubers.json", 'r', encoding='utf-8') as f:
    data = json.load(f)
with open(KB_DIR / "offices.json", 'r', encoding='utf-8') as f:
    offices = json.load(f)

load_dotenv()

YOUTUBE_API_KEY = os.getenv("YOUTUBE_API_KEY")
youtube = build(
    "youtube",
    "v3",
    developerKey=YOUTUBE_API_KEY
)

for v in data:
    print(f"Processing {v['vtuber_id']}: {v['vtuber_names']['english_name']}")
    if v['channels']:
        channel = v['channels'][0]
        handle = re.search(HANDLE_REGEX, channel['channel_link'])
        channel_id = re.search(ID_REGEX, channel['channel_link'])
        try:
            if handle:
                response = youtube.channels().list(
                    part="snippet",
                    forHandle=handle.group()[1:]
                ).execute()
            else:
                response = youtube.channels().list(
                    part="snippet",
                    id=channel_id.group()
                ).execute()
            
            if response['items']:
                v['description'] = response['items'][0]['snippet']['description']
        except Exception as e:
            print(f"Error: {e}")
        
        with open(KB_DIR / "vtubers_temp.json", 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=4, ensure_ascii=False)