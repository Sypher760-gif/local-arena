"""Draw the Stop Local Arena icon (no Pillow needed) into app/assets/arena-stop.ico.

The Local Arena icon itself is the project's artwork: docs/brand/arena-icon-source.png, cropped into
app/assets/arena.ico, arena-icon.png and arena-icon-64.png. Do not redraw it here.

  python tools/make_icons.py
"""
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "app", "assets")
SS = 3  # supersampling for smooth edges


def rrect(x, y, x0, y0, x1, y1, r):
    if not (x0 <= x <= x1 and y0 <= y <= y1):
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def draw(size, shapes):
    """shapes: list of (fn(x, y) -> bool, (r, g, b)) in 0..1 coordinates, painted in order."""
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(SS):
                for sx in range(SS):
                    x = (px + (sx + 0.5) / SS) / size
                    y = (py + (sy + 0.5) / SS) / size
                    col = None
                    for fn, rgb in shapes:
                        if fn(x, y):
                            col = rgb
                    if col:
                        acc[0] += col[0]; acc[1] += col[1]; acc[2] += col[2]; acc[3] += 1
            n = SS * SS
            a = acc[3]
            if a:
                row += bytes((round(acc[0] / a), round(acc[1] / a), round(acc[2] / a), round(255 * a / n)))
            else:
                row += b"\0\0\0\0"
        rows.append(bytes(row))
    return rows


def png(size, rows):
    raw = b"".join(b"\0" + r for r in rows)
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def ico(path, shapes, sizes=(16, 24, 32, 48, 64, 128, 256)):
    images = [(s, png(s, draw(s, shapes))) for s in sizes]
    head = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries, blobs = b"", b""
    for s, data in images:
        entries += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(data), offset + len(blobs))
        blobs += data
    with open(path, "wb") as fh:
        fh.write(head + entries + blobs)


WHITE = (255, 255, 255)
BASE = lambda x, y: rrect(x, y, 0.04, 0.04, 0.96, 0.96, 0.22)

# Local Arena: deep blue square, three white bars rising left to right (a score chart) on a bench line.
bench = [
    (BASE, (28, 78, 216)),
    (lambda x, y: rrect(x, y, 0.20, 0.55, 0.34, 0.74, 0.03), WHITE),
    (lambda x, y: rrect(x, y, 0.43, 0.40, 0.57, 0.74, 0.03), WHITE),
    (lambda x, y: rrect(x, y, 0.66, 0.24, 0.80, 0.74, 0.03), WHITE),
    (lambda x, y: rrect(x, y, 0.16, 0.78, 0.84, 0.84, 0.03), (150, 190, 255)),
]
# Stop Local Arena: red square with a white stop square.
stop = [
    (BASE, (200, 40, 40)),
    (lambda x, y: rrect(x, y, 0.30, 0.30, 0.70, 0.70, 0.06), WHITE),
]

os.makedirs(OUT, exist_ok=True)
ico(os.path.join(OUT, "arena-stop.ico"), stop)
print("wrote", os.path.join(OUT, "arena-stop.ico"))
