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

with open(KB_DIR / "vtubers_fetched_names.json", 'r', encoding='utf-8') as f:
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
            "english_name": {"type": "STRING"},
            "kanji_name": {
                "type": "STRING", 
                "nullable": True
            },
            "hiragana_name": {
                "type": "STRING", 
                "nullable": True
            }
        },
        "required": ["index", "english_name"]
    }
}

for i in range(0, len(data), 5):
# for i in range(1):
    if data[i].get("vtuber_names", None):
        continue
    chunk = data[i : i + 5]
    sending_data = []
    index = i
    for v in chunk:
        print(f"Processing {v['rank']}: {v['vtuber_name']}")
        appeared_name = v['vtuber_name']
        channel_name = v['channels'][0]['channel_name']
        channel_link = v['channels'][0]['channel_link']
        sending_data.append(
            {
                "index": index,
                "appeared_name": appeared_name,
                "channel_name": channel_name,
                "channel_link": channel_link
            }
        )
        index += 1
        
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
        except:
            time.sleep(5)
    
    response = json.loads(response.text)
    
    for r in response:
        english_name = r.get("english_name", None)
        kanji_name = r.get("kanji_name", None)
        data[r['index']]['vtuber_names'] = {
            "english_name": english_name,
            "kanji_name": kanji_name,
        }
    
    with open(KB_DIR / "vtubers_fetched_names.json", 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=4, ensure_ascii=False)