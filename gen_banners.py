# -*- coding: utf-8 -*-
"""生成 3 张 1440x600 横版 Banner 高清大图（与竖版海报同主题的扁平插画场景）"""
from PIL import Image, ImageDraw
import random, os

W, H = 1440, 600
os.makedirs('posters', exist_ok=True)

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def vgrad(c1, c2):
    img = Image.new('RGB', (W, H))
    px = img.load()
    for y in range(H):
        c = lerp(c1, c2, y / (H - 1))
        for x in range(W):
            px[x, y] = c
    return img

# ---------- 深海回响：潜艇 + 光柱 + 气泡 + 声波纹 ----------
def shen_hai():
    img = vgrad((16, 58, 104), (3, 10, 30)).convert('RGBA')
    dark = (4, 14, 30)
    # 顶部光柱
    for bx, bw, alpha in ((300, 150, 30), (760, 200, 26), (1180, 130, 30)):
        beam = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        ImageDraw.Draw(beam).polygon([(bx, 0), (bx + bw, 0), (bx + bw + 160, H), (bx - 60, H)],
                                     fill=(120, 220, 255, alpha))
        img.alpha_composite(beam)
    d = ImageDraw.Draw(img)
    # 潜艇（中右）
    cx, cy = 880, 330
    d.ellipse([cx - 210, cy - 60, cx + 210, cy + 60], fill=dark)            # 艇身
    d.rectangle([cx - 60, cy - 120, cx + 40, cy - 56], fill=dark)           # 指挥塔
    d.rectangle([cx - 20, cy - 146, cx - 4, cy - 118], fill=dark)           # 潜望镜
    d.polygon([(cx + 205, cy - 34), (cx + 285, cy - 70), (cx + 285, cy + 70), (cx + 205, cy + 34)], fill=dark)  # 尾舵
    d.polygon([(cx - 205, cy - 20), (cx - 268, cy - 52), (cx - 268, cy + 52), (cx - 205, cy + 20)], fill=dark)  # 首舵
    for i in range(6):                                                       # 舷窗
        wx = cx - 150 + i * 56
        d.ellipse([wx, cy - 14, wx + 24, cy + 10], fill=(96, 214, 255, 220))
    # 气泡
    random.seed('bw')
    for _ in range(26):
        x, y = random.randint(40, W - 40), random.randint(40, 400)
        r = random.randint(4, 16)
        d.ellipse([x - r, y - r, x + r, y + r], outline=(150, 225, 255, 130), width=2)
    # 声波纹
    for i in range(4):
        r = 90 + i * 70
        d.arc([cx - r, cy - r, cx + r, cy + r], 300, 240, fill=(96, 214, 255, 110 - i * 22), width=3)
    return img

# ---------- 长安霓裳录：唐宫重檐 + 圆月 + 暖窗 ----------
def chang_an():
    img = vgrad((196, 108, 100), (88, 40, 56)).convert('RGBA')
    dark = (46, 20, 34)
    accent = (250, 208, 137, 255)
    d = ImageDraw.Draw(img)
    d.ellipse([150, 70, 310, 230], fill=accent)                              # 圆月
    d.ellipse([144, 64, 316, 236], outline=(255, 240, 210, 100), width=5)
    base = 400
    # 主殿（右侧）
    d.rectangle([720, base, 1400, base + 90], fill=dark)
    d.polygon([(670, base), (1060, base - 130), (W, base)], fill=dark)       # 上檐
    d.polygon([(790, base - 130), (1060, base - 220), (1330, base - 130)], fill=dark)  # 重檐
    d.rectangle([1052, base - 250, 1068, base - 220], fill=dark)             # 脊
    for wx in range(760, 1360, 72):                                          # 暖窗
        d.rectangle([wx, base + 26, wx + 34, base + 66], fill=(250, 208, 137, 190))
    # 副殿（左下）
    d.rectangle([120, base + 40, 560, base + 120], fill=dark)
    d.polygon([(80, base + 40), (340, base - 40), (600, base + 40)], fill=dark)
    for wx in range(160, 520, 60):
        d.rectangle([wx, base + 62, wx + 26, base + 96], fill=(250, 208, 137, 170))
    d.rectangle([0, base + 90, W, H], fill=dark)                             # 地面
    # 飘带（祥云曲线）
    for i, y in enumerate((250, 300)):
        d.arc([360 + i * 120, y, 700 + i * 120, y + 90], 180, 340, fill=(255, 226, 170, 90), width=6)
    return img

# ---------- 星海战记：星空 + 行星 + 飞船 ----------
def xing_hai():
    img = vgrad((30, 50, 116), (6, 10, 36)).convert('RGBA')
    dark = (8, 14, 40)
    d = ImageDraw.Draw(img)
    random.seed('xw')
    for _ in range(220):                                                     # 星空
        x, y = random.randint(0, W), random.randint(0, 480)
        r = random.choice([1, 1, 2, 2, 3])
        d.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255, random.randint(120, 235)))
    d.ellipse([1060, 90, 1300, 330], fill=(122, 94, 206, 255))               # 行星
    d.ellipse([1060, 90, 1300, 330], outline=(170, 140, 240, 120), width=4)
    d.arc([980, 160, 1380, 260], 0, 360, fill=(140, 205, 255, 210), width=7) # 光环
    d.ellipse([240, 330, 360, 450], fill=(70, 140, 200, 255))                # 小行星
    d.ellipse([258, 350, 300, 384], fill=(50, 108, 160, 255))                # 陨石坑
    d.ellipse([308, 392, 336, 420], fill=(50, 108, 160, 255))
    # 飞船（向左飞）
    cx, cy = 620, 300
    d.polygon([(cx - 190, cy), (cx + 60, cy - 42), (cx + 230, cy), (cx + 60, cy + 26)], fill=dark)
    d.ellipse([cx - 30, cy - 46, cx + 70, cy + 2], fill=dark)                # 驾驶舱
    d.ellipse([cx - 12, cy - 36, cx + 52, cy - 6], fill=(140, 205, 255, 235))
    d.polygon([(cx - 190, cy), (cx - 320, cy - 26), (cx - 320, cy + 26)], fill=(255, 160, 60, 210))  # 尾焰
    d.polygon([(cx - 190, cy), (cx - 260, cy - 12), (cx - 260, cy + 12)], fill=(255, 220, 120, 235))
    return img

shen_hai().convert('RGB').save('posters/02_shen_hai_wide.jpg', quality=90)
print('02_shen_hai_wide.jpg done')
chang_an().convert('RGB').save('posters/01_chang_an_wide.jpg', quality=90)
print('01_chang_an_wide.jpg done')
xing_hai().convert('RGB').save('posters/08_xing_hai_wide.jpg', quality=90)
print('08_xing_hai_wide.jpg done')
print('=== ALL DONE ===')
