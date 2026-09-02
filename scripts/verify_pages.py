"""Validate YouTube channel subscriber counts against recorded rankings to detect discrepancies."""

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

TAIL_REGEX = re.compile(r"@.*&")

load_dotenv()
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY") or os.getenv("YOUTUBE_API_KEY")
youtube = build("youtube", "v3", developerKey=GOOGLE_API_KEY)

with open(KB_DIR / "vtubers.json", "r", encoding="utf-8") as f:
    data = json.load(f)

log_output = ""

for v in data:
    name = v.get("vtuber_names", {}).get("english_name", v.get("vtuber_name", "Unknown"))
    print(f"Processing #{v.get('rank', '?')}: {name}")

    for channel in v.get("channels", []):
        link = channel.get("channel_link", "")
        if TAIL_REGEX.search(link):
            continue

        a, b, c = link.partition("channel/")
        channel_id = c[:24] if len(c) >= 24 else c

        if not channel_id:
            continue

        try:
            response = youtube.channels().list(
                part="statistics",
                id=channel_id
            ).execute()

            if response.get("items"):
                sub_count = int(response["items"][0]["statistics"]["subscriberCount"])
                noted_sub_str = v.get("subscribers", "0").replace(",", "").strip()
                noted_sub_count = int(float(noted_sub_str)) if noted_sub_str else 0

                if abs(sub_count - noted_sub_count) / (noted_sub_count + 1) > 0.1:
                    log_output += f"{channel.get('channel_name', 'Unknown')} (#{v.get('rank')})\n"
                    print(f"Discrepancy noted: {channel.get('channel_name')} (Expected ~{noted_sub_count}, Found {sub_count})")
        except Exception as e:
            log_output += f"{channel.get('channel_name', 'Unknown')} (#{v.get('rank')}) - Error: {e}\n"

with open(LOG_DIR / "possibly_wrong_channels.log", "w", encoding="utf-8") as f:
    f.write(log_output)