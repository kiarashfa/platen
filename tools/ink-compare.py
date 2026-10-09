"""Tile the per-paper crops that dev/ink.html dumps (?dump=1) into one comparison image.

    python tools/ink-compare.py [kind ...]      kinds: letter lines art zoom zoom4 fresh4 ghost paper region
    -> shots/ink-compare-<kind>.png  (papers in a 2 x 3 grid, labelled)

Run `node tools/shoot.mjs "/dev/ink.html?dump=1" --name ink` first.
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / 'shots'
PAPERS = ['ivory', 'bond', 'laid', 'aged', 'onion', 'kraft']


def compare(kind, cols=2, pad=10, label_h=22):
    tiles = []
    for p in PAPERS:
        f = SHOTS / f'ink-{p}-{kind}.png'
        if not f.exists():
            print(f'missing {f.name}')
            return None
        tiles.append((p, Image.open(f).convert('RGB')))
    w = max(t.width for _, t in tiles)
    h = max(t.height for _, t in tiles)
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * (w + pad) + pad, rows * (h + pad + label_h) + pad), (43, 36, 32))
    d = ImageDraw.Draw(sheet)
    for i, (p, t) in enumerate(tiles):
        x = pad + (i % cols) * (w + pad)
        y = pad + (i // cols) * (h + pad + label_h)
        d.text((x, y + 4), p, fill=(216, 201, 168))
        sheet.paste(t, (x, y + label_h))
    out = SHOTS / f'ink-compare-{kind}.png'
    sheet.save(out)
    print(out.relative_to(ROOT), sheet.size)
    return out


if __name__ == '__main__':
    for k in (sys.argv[1:] or ['zoom', 'paper']):
        compare(k)
