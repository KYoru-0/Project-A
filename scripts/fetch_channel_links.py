"""Search and discover canonical YouTube channel links for VTuber entries using Selenium."""

import json
from pathlib import Path
import re
from urllib.parse import quote_plus

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.edge.options import Options
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

DATA_ROOT = Path(__file__).resolve().parent.parent / "dataset"
KB_DIR = DATA_ROOT / "kb"
LOG_DIR = Path(__file__).resolve().parent.parent / "logs"
LOG_DIR.mkdir(exist_ok=True)


def parse_sub_count(s: str) -> int:
    """Parse subscriber counts with K, M, B suffixes into integers."""
    if not s:
        return 0
    s = s.strip().upper().replace(",", "")
    if s.endswith("K"):
        return int(float(s[:-1]) * 1_000)
    elif s.endswith("M"):
        return int(float(s[:-1]) * 1_000_000)
    elif s.endswith("B"):
        return int(float(s[:-1]) * 1_000_000_000)
    else:
        try:
            return int(float(s))
        except ValueError:
            return 0


options = Options()
options.add_argument("--log-level=3")
options.add_experimental_option("excludeSwitches", ["enable-logging"])
driver = webdriver.Edge(options=options)

with open(KB_DIR / "vtubers.json", "r", encoding="utf-8") as f:
    data = json.load(f)

pwc = set()
wrong_channels_log = LOG_DIR / "possibly_wrong_channels.log"
if wrong_channels_log.exists():
    with open(wrong_channels_log, "r", encoding="utf-8") as f:
        pdata = f.read()
    for line in pdata.split("\n"):
        matches = re.search(r"\([0-9]+\)", line)
        if matches:
            pwc.add(matches.group(0).strip("()"))

log_output = ""

try:
    for v in data:
        if v.get("rank") in pwc or any(not c.get("channel_link") for c in v.get("channels", [])):
            for i, channel in enumerate(v.get("channels", [])):
                print(f"\nFinding {channel}")
                query = quote_plus(channel.get("channel_name", ""))
                driver.get(f"https://www.youtube.com/results?search_query={query}&sp=EgIQAg%253D%253D")

                try:
                    WebDriverWait(driver, 10).until(
                        EC.presence_of_element_located((By.TAG_NAME, "ytd-channel-renderer"))
                    )
                    channel_elements = driver.find_elements(By.TAG_NAME, "ytd-channel-renderer")
                except Exception:
                    channel_elements = []

                new_link = (
                    channel_elements[0].find_element(By.CSS_SELECTOR, "a.channel-link#main-link").get_attribute("href")
                    if channel_elements else None
                )

                if new_link:
                    channel["channel_link"] = new_link
                    print("Found")
                    if i == 0:
                        raw_sub_text = channel_elements[0].find_element(By.CSS_SELECTOR, "span#video-count").text.split("subscriber")[0]
                        new_sub = parse_sub_count(raw_sub_text)
                        sub = parse_sub_count(v.get("subscribers", ""))
                        score = abs(sub - new_sub) / (sub + 1)
                        if score > 0.1:
                            log_output += f"High error score at: {channel['channel_name']} ({v['rank']})\n"
                    else:
                        log_output += f"Found link for sub channel: {channel['channel_name']} ({v['rank']})\n"
                else:
                    print("Not found")
                    log_output += f"Channel link not found for: {channel.get('channel_name')}\n"

            with open(KB_DIR / "vtubers_temp.json", "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=4)
finally:
    driver.quit()
    with open(LOG_DIR / "link_fetching_errors.log", "w", encoding="utf-8") as f:
        f.write(log_output)