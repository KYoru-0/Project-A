"""Verify YouTube channel links against the YouTube Data API v3 and update channel names."""

import json
import os
from pathlib import Path
import re

from dotenv import load_dotenv
from googleapiclient.discovery import build

DATA_ROOT = Path(__file__).resolve().parent.parent / "dataset"
KB_DIR = DATA_ROOT / "kb"
LOG_DIR = Path(__file__).resolve().parent.parent / "logs"
LOG_DIR.mkdir(exist_ok=True)

HANDLE_REGEX = re.compile(r"@([A-Za-z0-9._-]+)$")
ID_REGEX = re.compile(r"UC[a-zA-Z0-9_-]{22}")

load_dotenv()
YOUTUBE_API_KEY = os.getenv("YOUTUBE_API_KEY")
youtube = build("youtube", "v3", developerKey=YOUTUBE_API_KEY)

with open(KB_DIR / "vtubers.json", "r", encoding="utf-8") as f:
    data = json.load(f)

log_output = ""

for v in data:
    name = v.get("vtuber_names", {}).get("english_name", v.get("vtuber_name", "Unknown"))
    print(f"Processing ID {v['vtuber_id']}: {name}")

    for channel in v.get("channels", []):
        link = channel.get("channel_link", "")
        handle = re.search(HANDLE_REGEX, link)
        channel_id = re.search(ID_REGEX, link)

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
                channel["channel_name"] = response["items"][0]["snippet"]["title"]
        except Exception as e:
            err_msg = f"Error fetching channel snippet for {name} ({link}): {e}\n"
            log_output += err_msg
            print(err_msg.strip())

    with open(KB_DIR / "vtubers_temp.json", "w", encoding="utf-8") as f:
        json.dump(data, f, indent=4, ensure_ascii=False)

with open(LOG_DIR / "channel_name_fetching_errors.log", "w", encoding="utf-8") as f:
    f.write(log_output)