#!/usr/bin/env python3
"""Draws the LiveBrowser mark and packs host/app.ico.

Run from the repository root with a Python that has Pillow:

    python -I build-logo/draw.py

Why a script and not a checked-in .ico alone: the .ico is a binary, so nobody
can review a change to it and nobody can tell seven frames apart in a diff.
This file is the source; logo/logo.svg is the same geometry written out for
hand-editing, and host/app.ico is the build product that ships.

The mark is a disc, and inside it three shapes:

  - an open ring, white, with round caps: the "on air" ring, and a C-shape that
    reads as a browser tab curling back on itself;
  - a solid core in the middle: the signal that is live right now;
  - a cyan spark on the ring's gap: the only saturated colour in the icon, so
    the eye lands on the one place that is moving.

Two earlier marks were tried and dropped.  An L made of the address bar and the
tab rail read as the Cyrillic capital "Г".  A rounded tile with a window pane
and a dot was correct but had no silhouette: at 16 px it was a square blob, and
a square blob cannot be told apart from any other app's square blob on a dark
taskbar.  A disc always reads as a disc, whatever the size.

Colours are the shell's --accent (#5e6ad2) plus a lighter top step and a cyan
that is already in the UI, so the icon cannot drift away from the shell.

Small frames are drawn differently on purpose.  At 16 and 24 px a 20-unit ring
closes up into a donut with a hole, so the ring is drawn wider and the core
bigger; everything from 48 up keeps the lighter proportions.

Every frame is written as an uncompressed 32-bpp DIB with an AND mask.  PNG
frames inside an .ico look smaller on disk, but some readers (System.Drawing
among them) refuse the large PNG frames and fall back to the 32 px one, which
leaves the taskbar and Alt+Tab showing a blurry icon.
"""
import math
import os
import struct
import sys

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "logo")
ICO = os.path.join(ROOT, "host", "app.ico")

ACCENT = (0x5E, 0x6A, 0xD2)      # shell/app.css --accent
ACCENT_TOP = (0x8A, 0x94, 0xF0)  # lit upper-left of the disc
ACCENT_DEEP = (0x40, 0x4A, 0xB4) # shaded rim
CYAN = (0x2E, 0xD3, 0xC0)        # the spark, sits on the ring's gap
WHITE = (255, 255, 255)
RIM = (0x8C, 0x95, 0xEE)         # 1 px hairline, separates the disc from a dark bar

SIZES = (16, 24, 32, 48, 64, 128, 256)
SS = 8  # supersampling: the design space is 256x256, so everything is *SS


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def disc_gradient(n):
    """Radial gradient, lit from the centre so the ring sits in a soft well."""
    img = Image.new("RGB", (n, n))
    px = img.load()
    c = n / 2.0
    radius = 118 * n / 256.0
    for y in range(n):
        for x in range(n):
            t = min(1.0, math.hypot(x + 0.5 - c, y + 0.5 - c) / radius)
            px[x, y] = lerp(ACCENT_TOP, ACCENT_DEEP, t ** 0.85)
    return img


def ring_arc(n, radius, width, colour, start, end):
    """An arc with round caps; PIL's own arc leaves square ends."""
    layer = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    c = n / 2.0
    r, w = radius, width
    d.arc([c - r, c - r, c + r, c + r], start=start, end=end, fill=colour + (255,),
          width=int(round(w)))
    for ang in (start, end):
        a = math.radians(ang)
        px, py = c + r * math.cos(a), c + r * math.sin(a)
        d.ellipse([px - w / 2, py - w / 2, px + w / 2, py + w / 2], fill=colour + (255,))
    return layer


def draw_frame(size):
    small = size <= 32
    n = size * SS
    k = n / 256.0
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))

    # Disc, with a hairline rim.  Without the rim the disc disappears into the
    # dark taskbar on the right-hand side, where the gradient is darkest.
    rim = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    ImageDraw.Draw(rim).ellipse([2 * k, 2 * k, n - 1 - 2 * k, n - 1 - 2 * k], fill=RIM + (255,))
    img.alpha_composite(rim)
    mask = Image.new("L", (n, n), 0)
    ImageDraw.Draw(mask).ellipse([4 * k, 4 * k, n - 1 - 4 * k, n - 1 - 4 * k], fill=255)
    disc = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    disc.paste(disc_gradient(n), (0, 0), mask)
    img.alpha_composite(disc)

    # Soft inner glow behind the ring, so the mark has depth at large sizes and
    # simply reads as a slightly lighter centre at small ones.
    glow = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    gr = 96 * k
    ImageDraw.Draw(glow).ellipse([n / 2 - gr, n / 2 - gr, n / 2 + gr, n / 2 + gr],
                                 fill=ACCENT + (70,))
    img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(max(1.0, 14 * k))))

    # The open ring.  At small sizes it is thicker: a thin ring closes into a
    # donut once the core is in the middle.
    radius = (66 if small else 62) * k
    width = (26 if small else 20) * k
    img.alpha_composite(ring_arc(n, radius, width, WHITE, start=-42, end=292))

    # The spark, sitting in the gap at roughly 2 o'clock.
    sr = (17 if small else 13) * k
    sx = n / 2 + (84 if small else 80) * k
    sy = n / 2 - (30 if small else 34) * k
    spark = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    ImageDraw.Draw(spark).ellipse([sx - sr, sy - sr, sx + sr, sy + sr], fill=CYAN + (255,))
    img.alpha_composite(spark)

    # The core.
    cr = (26 if small else 23) * k
    c = n / 2
    core = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    ImageDraw.Draw(core).ellipse([c - cr, c - cr, c + cr, c + cr], fill=WHITE + (255,))
    img.alpha_composite(core)

    return img.resize((size, size), Image.LANCZOS)


def dib(im):
    """A 32-bpp bottom-up DIB with its AND mask, which is what an .ico frame is."""
    im = im.convert("RGBA")
    w, h = im.size
    px = im.load()
    color_rows = bytearray()
    for y in range(h - 1, -1, -1):
        for x in range(w):
            r, g, b, a = px[x, y]
            color_rows += bytes((b, g, r, a))
    mask_rows = bytearray()
    for y in range(h - 1, -1, -1):
        bits = bytearray((w + 31) // 32 * 4)
        for x in range(w):
            if px[x, y][3] == 0:
                bits[x >> 3] |= 0x80 >> (x & 7)
        mask_rows += bits
    header = struct.pack("<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    return header + bytes(color_rows) + bytes(mask_rows)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    frames = []
    for size in SIZES:
        im = draw_frame(size)
        im.save(os.path.join(OUT_DIR, "logo-%d.png" % size))
        frames.append((size, dib(im)))

    out = bytearray(struct.pack("<HHH", 0, 1, len(frames)))
    offset = 6 + 16 * len(frames)
    entries, data = bytearray(), bytearray()
    for size, blob in frames:
        edge = 0 if size >= 256 else size  # 256 is stored as 0 in the header
        entries += struct.pack("<BBBBHHII", edge, edge, 0, 0, 1, 32, len(blob), offset + len(data))
        data += blob
    with open(ICO, "wb") as f:
        f.write(bytes(out + entries + data))
    print("wrote %s (%d frames, %d bytes)" % (ICO, len(frames), len(out + entries + data)))


if __name__ == "__main__":
    sys.exit(main())
