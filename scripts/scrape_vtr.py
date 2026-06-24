import json
from pathlib import Path
import time
from selenium import webdriver
from selenium.webdriver.edge.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
import msvcrt

def wait_with_interrupt(seconds, interrupt_char="#"):
    print(f"Waiting for {seconds}s. Press '{interrupt_char}' to skip wait and continue...")
    start_time = time.time()
    while time.time() - start_time < seconds:
        if msvcrt.kbhit():
            char = msvcrt.getch().decode('utf-8')
            if char == interrupt_char:
                print("\nInterrupt received. Continuing...")
                return True
        time.sleep(0.1)
    return False

RANKING_SITE = "https://virtual-youtuber.userlocal.jp/document/ranking"

DATA_ROOT = Path("dataset")
KB_DIR = DATA_ROOT / "kb"

KB_DIR.mkdir(exist_ok=True)

options = Options()
# options.add_argument("--headless")
driver = webdriver.Edge(options=options)

# with open(KB_DIR / "vtubers.json", 'r', encoding='utf-8') as vf:
#     vtuber_list = json.load(vf)
vtuber_list = []
vtuber_id = 1
# with open(KB_DIR / "offices.json", 'w', encoding='utf-8') as of:
#     office_list = json.load(of)
office_list = []
seen_offices = set()
office_id = 1

for i in range(40):
    page = f"{RANKING_SITE}?page={i + 1}"
    driver.get(page)

    WebDriverWait(driver, 10).until(
        EC.presence_of_element_located((By.TAG_NAME, "body"))
    )
    
    table = driver.find_element(
        By.CSS_SELECTOR,
        "table.table-ranking-yt"
    )
    
    rows = table.find_elements(
        By.TAG_NAME,
        "tr"
    )
    print(len(rows))
    
    for row in rows:
        info_col = row.find_element(
            By.CSS_SELECTOR,
            "td.col-name"
        )
        stat_col = row.find_element(
            By.CSS_SELECTOR,
            "td.vertical"
        )
        
        rank_elements = info_col.find_elements(By.CSS_SELECTOR, "strong")
        name_elements = info_col.find_elements(By.TAG_NAME, "a")
        channel_name_elements = info_col.find_elements(By.CSS_SELECTOR, "span.text-secondary")
        box_office_elements = info_col.find_elements(By.CSS_SELECTOR, "div.box-office")
        subscribers_elements = stat_col.find_elements(By.CSS_SELECTOR, "span.text-success")
        views_elements = stat_col.find_elements(By.CSS_SELECTOR, "span.text-danger")

        rank = rank_elements[0].text.split('位')[0]
        vtuber_name = name_elements[0].text if name_elements else None
        channel_name = channel_name_elements[0].text if channel_name_elements else None
        if box_office_elements:
            office_elements = box_office_elements[0].find_elements(
                By.CSS_SELECTOR,
                'a[href^="/office"]'
            )
            office_name = office_elements[0].text
        else:
            office_name = None
        subscribers = subscribers_elements[0].text.split()[0] if subscribers_elements else None
        views = views_elements[0].text.split()[0] if views_elements else None
        
        if office_name:
            if not office_name in seen_offices:
                office_list.append(
                    {
                        "office_id": office_id,
                        "office_name": office_name
                    }
                )
                seen_offices.add(office_name)
                current_office_id = office_id
                office_id += 1
            else:
                current_office_id = next(
                    o for o in office_list if o['office_name'] == office_name
                )['office_id']
        else:
            current_office_id = None
            
        vtuber_list.append(
            {
                "vtuber_id": vtuber_id,
                "rank": rank,
                "vtuber_name": vtuber_name,
                "channels": [channel_name],
                "office_id": current_office_id,
                "subscribers": subscribers,
                "views": views,
            }
        )
        print(f"Noted #{rank} entry (id={vtuber_id})")
        vtuber_id += 1
    
    with open(KB_DIR / "vtubers.json", 'w', encoding='utf-8') as vf:
        json.dump(vtuber_list, vf, indent=4, ensure_ascii=False)

    with open(KB_DIR / "offices.json", 'w', encoding='utf-8') as of:
        json.dump(office_list, of, indent=4, ensure_ascii=False)
    
    time.sleep(3)