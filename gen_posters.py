# -*- coding: utf-8 -*-
"""按影视内容主题生成 14 张 2:3 竖版海报（扁平插画风：渐变底 + 主题剪影场景 + 标题）"""
from PIL import Image, ImageDraw, ImageFont
import os, random, math

W, H = 480, 720
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

def wrap(text, font, max_w, draw):
    lines, cur = [], ''
    for ch in text:
        if draw.textlength(cur + ch, font=font) > max_w:
            lines.append(cur); cur = ch
        else:
            cur += ch
    if cur: lines.append(cur)
    return lines

def birds(d, pts, color):
    for (x, y, s) in pts:
        d.arc([x - s, y - s, x, y + s], 200, 340, fill=color, width=3)
        d.arc([x, y - s, x + s, y + s], 200, 340, fill=color, width=3)

def stars(d, n, seed, ymax, color):
    random.seed(seed)
    for _ in range(n):
        x, y = random.randint(0, W), random.randint(0, ymax)
        r = random.choice([1, 1, 2])
        d.ellipse([x - r, y - r, x + r, y + r], fill=color)

def finish(img, title, genre, accent):
    """统一的文字排版：顶部类型、下部标题"""
    d = ImageDraw.Draw(img)
    # 底部暗化条，保证标题可读
    shade = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(shade).polygon([(0, H), (W, int(H * 0.66)), (W, H)], fill=(0, 0, 0, 110))
    img.alpha_composite(shade)
    d = ImageDraw.Draw(img)
    d.rectangle([40, 52, 120, 56], fill=accent + (220,))
    d.text((40, 78), genre, font=ImageFont.truetype(FONT, 24), fill=accent + (235,))
    f_title = ImageFont.truetype(FONT_B, 64)
    lines = wrap(title, f_title, W - 80, d)
    ty = int(H * 0.74) - (len(lines) - 1) * 84
    for ln in lines:
        d.text((40, ty), ln, font=f_title, fill=(255, 255, 255, 245))
        ty += 84
    d.rectangle([40, ty + 16, 130, ty + 20], fill=accent + (200,))
    return img

# ============ 各作品主题场景 ============

def scene_chang_an(d, accent, dark):  # 唐宫：重檐宫殿剪影 + 圆月
    d.ellipse([300, 90, 420, 210], fill=accent + (255,))           # 月
    d.ellipse([296, 86, 424, 214], outline=(255, 240, 210, 90), width=4)
    base = 470
    d.rectangle([60, base, 420, base + 60], fill=dark)             # 主殿身
    d.polygon([(40, base), (240, base - 90), (440, base)], fill=dark)   # 上檐
    d.polygon([(90, base - 90), (240, base - 150), (390, base - 90)], fill=dark)  # 重檐
    d.rectangle([236, base - 170, 244, base - 150], fill=dark)     # 脊
    for wx in range(90, 400, 44):                                   # 窗棂
        d.rectangle([wx, base + 16, wx + 22, base + 44], fill=accent + (170,))
    d.rectangle([0, base + 60, W, H], fill=dark)

def scene_shen_hai(d, accent, dark):  # 深海：潜艇剪影 + 气泡 + 光柱
    beam = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(beam).polygon([(120, 0), (200, 0), (320, 480), (180, 480)], fill=(120, 220, 255, 36))
    return beam

def draw_shen_hai(img, accent, dark):
    img.alpha_composite(scene_shen_hai(None, accent, dark))
    d = ImageDraw.Draw(img)
    d.ellipse([120, 330, 360, 410], fill=dark)                      # 艇身
    d.rectangle([200, 296, 260, 336], fill=dark)                    # 指挥塔
    d.polygon([(352, 350), (396, 330), (396, 390), (352, 390)], fill=dark)  # 尾舵
    for wx in range(150, 300, 36):
        d.ellipse([wx, 358, wx + 16, 374], fill=accent + (200,))    # 舷窗
    random.seed('bubble')
    for _ in range(14):                                             # 气泡
        x, y = random.randint(30, 450), random.randint(80, 320)
        r = random.randint(3, 10)
        d.ellipse([x - r, y - r, x + r, y + r], outline=accent + (150,), width=2)
    for i in range(3):                                              # 声波纹
        r = 60 + i * 46
        d.arc([240 - r, 470 - r, 240 + r, 470 + r], 300, 240, fill=accent + (120 - i * 30,), width=3)
    return img

