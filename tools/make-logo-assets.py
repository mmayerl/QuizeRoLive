#!/usr/bin/env python3
"""
Regenerate the logo assets used by QuizeRo from one source file.

    pip install Pillow
    python tools/make-logo-assets.py path/to/official-logo.png

Produces, next to each other in assets/:

    logo.png        the full lockup (mark + wordmark), trimmed, transparent
    logo-mark.png   the ampersand mark on its own, trimmed, transparent
    icon-192.png    mark centred on white, square - favicon / home screen
    icon-512.png    the same at 512 px

The source must be a transparent PNG of the horizontal lockup: mark on the
left, wordmark on the right, with a clear gap between them. The mark/wordmark
split is found by looking for that gap, so nothing is hard-coded to one
particular file.

The artwork itself is never recoloured or redrawn - only cropped and scaled.
The script also prints the two dominant colours, which are the brand navy and
slate; if they ever differ from --navy / --slate in css/style.css (and the
COLOR table in js/map.js), update those to match.
"""

import sys
import os
from collections import Counter

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is required:  pip install Pillow")

MIN_GAP = 15        # px of empty columns that count as the mark/wordmark gutter
ALPHA_INK = 20      # above this alpha a pixel counts as artwork
ICON_PAD = 0.12     # padding around the mark inside the square icons

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(os.path.dirname(HERE), "assets")


def ink_bbox(px, box):
    """Tight bounding box of non-transparent pixels inside `box`."""
    x0, y0, x1, y1 = box
    xs, ys = [], []
    for y in range(y0, y1):
        for x in range(x0, x1):
            if px[x, y][3] > ALPHA_INK:
                xs.append(x)
                ys.append(y)
    if not xs:
        sys.exit("no artwork found - is the source transparent?")
    return (min(xs), min(ys), max(xs) + 1, max(ys) + 1)


def find_gutter(px, w, h):
    """Widest empty vertical band, i.e. the gap between mark and wordmark."""
    empty = [
        all(px[x, y][3] <= ALPHA_INK for y in range(0, h, 2))
        for x in range(w)
    ]
    runs, start = [], None
    for x, is_empty in enumerate(empty):
        if is_empty and start is None:
            start = x
        elif not is_empty and start is not None:
            if x - start > MIN_GAP:
                runs.append((start, x))
            start = None
    # Ignore any run touching the edges - that is just margin, not the gutter.
    runs = [r for r in runs if r[0] > 0 and r[1] < w]
    if not runs:
        sys.exit("could not find the gap between mark and wordmark; "
                 "crop assets/logo-mark.png by hand instead")
    return max(runs, key=lambda r: r[1] - r[0])


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    src_path = sys.argv[1]

    src = Image.open(src_path).convert("RGBA")
    w, h = src.size
    px = src.load()
    print(f"source: {src_path}  {w}x{h}")

    gutter = find_gutter(px, w, h)
    print(f"mark / wordmark gutter at x={gutter[0]}..{gutter[1]}")

    os.makedirs(ASSETS, exist_ok=True)

    full = src.crop(ink_bbox(px, (0, 0, w, h)))
    full.save(os.path.join(ASSETS, "logo.png"), optimize=True)
    print(f"  assets/logo.png       {full.size[0]}x{full.size[1]}")

    mark = src.crop(ink_bbox(px, (0, 0, gutter[0], h)))
    mark.save(os.path.join(ASSETS, "logo-mark.png"), optimize=True)
    print(f"  assets/logo-mark.png  {mark.size[0]}x{mark.size[1]}")

    for size in (192, 512):
        canvas = Image.new("RGBA", (size, size), (255, 255, 255, 255))
        avail = size - 2 * int(size * ICON_PAD)
        scale = min(avail / mark.size[0], avail / mark.size[1])
        nw, nh = int(mark.size[0] * scale), int(mark.size[1] * scale)
        small = mark.resize((nw, nh), Image.LANCZOS)
        canvas.paste(small, ((size - nw) // 2, (size - nh) // 2), small)
        out = os.path.join(ASSETS, f"icon-{size}.png")
        canvas.convert("RGB").save(out, optimize=True)
        print(f"  assets/icon-{size}.png  {size}x{size}")

    counts = Counter()
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            r, g, b, a = px[x, y]
            if a > 200:
                counts[(r, g, b)] += 1
    print("\ndominant colours - these should match --navy / --slate in "
          "css/style.css and COLOR in js/map.js:")
    for (r, g, b), n in counts.most_common(2):
        print(f"  #{r:02X}{g:02X}{b:02X}  ({n} sampled pixels)")


if __name__ == "__main__":
    main()
