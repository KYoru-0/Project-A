import os
import json
import re
import time
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.edge.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from urllib.parse import quote_plus
import msvcrt

def parse_sub_count(s):
    if not s:
        return 0
    
    s = s.strip().upper().replace(',', '')

    if s.endswith('K'):
        return int(float(s[:-1]) * 1_000)
    elif s.endswith('M'):
        return int(float(s[:-1]) * 1_000_000)
    elif s.endswith('B'):
        return int(float(s[:-1]) * 1_000_000_000)
    else:
        return int(s)
    
DATA_ROOT = Path("dataset")
KB_DIR = DATA_ROOT / "kb"
LOG_DIR = Path("logs")

options = Options()
options.add_argument("--log-level=3")
options.add_experimental_option("excludeSwitches", ["enable-logging"])
driver = webdriver.Edge(options=options)

with open(KB_DIR / "vtubers.json", 'r', encoding='utf-8') as f:
    data = json.load(f)

with open(LOG_DIR / "possibly_wrong_channels.log", 'r', encoding='utf-8') as f:
    pdata = f.read()
pwc = set()
for line in pdata.split('\n'):
    matches = re.search(r'\([0-9]+\)', line)
    if matches:
        pwc.add(matches.group(0).strip('()'))
print(pwc)

log = ""

for v in data:
    if v['rank'] in pwc or any(not c['channel_link'] for c in v['channels']):
        for i, channel in enumerate(v['channels']):
            print(f"\nFinding {channel}")
            query = quote_plus(channel['channel_name'])
            driver.get(f"https://www.youtube.com/results?search_query={query}&sp=EgIQAg%253D%253D")
            
            try:
                WebDriverWait(driver, 10).until(
                    EC.presence_of_element_located((By.TAG_NAME, "ytd-channel-renderer"))
                )
                
                channel_elements = driver.find_elements(
                    By.TAG_NAME,
                    "ytd-channel-renderer"
                )
            except:
                channel_elements = []
                
            new_link = channel_elements[0].find_element(
                By.CSS_SELECTOR,
                "a.channel-link#main-link"
            ).get_attribute('href') if channel_elements else None
            
            if new_link:
                channel['channel_link'] = new_link
                print("Found")
                if i == 0:
                    new_sub = parse_sub_count(channel_elements[0].find_element(
                        By.CSS_SELECTOR,
                        "span#video-count"
                    ).text.split("subscriber")[0])
                    
                    sub = parse_sub_count(v['subscribers'])
                    
                    score = abs(sub - new_sub) / (sub + 1)
                    if score > 0.1:
                        log += f"High error score at: {channel['channel_name']} ({v['rank']})\n"
                    print(score)
                else:
                    log += f"Found link for sub channel: {channel['channel_name']} ({v['rank']})\n"
                    print("sub")
            else:
                print("Not found")
                log += f"Channel link not found for: {channel['channel_name']}\n"

        print(v['channels'])
        
        with open(KB_DIR / "vtubers_temp.json", 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=4)

with open(Path("logs") / "link_fetching_errors.log", 'w', encoding='utf-8') as f:
    f.write(log)