def scene_sheng_lang(img, accent, dark):  # 音乐舞台：射灯 + 麦克风 + 音浪
    d = ImageDraw.Draw(img)
    for sx in (90, 240, 390):                                       # 顶部射灯光束
        beam = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        ImageDraw.Draw(beam).polygon([(sx - 14, 0), (sx + 14, 0), (sx + 90, 430), (sx - 90, 430)],
                                     fill=accent + (30,))
        img.alpha_composite(beam)
    d = ImageDraw.Draw(img)
    d.ellipse([196, 300, 284, 388], fill=dark)                      # 麦克风头
    for i in range(3):
        d.arc([196 - 8 + i * 4, 300 - 8 + i * 4, 284 + 8 - i * 4, 388 + 8 - i * 4], 0, 360, fill=accent + (140,), width=2)
    d.polygon([(226, 388), (254, 388), (246, 470), (234, 470)], fill=dark)  # 手柄
    d.rectangle([150, 470, 330, 482], fill=dark)                    # 台
    random.seed('wave')
    for i, x in enumerate(range(60, 440, 20)):                      # 音浪条
        h = random.randint(14, 60)
        d.rectangle([x, 560 - h, x + 8, 560 + h], fill=accent + (170,))
    return img

def scene_wu_shan(img, accent, dark):  # 雾山：层叠山峦 + 红日 + 雾带
    d = ImageDraw.Draw(img)
    d.ellipse([320, 120, 420, 220], fill=(230, 84, 60, 255))        # 红日
    def ridge(pts, color):
        d.polygon(pts + [(W, H), (0, H)], fill=color)
    ridge([(0, 380), (120, 300), (240, 380), (360, 290), (W, 380)], lerp(dark, (255, 255, 255), 0.08) + (210,))
    ridge([(0, 470), (160, 380), (300, 470), (420, 390), (W, 460)], dark + (235,))
    for my in (350, 440):                                           # 雾带
        fog = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        ImageDraw.Draw(fog).ellipse([-80, my, W + 80, my + 56], fill=(235, 235, 230, 70))
        img.alpha_composite(fog)
    d = ImageDraw.Draw(img)
    birds(d, [(140, 180, 16), (190, 210, 12)], (60, 60, 60, 200))
    return img

def scene_ni_guang(img, accent, dark):  # 城市雨夜：楼群 + 雨丝 + 骑手
    d = ImageDraw.Draw(img)
    random.seed('city')
    x = 0
    while x < W:                                                    # 楼群剪影
        bw, bh = random.randint(50, 90), random.randint(150, 300)
        d.rectangle([x, 470 - bh, x + bw, 470], fill=dark)
        for wy in range(470 - bh + 14, 460, 26):                    # 亮窗
            for wx in range(x + 8, x + bw - 10, 18):
                if random.random() < 0.35:
                    d.rectangle([wx, wy, wx + 8, wy + 10], fill=accent + (150,))
        x += bw + random.randint(6, 18)
    for _ in range(70):                                             # 雨丝
        rx, ry = random.randint(0, W), random.randint(0, 520)
        d.line([(rx, ry), (rx - 6, ry + 18)], fill=(200, 220, 255, 90), width=1)
    d.ellipse([70, 130, 150, 210], fill=accent + (200,))            # 逆光光晕
    d.ellipse([200, 420, 250, 470], outline=(255, 200, 120, 255), width=6)   # 车轮
    d.ellipse([300, 420, 350, 470], outline=(255, 200, 120, 255), width=6)
    d.line([(250, 445), (290, 400), (325, 445)], fill=(255, 200, 120, 255), width=6)  # 车架
    d.ellipse([276, 356, 304, 384], fill=(255, 200, 120, 255))      # 骑手头
    d.line([(290, 384), (290, 404)], fill=(255, 200, 120, 255), width=8)
    d.rectangle([0, 470, W, 500], fill=dark)                        # 路面
    return img

