# -*- coding: utf-8 -*-
"""本地生成 14 张 2:3 竖版海报（渐变 + 几何装饰 + 标题）"""
from PIL import Image, ImageDraw, ImageFont
import os, math, random

W, H = 480, 720  # 2:3
os.makedirs('posters', exist_ok=True)

FONT = 'C:/Windows/Fonts/msyh.ttc'
FONT_B = 'C:/Windows/Fonts/msyhbd.ttc'

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

def soft_circle(draw, cx, cy, r, color, alpha):
    overlay = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color + (alpha,))
    return overlay

def wrap(text, font, max_w, draw):
    lines, cur = [], ''
    for ch in text:
        if draw.textlength(cur + ch, font=font) > max_w:
            lines.append(cur); cur = ch
        else:
            cur += ch
    if cur: lines.append(cur)
    return lines

# (文件名, 标题, 类型名, 主色A, 主色B, 强调色)
ITEMS = [
    ('01_chang_an', '长安霓裳录', '电视剧 · 古装悬疑', (122, 44, 58), (43, 24, 48), (232, 180, 120)),
    ('02_shen_hai', '深海回响', '院线电影 · 科幻惊悚', (8, 32, 64), (2, 8, 24), (64, 180, 220)),
    ('03_sheng_lang', '声浪 2026', '综艺 · 音乐竞演', (88, 40, 140), (30, 14, 60), (240, 120, 200)),
    ('04_wu_shan', '雾山行', '动漫 · 国风热血', (60, 80, 96), (20, 28, 36), (220, 90, 70)),
    ('05_ni_guang', '逆光行者', '院线电影 · 现实题材', (30, 50, 80), (10, 18, 32), (255, 170, 80)),
    ('06_wu_sheng', '无声告白', '电视剧 · 悬疑家庭', (48, 56, 76), (18, 22, 34), (150, 170, 210)),
    ('07_man_you', '慢游中国', '综艺 · 慢游人文', (120, 96, 64), (56, 42, 26), (255, 220, 150)),
    ('08_xing_hai', '星海战记', '动漫 · 科幻星际', (24, 40, 96), (6, 10, 32), (120, 200, 255)),
    ('09_xia_ri', '夏日晚风', '院线电影 · 青春爱情', (240, 150, 100), (200, 90, 110), (255, 240, 200)),
    ('10_po_xiao', '破晓行动', '电视剧 · 刑侦涉案', (36, 64, 84), (12, 24, 34), (255, 140, 70)),
    ('11_nao_li', '脑力竞技场', '综艺 · 科学竞技', (30, 80, 140), (10, 28, 60), (110, 230, 255)),
    ('12_mao_ding', '猫町奇谭', '动漫 · 治愈奇幻', (250, 180, 140), (230, 130, 140), (255, 250, 235)),
    ('13_shan_he', '山河笔记', '纪录片 · 自然人文', (70, 110, 90), (24, 48, 40), (230, 220, 160)),
    ('14_si_lu', '丝路遗珍', '纪录片 · 考古历史', (180, 130, 70), (100, 62, 30), (255, 235, 190)),
]

for fname, title, genre, c1, c2, accent in ITEMS:
    random.seed(fname)
    img = vgrad(c1, c2).convert('RGBA')

    # 几何装饰：柔和圆斑 + 斜切色带
    for _ in range(5):
        cx, cy = random.randint(-60, W), random.randint(-60, H)
        r = random.randint(60, 200)
        img.alpha_composite(soft_circle(None, cx, cy, r, accent, random.randint(14, 40)))
    band = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    bd = ImageDraw.Draw(band)
    bd.polygon([(0, H), (W, int(H * 0.62)), (W, H)], fill=lerp(c2, (0, 0, 0), 0.35) + (120,))
    img.alpha_composite(band)
    # 顶部细装饰线
    d = ImageDraw.Draw(img)
    d.rectangle([40, 52, 120, 56], fill=accent + (220,))

    # 类型小字
    f_genre = ImageFont.truetype(FONT, 24)
    d.text((40, 78), genre, font=f_genre, fill=accent + (235,))

    # 标题（自动换行、纵向居中偏下）
    f_title = ImageFont.truetype(FONT_B, 64)
    lines = wrap(title, f_title, W - 80, d)
    lh = 84
    ty = int(H * 0.58)
    for ln in lines:
        d.text((40, ty), ln, font=f_title, fill=(255, 255, 255, 245))
        ty += lh

    # 底部装饰短线
    d.rectangle([40, ty + 16, 40 + 90, ty + 20], fill=accent + (200,))

    img.convert('RGB').save(f'posters/{fname}.jpg', quality=88)
    print(f'{fname}.jpg done')

print('=== ALL DONE ===')
