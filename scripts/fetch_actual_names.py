"""Fetch canonical English and Kanji names for VTubers using Google Gemini."""

import json
from pathlib import Path
import time

from dotenv import load_dotenv
from google import genai
from google.genai import types

DATA_ROOT = Path(__file__).resolve().parent.parent / "dataset"
KB_DIR = DATA_ROOT / "kb"

load_dotenv()
client = genai.Client()

vtuber_schema = {
    "type": "ARRAY",
    "items": {
        "type": "OBJECT",
        "properties": {
            "index": {"type": "INTEGER"},
            "english_name": {"type": "STRING"},
            "kanji_name": {"type": "STRING", "nullable": True},
            "hiragana_name": {"type": "STRING", "nullable": True},
        },
        "required": ["index", "english_name"],
    },
}

target_file = KB_DIR / "vtubers_fetched_names.json"
if not target_file.exists():
    target_file = KB_DIR / "vtubers.json"

with open(target_file, "r", encoding="utf-8") as f:
    data = json.load(f)

BATCH_SIZE = 5
for i in range(0, len(data), BATCH_SIZE):
    if data[i].get("vtuber_names"):
        continue

    chunk = data[i : i + BATCH_SIZE]
    sending_data = []

    for index, v in enumerate(chunk, start=i):
        print(f"Processing #{v['rank']}: {v['vtuber_name']}")
        appeared_name = v["vtuber_name"]
        channel_name = v["channels"][0]["channel_name"] if v.get("channels") else ""
        channel_link = v["channels"][0]["channel_link"] if v.get("channels") else ""
        sending_data.append({
            "index": index,
            "appeared_name": appeared_name,
            "channel_name": channel_name,
            "channel_link": channel_link,
        })

    prompt = f"""
    You will be given a set of data including:
    - index: index number of the item
    - appeared_name: the VTuber's name that appeared on the website
    - channel_name: the supposedly name of their main channel taken from the website
    Look at the VTuber's name and SEARCH it up, figure out the actual name of the VTuber
    The response must include the NAME only, having gotten rid of the prefixes, trails, company names and such, while keeping all the special characters officially stated
    Your response must be in the form of a JSON for each given item, containing fields as following:
    - index: index number of the corresponding item
    - original_name: the ORIGINAL form of the name
    - english_name: the original English form of the name, this field may be the same as original_name IF and ONLY IF the original_name is already in Latin text,
    otherwise, find the best way to transfer to Latin text, preferably the public original version
    DATA:
    {sending_data}
    """

    while True:
        try:
            response = client.models.generate_content(
                model="gemini-3.1-flash-lite",
                contents=prompt,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=vtuber_schema,
                ),
            )
            break
        except Exception as err:
            print(f"Gemini API rate limit / error: {err}. Retrying in 5s...")
            time.sleep(5)

    response_items = json.loads(response.text)
    for r in response_items:
        data[r["index"]]["vtuber_names"] = {
            "english_name": r.get("english_name"),
            "kanji_name": r.get("kanji_name"),
        }

    with open(KB_DIR / "vtubers_fetched_names.json", "w", encoding="utf-8") as f:
        json.dump(data, f, indent=4, ensure_ascii=False)