def scene_wu_sheng(img, accent, dark):  # 悬疑家庭：房子 + 一扇亮窗 + 月
    d = ImageDraw.Draw(img)
    d.ellipse([360, 80, 430, 150], fill=(235, 235, 225, 230))       # 月
    d.rectangle([120, 330, 360, 500], fill=dark)                    # 房身
    d.polygon([(100, 330), (240, 250), (380, 330)], fill=dark)      # 屋顶
    d.rectangle([220, 200, 236, 250], fill=dark)                    # 烟囱
    d.rectangle([150, 360, 200, 410], outline=(120, 130, 150, 255), width=3)   # 暗窗
    d.rectangle([280, 360, 330, 410], fill=accent + (255,))         # 亮窗
    d.line([(305, 360), (305, 410)], fill=dark + (255,), width=3)
    d.line([(280, 385), (330, 385)], fill=dark + (255,), width=3)
    d.ellipse([292, 376, 300, 400], fill=dark + (255,))             # 窗内人影
    d.rectangle([226, 440, 254, 500], fill=(20, 24, 34, 255))       # 门
    d.rectangle([0, 500, W, 530], fill=dark)
    return img

def scene_man_you(img, accent, dark):  # 古镇：屋檐 + 灯笼 + 石板路
    d = ImageDraw.Draw(img)
    d.polygon([(40, 300), (200, 220), (360, 300)], fill=dark)       # 左屋檐
    d.rectangle([70, 300, 330, 470], fill=lerp(dark, (255, 255, 255), 0.06))
    d.polygon([(180, 380), (360, 300), (W, 380)], fill=dark)        # 右屋檐
    d.rectangle([220, 380, W, 470], fill=lerp(dark, (255, 255, 255), 0.03))
    for lx in (150, 250, 400):                                      # 灯笼
        d.line([(lx, 300), (lx, 316)], fill=(40, 30, 20, 255), width=2)
        d.ellipse([lx - 14, 316, lx + 14, 348], fill=(235, 90, 60, 255))
        d.rectangle([lx - 6, 348, lx + 6, 354], fill=(255, 210, 120, 255))
    for i in range(4):                                              # 石板路
        d.line([(60 + i * 10, 470 + i * 30), (W - 60 - i * 10, 470 + i * 30)], fill=(255, 240, 210, 90), width=2)
    birds(d, [(120, 130, 14), (170, 160, 10)], (90, 70, 50, 200))
    return img

def scene_xing_hai(img, accent, dark):  # 星际：星空 + 行星 + 飞船
    d = ImageDraw.Draw(img)
    stars(d, 120, 'star', 560, (255, 255, 255, 220))
    d.ellipse([60, 120, 200, 260], fill=(120, 90, 200, 255))        # 行星
    d.arc([30, 160, 230, 220], 0, 360, fill=accent + (200,), width=5)  # 光环
    d.ellipse([300, 320, 380, 400], fill=(70, 140, 200, 255))       # 小行星
    ship = [(100, 470), (220, 440), (340, 470), (220, 486)]         # 飞船剪影
    d.polygon(ship, fill=dark)
    d.ellipse([196, 440, 244, 470], fill=dark)
    d.ellipse([206, 446, 234, 464], fill=accent + (230,))
    d.polygon([(340, 470), (392, 458), (392, 482)], fill=(255, 160, 60, 200))  # 尾焰
    return img

def scene_xia_ri(img, accent, dark):  # 夏日海边：落日 + 海平线 + 海鸥
    d = ImageDraw.Draw(img)
    d.ellipse([170, 210, 310, 350], fill=(255, 236, 180, 255))      # 落日
    d.rectangle([0, 380, W, 560], fill=(235, 120, 100, 255))        # 海面
    for i in range(6):                                              # 波光
        y = 400 + i * 24
        d.line([(60 + i * 14, y), (200 + i * 10, y)], fill=(255, 230, 190, 150), width=3)
        d.line([(300 - i * 8, y + 8), (420 - i * 10, y + 8)], fill=(255, 230, 190, 120), width=3)
    d.rectangle([0, 560, W, H], fill=(250, 214, 165, 255))          # 沙滩
    d.polygon([(0, 560), (140, 560), (60, H), (0, H)], fill=(245, 200, 150, 255))
    birds(d, [(320, 150, 16), (370, 120, 12), (260, 110, 10)], (120, 70, 60, 220))
    d.ellipse([196, 500, 212, 534], fill=(90, 50, 60, 255))         # 两个人影
    d.rectangle([192, 534, 216, 560], fill=(90, 50, 60, 255))
    d.ellipse([228, 506, 242, 534], fill=(90, 50, 60, 255))
    d.rectangle([224, 534, 246, 560], fill=(90, 50, 60, 255))
    return img

