"""Fetch official YouTube channel descriptions using the YouTube Data API v3."""

import json
import os
from pathlib import Path
import re

from dotenv import load_dotenv
from googleapiclient.discovery import build

DATA_ROOT = Path(__file__).resolve().parent.parent / "dataset"
KB_DIR = DATA_ROOT / "kb"

HANDLE_REGEX = re.compile(r"@([A-Za-z0-9._-]+)$")
ID_REGEX = re.compile(r"UC[a-zA-Z0-9_-]{22}")

load_dotenv()
YOUTUBE_API_KEY = os.getenv("YOUTUBE_API_KEY")
youtube = build("youtube", "v3", developerKey=YOUTUBE_API_KEY)

with open(KB_DIR / "vtubers.json", "r", encoding="utf-8") as f:
    data = json.load(f)

for v in data:
    name = v.get("vtuber_names", {}).get("english_name", v.get("vtuber_name", "Unknown"))
    print(f"Processing ID {v['vtuber_id']}: {name}")

    if v.get("channels"):
        channel = v["channels"][0]
        channel_link = channel.get("channel_link", "")
        handle = re.search(HANDLE_REGEX, channel_link)
        channel_id = re.search(ID_REGEX, channel_link)

        try:
            if handle:
                response = youtube.channels().list(
                    part="snippet",
                    forHandle=handle.group()[1:]
                ).execute()
            elif channel_id:
                response = youtube.channels().list(
                    part="snippet",
                    id=channel_id.group()
                ).execute()
            else:
                response = {"items": []}

            if response.get("items"):
                v["description"] = response["items"][0]["snippet"]["description"]
        except Exception as e:
            print(f"Error fetching snippet for {name}: {e}")

        with open(KB_DIR / "vtubers_temp.json", "w", encoding="utf-8") as f:
            json.dump(data, f, indent=4, ensure_ascii=False)