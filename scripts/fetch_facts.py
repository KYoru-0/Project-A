import os
import json
import time
import re
from pathlib import Path
from difflib import SequenceMatcher
from dotenv import load_dotenv
from google import genai
from google.genai import types

DATA_ROOT = Path("dataset")
KB_DIR = DATA_ROOT / "kb"

TAIL_REGEX = re.compile(r'\@.*&')

with open(KB_DIR / "vtubers.json", 'r', encoding='utf-8') as f:
    data = json.load(f)
with open(KB_DIR / "offices.json", 'r', encoding='utf-8') as f:
    offices = json.load(f)

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
                "items": {
                    "type": "STRING"
                }
            }
        },
        "required": ["index", "facts"]
    }
}

BATCH_SIZE = 3
for i in range(0, len(data), BATCH_SIZE):
# for i in range(1):
    print(f"Processing chunk {i // BATCH_SIZE + 1} ({i} - {i + BATCH_SIZE - 1})")
    sending_data = [
        {
            "index": idx,
            "english_name": v['vtuber_names']['english_name'],
            "kanji_name": v['vtuber_names']['kanji_name'],
            "channel_link": v['channels'][0]['channel_link'] if v['channels'] else None
        }
        for idx, v in enumerate(data[i:i+BATCH_SIZE], start=i)
        if not v.get("facts")
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
        except:
            time.sleep(5)
    
    response = json.loads(response.text)
    
    for r in response:
        facts = r.get("facts", None)
        data[r['index']]['facts'] = facts
        if not facts:
            print(f"Facts not found: {data[r['index']]['vtuber_names']['english_name']}")
    
    with open(KB_DIR / "vtubers_fetched_facts.json", 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=4, ensure_ascii=False)