def scene_po_xiao(img, accent, dark):  # 破晓边境：岗亭 + 铁丝网 + 晨光
    d = ImageDraw.Draw(img)
    for gy in range(120, 300, 12):                                  # 晨光线
        d.line([(0, gy), (W, gy - 40)], fill=(255, 180, 100, 26), width=2)
    d.ellipse([330, 150, 420, 240], fill=(255, 170, 90, 255))       # 朝阳
    d.rectangle([90, 340, 190, 470], fill=dark)                     # 岗亭
    d.polygon([(70, 340), (140, 300), (210, 340)], fill=dark)
    d.rectangle([110, 370, 170, 410], fill=accent + (160,))
    d.rectangle([136, 470, 144, 500], fill=dark)
    for px in range(230, W, 46):                                    # 铁丝网柱
        d.rectangle([px, 400, px + 6, 500], fill=dark)
    for wy in (420, 460):
        d.line([(230, wy), (W, wy)], fill=dark + (255,), width=3)
        for bx in range(238, W, 24):
            d.line([(bx, wy - 6), (bx + 8, wy + 6)], fill=dark + (255,), width=2)
    d.rectangle([0, 500, W, 530], fill=dark)
    birds(d, [(140, 140, 12), (190, 110, 9)], (60, 50, 40, 200))
    return img

def scene_nao_li(img, accent, dark):  # 脑力：大脑 vs 芯片
    d = ImageDraw.Draw(img)
    d.ellipse([60, 220, 230, 390], fill=lerp(accent, (255, 255, 255), 0.15) + (255,))   # 脑
    d.ellipse([120, 180, 260, 330], fill=lerp(accent, (255, 255, 255), 0.15) + (255,))
    random.seed('brain')
    for _ in range(8):
        bx, by = random.randint(90, 230), random.randint(210, 340)
        d.arc([bx - 20, by - 14, bx + 20, by + 14], 0, 300, fill=dark + (200,), width=3)
    d.rectangle([300, 230, 420, 350], fill=dark)                    # 芯片
    d.rectangle([318, 248, 402, 332], outline=accent + (255,), width=3)
    for i in range(4):
        d.line([(300 + i * 34, 214), (300 + i * 34, 230)], fill=accent + (255,), width=4)
        d.line([(300 + i * 34, 350), (300 + i * 34, 366)], fill=accent + (255,), width=4)
    d.line([(265, 300), (300, 290)], fill=accent + (255,), width=4)  # 对决闪电
    d.polygon([(276, 280), (292, 296), (272, 296), (290, 316), (266, 298), (282, 298)], fill=(255, 220, 90, 255))
    for i, x in enumerate(range(80, 420, 26)):                      # 数据流
        h = 12 + (i * 7) % 34
        d.rectangle([x, 500 - h, x + 10, 500], fill=accent + (140,))
    return img

def scene_mao_ding(img, accent, dark):  # 猫町：屋顶 + 月亮 + 猫剪影
    d = ImageDraw.Draw(img)
    d.ellipse([330, 80, 430, 180], fill=(255, 246, 220, 255))       # 满月
    d.polygon([(0, 380), (120, 300), (240, 380)], fill=dark)        # 屋顶
    d.polygon([(200, 400), (340, 316), (W, 400)], fill=lerp(dark, (255, 255, 255), 0.05))
    d.rectangle([300, 250, 318, 336], fill=dark)                    # 烟囱
    def cat(cx, cy, s, flip=1):
        d.ellipse([cx - s, cy - s, cx + s, cy + int(s * 1.2)], fill=dark)              # 身
        d.ellipse([cx - int(s * .62), cy - s - int(s * .7), cx + int(s * .62), cy - int(s * .2)], fill=dark)  # 头
        d.polygon([(cx - int(s * .5), cy - s - int(s * .55)), (cx - int(s * .12), cy - s - int(s * .5)), (cx - int(s * .42), cy - s - int(s * .95))], fill=dark)  # 耳
        d.polygon([(cx + int(s * .5), cy - s - int(s * .55)), (cx + int(s * .12), cy - s - int(s * .5)), (cx + int(s * .42), cy - s - int(s * .95))], fill=dark)
        d.arc([cx + flip * s - 4, cy - s, cx + flip * s + 44, cy + s], 100 if flip > 0 else -160, 260 if flip > 0 else 80, fill=dark + (255,), width=5)  # 尾
    cat(130, 392, 26)
    cat(370, 412, 20, flip=-1)
    stars(d, 40, 'town', 260, (255, 250, 235, 200))
    return img

