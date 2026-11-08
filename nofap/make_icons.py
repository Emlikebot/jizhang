"""生成应用图标：python3 make_icons.py"""
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")
os.makedirs(OUT, exist_ok=True)


def icon(size, pad_ratio=0.0):
    S = size * 4  # supersample
    img = Image.new("RGB", (S, S), (15, 17, 21))
    d = ImageDraw.Draw(img)
    # 背景渐变
    for y in range(S):
        t = y / S
        c = (int(16 + 10 * t), int(22 + 8 * t), int(28 + 6 * t))
        d.line([(0, y), (S, y)], fill=c)
    inset = S * (0.18 + pad_ratio)
    w = S * 0.075
    box = [inset, inset, S - inset, S - inset]
    # 背景环
    d.arc(box, 0, 360, fill=(40, 46, 58), width=int(w))
    # 进度环
    d.arc(box, -90, 200, fill=(52, 211, 153), width=int(w))
    # 对勾
    cx, cy, r = S / 2, S / 2, (S - 2 * inset) / 2
    pts = [(cx - r * 0.42, cy + r * 0.02), (cx - r * 0.1, cy + r * 0.34), (cx + r * 0.45, cy - r * 0.3)]
    d.line(pts, fill=(238, 240, 244), width=int(w * 1.05), joint="curve")
    for p in (pts[0], pts[2]):
        rr = w * 0.52
        d.ellipse([p[0] - rr, p[1] - rr, p[0] + rr, p[1] + rr], fill=(238, 240, 244))
    return img.resize((size, size), Image.LANCZOS)


icon(180).save(os.path.join(OUT, "apple-touch-icon.png"))
icon(192).save(os.path.join(OUT, "icon-192.png"))
icon(512).save(os.path.join(OUT, "icon-512.png"))
icon(512, pad_ratio=0.08).save(os.path.join(OUT, "icon-512-maskable.png"))
print("icons written to", OUT)
