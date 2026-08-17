from PIL import Image, ImageDraw, ImageFont
import math, random

def grad(w, h, c1, c2):
    img = Image.new('RGB', (w, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / h
        c = tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))
        d.line([(0, y), (w, y)], fill=c)
    return img

def font(sz):
    for p in ['C:/Windows/Fonts/msyhbd.ttc', 'C:/Windows/Fonts/msyh.ttc']:
        try:
            return ImageFont.truetype(p, sz)
        except Exception:
            pass
    return ImageFont.load_default()

def make(fname, title, c1, c2, deco):
    W, H = 480, 720
    img = grad(W, H, c1, c2)
    d = ImageDraw.Draw(img)
    deco(d, W, H)
    f1, f2 = font(46), font(22)
    y = H - 60 - len(title) * 52
    for ch in title:
        d.text((W - 90, y), ch, font=f1, fill=(255, 255, 255))
        y += 52
    d.text((40, H - 64), 'DUAN JU · SHORT DRAMA', font=f2, fill=(255, 255, 255))
    img.save('posters/' + fname, quality=88)
    print(fname, 'ok')

def deco1(d, W, H):
    random.seed(7)
    x = 0
    while x < W:
        bw = random.randint(40, 80)
        bh = random.randint(120, 300)
        d.rectangle([x, H - 200 - bh, x + bw, H - 200], fill=(60, 30, 110))
        x += bw + random.randint(8, 20)
    d.ellipse([W - 260, 90, W - 160, 190], fill=(255, 120, 170))
    d.polygon([(W - 260, 150), (W - 160, 150), (W - 210, 230)], fill=(255, 120, 170))

def deco2(d, W, H):
    cx, cy = W // 2 - 40, 240
    for i in range(12):
        a = i * math.pi / 6
        d.line([(cx, cy), (cx + 300 * math.cos(a), cy + 300 * math.sin(a))], fill=(220, 200, 255), width=3)
    d.rounded_rectangle([cx - 130, cy - 80, cx + 130, cy + 80], radius=14, fill=(40, 20, 80))
    d.ellipse([cx - 90, cy - 34, cx - 22, cy + 34], fill=(240, 235, 255))
    d.ellipse([cx + 22, cy - 34, cx + 90, cy + 34], fill=(240, 235, 255))
    d.ellipse([cx - 66, cy - 10, cx - 46, cy + 10], fill=(40, 20, 80))
    d.ellipse([cx + 46, cy - 10, cx + 66, cy + 10], fill=(40, 20, 80))

make('15_shan_hun.jpg', '闪婚后她野翻了', (168, 120, 255), (110, 70, 200), deco1)
make('16_hui_dao.jpg', '回到1995当首富', (150, 105, 235), (85, 50, 165), deco2)