def scene_shan_he(img, accent, dark):  # 山河：峡谷群山 + 河流 + 飞鸟
    d = ImageDraw.Draw(img)
    d.polygon([(0, 320), (140, 200), (280, 320), (280, H), (0, H)], fill=lerp(dark, (255, 255, 255), 0.07))
    d.polygon([(200, 340), (360, 180), (W, 340), (W, H), (200, H)], fill=dark)
    d.polygon([(348, 196), (360, 180), (376, 200)], fill=(240, 240, 235, 230))  # 雪顶
    river = [(150, 420), (240, 460), (180, 520), (280, 580), (220, 660), (300, H), (140, H), (110, 640), (170, 560), (90, 500), (140, 450)]
    d.polygon(river, fill=(160, 200, 190, 235))                     # 河流
    birds(d, [(300, 120, 14), (350, 150, 10), (250, 90, 9)], (40, 60, 50, 220))
    return img

def scene_si_lu(img, accent, dark):  # 丝路：沙丘 + 驼队 + 陶罐
    d = ImageDraw.Draw(img)
    d.ellipse([320, 90, 440, 210], fill=(255, 220, 150, 255))       # 大漠日
    d.polygon([(0, 380), (200, 300), (W, 400), (W, H), (0, H)], fill=(230, 190, 130, 255))
    d.polygon([(0, 460), (260, 380), (W, 480), (W, H), (0, H)], fill=(215, 168, 105, 255))
    def camel(cx, cy, s):
        d.ellipse([cx, cy, cx + s * 2, cy + s], fill=dark)          # 身
        d.ellipse([cx + int(s * .7), cy - int(s * .55), cx + int(s * 1.5), cy + int(s * .35)], fill=dark)  # 驼峰
        d.line([(cx + s * 2, cy + 4), (cx + int(s * 2.6), cy - s)], fill=dark + (255,), width=int(s * .3))  # 颈
        d.ellipse([cx + int(s * 2.45), cy - s - 6, cx + int(s * 2.95), cy - int(s * .4)], fill=dark)  # 头
        for lx in (cx + 4, cx + int(s * .8), cx + int(s * 1.3), cx + s * 2 - 6):
            d.line([(lx, cy + s - 2), (lx, cy + s + int(s * .9))], fill=dark + (255,), width=4)  # 腿
    camel(90, 380, 22)
    camel(210, 400, 18)
    d.line([(140, 392), (210, 408)], fill=dark + (255,), width=2)   # 缰绳
    d.ellipse([360, 500, 420, 560], fill=(120, 70, 40, 255))        # 陶罐
    d.rectangle([380, 486, 400, 504], fill=(120, 70, 40, 255))
    d.arc([360, 516, 420, 544], 0, 360, fill=accent + (255,), width=3)
    return img

# ============ 短剧海报场景 ============

def scene_shan_hun(img, accent, dark):  # 闪婚：戒指 + 心 + 花瓣
    d = ImageDraw.Draw(img)
    d.ellipse([180, 200, 300, 320], fill=accent + (60,))             # 光晕
    d.ellipse([210, 230, 270, 290], outline=(255, 255, 255, 200), width=5)  # 戒指
    d.ellipse([228, 248, 252, 272], fill=accent + (255,))             # 钻石
    d.polygon([(240, 240), (246, 252), (240, 264), (234, 252)], fill=(255, 255, 255, 255))
    random.seed('petals')
    for _ in range(20):                                               # 飘落花瓣
        x, y = random.randint(0, W), random.randint(0, H)
        s = random.randint(4, 10)
        d.ellipse([x-s, y, x+s, y+s*2], fill=(255, 180, 200, 160))
    d.rectangle([0, 500, W, H], fill=dark)
    return img

