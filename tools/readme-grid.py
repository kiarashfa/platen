# python tools/readme-grid.py out.jpg tile1.png ... tile10.png
# 5 x 2 grid of colour renders with the enamel name under each, on the app's dark walnut tone.
import sys
from PIL import Image, ImageDraw, ImageFont

NAMES = ['Hunter Green', 'Oxblood', 'Admiralty Navy', 'Ivory Cream', 'Camel',
         'Tobacco', 'Sage', 'Slate Blue', 'Claret', 'Ebony']
out, files = sys.argv[1], sys.argv[2:]
TW, TH, LAB, GAP = 480, 300, 44, 10
cols, rows = 5, 2
W = cols * TW + (cols + 1) * GAP
H = rows * (TH + LAB) + (rows + 1) * GAP
img = Image.new('RGB', (W, H), (26, 18, 12))
d = ImageDraw.Draw(img)
try:
    font = ImageFont.truetype('C:/Windows/Fonts/georgiai.ttf', 22)
except OSError:
    font = ImageFont.load_default()
for i, f in enumerate(files):
    t = Image.open(f).convert('RGB')
    # crop the centre to the tile aspect, then shrink
    w, h = t.size
    cw, ch = w, int(w * TH / TW)
    if ch > h:
        ch, cw = h, int(h * TW / TH)
    x0, y0 = (w - cw) // 2, (h - ch) // 2 + int(h * 0.04)
    y0 = max(0, min(h - ch, y0))
    t = t.crop((x0, y0, x0 + cw, y0 + ch)).resize((TW, TH), Image.LANCZOS)
    cx, cy = GAP + (i % cols) * (TW + GAP), GAP + (i // cols) * (TH + LAB + GAP)
    img.paste(t, (cx, cy))
    name = NAMES[i] if i < len(NAMES) else ''
    tw = d.textlength(name, font=font)
    d.text((cx + (TW - tw) / 2, cy + TH + 9), name, fill=(239, 228, 200), font=font)
img.save(out, quality=86, optimize=True, progressive=True)
print(out, img.size)
