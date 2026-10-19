import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
files = ["tab_luck.gif", "tab_calendar.gif", "tab_records.gif"]

for f in files:
    p = os.path.join(ASSETS, f)
    if not os.path.exists(p):
        print("skip (not found):", p)
        continue
    im = Image.open(p)
    im.seek(0)            # 取第一帧（静态图标）
    im = im.convert("RGBA")
    im = im.resize((81, 81), Image.LANCZOS)
    out = os.path.join(ASSETS, f[:-4] + ".png")
    im.save(out)
    print("saved", out, im.size)