def scene_hui_dao(img, accent, dark):  # 回到1995：老电视 + 城市剪影
    d = ImageDraw.Draw(img)
    d.rectangle([120, 180, 360, 380], fill=dark)                      # 电视框
    d.rectangle([140, 200, 340, 360], fill=lerp(accent, (0, 0, 0), 0.3))  # 屏幕
    d.polygon([(200, 260), (280, 260), (240, 320)], fill=accent + (200,))  # 屏幕城市
    d.rectangle([230, 290, 250, 320], fill=dark)
    d.line([(180, 340), (300, 340)], fill=accent + (180,), width=2)  # 地面线
    d.rectangle([150, 380, 330, 420], fill=dark)                      # 电视底座
    d.rectangle([195, 420, 285, 440], fill=dark)
    d.ellipse([60, 460, 120, 520], fill=dark)                        # 城市楼群
    d.rectangle([80, 440, 110, 520], fill=dark)
    d.rectangle([380, 450, 430, 520], fill=dark)
    d.rectangle([400, 430, 420, 520], fill=dark)
    d.rectangle([0, 520, W, H], fill=dark)
    return img

def scene_ti_jia(img, accent, dark):  # 替嫁千金：面具 + 装饰
    d = ImageDraw.Draw(img)
    d.ellipse([140, 160, 340, 360], fill=accent + (40,))            # 光晕
    d.polygon([(160, 200), (320, 200), (300, 280), (240, 340), (180, 280)], fill=dark)  # 面具
    d.ellipse([190, 220, 230, 260], fill=accent + (255,))            # 眼孔
    d.ellipse([250, 220, 290, 260], fill=accent + (255,))
    d.line([(240, 200), (240, 340)], fill=accent + (200,), width=2)  # 中线
    for i in range(5):                                                # 装饰花纹
        d.arc([200 + i*10, 280, 280 - i*10, 320], 0, 180, fill=accent + (150,), width=2)
    random.seed('sparkle')
    for _ in range(15):
        x, y = random.randint(40, W-40), random.randint(80, 480)
        r = random.choice([1, 2, 3])
        d.ellipse([x-r, y-r, x+r, y+r], fill=(255, 255, 255, 180))
    d.rectangle([0, 480, W, H], fill=dark)
    return img

def scene_chong_sheng(img, accent, dark):  # 重生：沙漏 + 光芒
    d = ImageDraw.Draw(img)
    d.polygon([(200, 160), (280, 160), (260, 280), (220, 280)], fill=dark)  # 沙漏上
    d.polygon([(220, 320), (260, 320), (280, 440), (200, 440)], fill=dark)  # 沙漏下
    d.rectangle([190, 150, 290, 165], fill=dark)                      # 顶
    d.rectangle([190, 435, 290, 450], fill=dark)                     # 底
    for _ in range(8):                                                # 流沙
        sx = random.randint(225, 255)
        sy = random.randint(285, 315)
        d.ellipse([sx-1, sy, sx+1, sy+3], fill=accent + (220,))
    d.line([(240, 165), (240, 280)], fill=accent + (100,), width=1)  # 中线
    for i in range(6):                                                # 光芒
        ang = i * 60
        rad = math.radians(ang)
        d.line([(240, 300), (240 + int(180*math.cos(rad)), 300 + int(180*math.sin(rad)))], fill=accent + (30,), width=2)
    d.rectangle([0, 460, W, H], fill=dark)
    return img

def scene_li_shao(img, accent, dark):  # 厉少：豪车 + 玫瑰
    d = ImageDraw.Draw(img)
    d.rectangle([80, 340, 400, 420], fill=dark)                      # 车身
    d.polygon([(140, 340), (200, 280), (320, 280), (380, 340)], fill=dark)  # 车顶
    d.ellipse([110, 400, 170, 460], fill=(20, 20, 30))               # 车轮
    d.ellipse([120, 410, 160, 450], fill=accent + (180,))
    d.ellipse([320, 400, 380, 460], fill=(20, 20, 30))
    d.ellipse([330, 410, 370, 450], fill=accent + (180,))
    d.rectangle([200, 300, 320, 335], fill=accent + (100,))         # 车窗
    d.ellipse([340, 200, 400, 260], fill=(200, 50, 80))             # 玫瑰
    d.ellipse([350, 210, 390, 250], fill=(220, 80, 100))
    d.line([(370, 260), (370, 340)], fill=(80, 120, 60), width=3)    # 茎
    for i in range(3):                                                # 叶
        d.ellipse([360-i*4, 290-i*10, 380-i*4, 300-i*10], fill=(80, 120, 60))
    d.rectangle([0, 460, W, H], fill=dark)
    return img

