"""Generate curated VTuber facts and lore using Google Gemini."""

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
            "facts": {
                "type": "ARRAY",
                "items": {"type": "STRING"}
            }
        },
        "required": ["index", "facts"]
    }
}

target_file = KB_DIR / "vtubers.json"
with open(target_file, "r", encoding="utf-8") as f:
    data = json.load(f)

BATCH_SIZE = 3
for i in range(0, len(data), BATCH_SIZE):
    chunk_indices = list(range(i, min(i + BATCH_SIZE, len(data))))
    print(f"Processing chunk {i // BATCH_SIZE + 1} ({i} - {i + len(chunk_indices) - 1})")

    sending_data = [
        {
            "index": idx,
            "english_name": data[idx].get("vtuber_names", {}).get("english_name", ""),
            "kanji_name": data[idx].get("vtuber_names", {}).get("kanji_name", ""),
            "channel_link": data[idx]["channels"][0]["channel_link"] if data[idx].get("channels") else None
        }
        for idx in chunk_indices
        if not data[idx].get("facts")
    ]

    if not sending_data:
        continue

    prompt = f"""
    You will be given a set of data including:
    - index: index number of the item
    - english_name: the VTuber's name in English form
    - kanji_name: the original VTuber's name if English name was not in English/Latin
    - channel_link: the link to the channel
    Look at the VTuber's names and SEARCH it up, figure out at most 4 facts about the VTuber
    The first fact should be a quick overview of the VTuber, and MUST be correct
    Look at the VTuber's corporate history if exists, debut date,... and put it at the second fact if confidently available, informations of this type MUST NOT be outdated
    For example, if a VTuber has recently come back after a hiatus, or joined a corporate but terminated/graduated recently, started but then channel got banned recently, it should be noticed
    The third fact and onwards should be extra facts about the VTuber from the community, funny facts, or significant events related to them
    The facts shouldn't include quantity attributes like subscriber count, view count, ... or information about their fanbase name
    These extra facts should prioritize content-related, and funny ones if available
    There is no need to force all 4 facts, if the information is unclear, SKIP after the first one
    The first fact MUST be integrous, if the VTuber is TOO INSIGNIFICANT and informations about them are TOO UNCLEAR, feel free to even skip the first fact and return nothing. This case is rare, yet might happen.
    There is no need to retain from explicitly mention controversial aspects if REALLY necessary
    Find the nation of said VTuber
    Your response must be in the form of a JSON for each given item, containing fields as following:
    - index: index number of the corresponding item
    - facts: a list of facts about the VTuber
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
        facts = r.get("facts")
        data[r["index"]]["facts"] = facts
        if not facts:
            print(f"Facts not found: {data[r['index']].get('vtuber_names', {}).get('english_name', 'Unknown')}")

    with open(KB_DIR / "vtubers_fetched_facts.json", "w", encoding="utf-8") as f:
        json.dump(data, f, indent=4, ensure_ascii=False)