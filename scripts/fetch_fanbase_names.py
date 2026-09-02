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
            "fanbase_name": {"type": "STRING"},
        },
        "required": ["index", "fanbase_name"]
    }
}

BATCH_SIZE = 10
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
        if not v.get("fanbase_name")
    ]
    if not sending_data:
        continue
        
    prompt = f"""
    You will be given a set of data including:
    - index: index number of the item
    - english_name: the VTuber's name in English form
    - kanji_name: the original VTuber's name if English name was not in English/Latin
    - channel_link: the link to the channel
    Look at the VTuber's names and SEARCH it up, figure out the fanbase name of the VTuber
    Fanbase name is the name by which the VTuber calls their fanbase
    There is no need to force a name, on every single VTuber, if the informations about it is TOO UNCLEAR, feel free to return null in that field
    While rare, the chance of over half of the vtuber sent to you don't explicitly have a fanbase name still exists
    The returned name must be in singular form, written in their original language, if the name is not originally in English/Latin, add the English version/pronunciation next to it in a parentheses pair
    For example: "星読み (Hoshiyomi)", "リリカルメイト (Lyricalmate)"
    Your response must be in the form of a JSON for each given item, containing fields as following:
    - index: index number of the corresponding item
    - fanbase_name: a list of facts about the VTuber
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
        except Exception as e:
            print(e)
            time.sleep(5)
    
    response = json.loads(response.text)
    
    for r in response:
        fanbase_name = r.get("fanbase_name", None)
        if not fanbase_name:
            print(f"Fanbase name not found: {data[r['index']]['vtuber_names']['english_name']}")
        data[r['index']]['fanbase_name'] = fanbase_name if fanbase_name else None
    
    with open(KB_DIR / "vtubers_fetched_fanbase_name.json", 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=4, ensure_ascii=False)