def scene_li_hun(img, accent, dark):  # 离婚：高跟鞋 + 城市
    d = ImageDraw.Draw(img)
    random.seed('city2')
    x = 0
    while x < W:                                                    # 楼群
        bw, bh = random.randint(40, 80), random.randint(120, 240)
        d.rectangle([x, 340-bh, x+bw, 340], fill=dark)
        x += bw + random.randint(4, 12)
    d.ellipse([300, 60, 380, 140], fill=accent + (200,))            # 朝阳
    d.polygon([(180, 380), (220, 380), (240, 440), (220, 460), (180, 460), (160, 440)], fill=accent + (255,))  # 鞋
    d.polygon([(180, 380), (220, 380), (215, 400), (185, 400)], fill=lerp(accent, (255,255,255), 0.2) + (255,))  # 鞋面
    d.rectangle([155, 450, 165, 470], fill=accent + (255,))          # 鞋跟
    d.line([(160, 470), (240, 470)], fill=accent + (180,), width=3)  # 地面
    d.rectangle([0, 470, W, H], fill=dark)
    return img

def scene_du_xin(img, accent, dark):  # 读心：气泡 + 问号
    d = ImageDraw.Draw(img)
    for cx, cy, cr in [(160, 200, 60), (320, 180, 45), (240, 320, 50), (380, 300, 35)]:  # 思维气泡
        d.ellipse([cx-cr, cy-cr, cx+cr, cy+cr], outline=accent + (200,), width=3)
        d.ellipse([cx-cr+6, cy-cr+6, cx+cr-6, cy+cr-6], fill=accent + (20,))
    d.ellipse([200, 150, 250, 200], fill=accent + (255,))            # 问号主体
    d.rectangle([218, 205, 232, 220], fill=accent + (255,))          # 问号点
    stars(d, 30, 'mind', 400, (255, 255, 255, 150))
    d.rectangle([0, 440, W, H], fill=dark)
    return img

def scene_shan_hun_da_lao(img, accent, dark):  # 闪婚大佬：契约 + 钢印
    d = ImageDraw.Draw(img)
    d.rectangle([100, 200, 380, 440], fill=lerp(dark, (255,255,255), 0.08))  # 文件
    d.rectangle([100, 200, 380, 440], outline=accent + (150,), width=2)
    d.line([(140, 260), (340, 260)], fill=accent + (100,), width=1)  # 文字线
    d.line([(140, 290), (320, 290)], fill=accent + (100,), width=1)
    d.line([(140, 320), (300, 320)], fill=accent + (100,), width=1)
    d.ellipse([280, 340, 360, 420], outline=(180, 50, 50, 180), width=4)  # 印章
    d.ellipse([290, 350, 350, 410], outline=(180, 50, 50, 120), width=2)
    d.line([(150, 380), (260, 380)], fill=accent + (200,), width=3)  # 签名
    d.line([(155, 375), (165, 388)], fill=accent + (200,), width=2)
    d.line([(165, 375), (155, 388)], fill=accent + (200,), width=2)
    random.seed('confetti')
    for _ in range(12):
        x, y = random.randint(0, W), random.randint(60, 180)
        s = random.randint(3, 7)
        d.ellipse([x-s, y, x+s, y+s*2], fill=(255, 200, 100, 150))
    d.rectangle([0, 440, W, H], fill=dark)
    return img

# ============ 配置：文件名 / 标题 / 类型 / 渐变 / 强调色 / 场景函数 ============
ITEMS = [
    ('01_chang_an', '长安霓裳录', '电视剧 · 古装悬疑', (168, 84, 84), (70, 30, 44), (250, 208, 137), scene_chang_an, 'poly'),
    ('02_shen_hai', '深海回响', '院线电影 · 科幻惊悚', (14, 52, 96), (3, 10, 28), (96, 214, 255), draw_shen_hai, 'img'),
    ('03_sheng_lang', '声浪 2026', '综艺 · 音乐竞演', (110, 52, 168), (32, 14, 64), (245, 130, 205), scene_sheng_lang, 'img'),
    ('04_wu_shan', '雾山行', '动漫 · 国风热血', (96, 112, 122), (28, 36, 44), (228, 96, 74), scene_wu_shan, 'img'),
    ('05_ni_guang', '逆光行者', '院线电影 · 现实题材', (36, 58, 92), (10, 16, 30), (255, 178, 92), scene_ni_guang, 'img'),
    ('06_wu_sheng', '无声告白', '电视剧 · 悬疑家庭', (58, 68, 92), (18, 22, 36), (255, 214, 130), scene_wu_sheng, 'img'),
    ('07_man_you', '慢游中国', '综艺 · 慢游人文', (196, 152, 96), (96, 70, 40), (255, 222, 150), scene_man_you, 'img'),
    ('08_xing_hai', '星海战记', '动漫 · 科幻星际', (28, 46, 108), (6, 10, 34), (130, 205, 255), scene_xing_hai, 'img'),
    ('09_xia_ri', '夏日晚风', '院线电影 · 青春爱情', (250, 168, 108), (228, 110, 110), (255, 246, 210), scene_xia_ri, 'img'),
    ('10_po_xiao', '破晓行动', '电视剧 · 刑侦涉案', (52, 88, 110), (14, 26, 36), (255, 150, 76), scene_po_xiao, 'img'),
    ('11_nao_li', '脑力竞技场', '综艺 · 科学竞技', (36, 92, 156), (10, 28, 62), (116, 232, 255), scene_nao_li, 'img'),
    ('12_mao_ding', '猫町奇谭', '动漫 · 治愈奇幻', (246, 168, 128), (196, 106, 116), (90, 56, 74), scene_mao_ding, 'img'),
    ('13_shan_he', '山河笔记', '纪录片 · 自然人文', (92, 138, 112), (28, 54, 44), (238, 226, 160), scene_shan_he, 'img'),
    ('14_si_lu', '丝路遗珍', '纪录片 · 考古历史', (222, 166, 92), (140, 92, 44), (255, 238, 190), scene_si_lu, 'img'),
    # 短剧海报
    ('15_shan_hun', '闪婚后她野翻了', '短剧 · 甜宠闪婚', (200, 80, 120), (80, 20, 50), (255, 180, 200), scene_shan_hun, 'img'),
    ('16_hui_dao', '回到1995当首富', '短剧 · 年代商战', (180, 130, 60), (60, 40, 20), (255, 200, 100), scene_hui_dao, 'img'),
    ('17_ti_jia', '替嫁千金是满级大佬', '短剧 · 替嫁马甲', (120, 60, 140), (40, 20, 60), (200, 150, 255), scene_ti_jia, 'img'),
    ('18_chong_sheng', '重生后我成了前夫的白月光', '短剧 · 重生复仇', (60, 80, 140), (20, 30, 60), (150, 200, 255), scene_chong_sheng, 'img'),
    ('19_li_shao', '厉少的心尖宠又野翻了', '短剧 · 甜宠萌宝', (220, 100, 130), (100, 40, 60), (255, 150, 180), scene_li_shao, 'img'),
    ('20_li_hun', '离婚后前妻她高攀不起', '短剧 · 逆袭独立', (40, 120, 110), (10, 40, 40), (120, 220, 200), scene_li_hun, 'img'),
    ('21_du_xin', '全家偷听我心声后杀疯了', '短剧 · 读心团宠', (200, 130, 50), (80, 50, 20), (255, 200, 100), scene_du_xin, 'img'),
    ('22_shan_hun_da_lao', '闪婚大佬后我成了全网白月光', '短剧 · 闪婚身份', (160, 80, 110), (50, 20, 40), (255, 200, 220), scene_shan_hun_da_lao, 'img'),
]

for fname, title, genre, c1, c2, accent, fn, mode in ITEMS:
    img = vgrad(c1, c2).convert('RGBA')
    dark = lerp(c2, (0, 0, 0), 0.55)
    if mode == 'poly':
        d = ImageDraw.Draw(img)
        fn(d, accent, dark)
    else:
        img = fn(img, accent, dark)
    img = finish(img, title, genre, accent)
    img.convert('RGB').save(f'posters/{fname}.jpg', quality=88)
    print(f'{fname}.jpg done')

print('=== ALL DONE ===')
