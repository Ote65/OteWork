#!/usr/bin/env python3
"""生成安装器用的品牌素材（OteWork 工业深灰 + 橘）。

    python3 tools/installer/branding/make.py        # 需要 pillow
    # 字体：品牌自带的 Baloo2（OFL）woff2 转 ttf 后使用，避免打包系统字体

产出（写进同目录 assets/）：
    installer.ico                     Windows 安装程序图标（16/24/32/48/64/128/256）
    nsis-header.bmp   150×57          NSIS 页眉图
    nsis-welcome.bmp  164×314         NSIS 欢迎/完成页侧图
    nsis-banner-01..10.bmp  150×57    NSIS 页眉逐帧动画（橘色光带右扫）
    nsis-splash.bmp   360×220         NSIS 开场闪屏
"""

import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit('缺 pillow：python3 -m pip install pillow')

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
BRAND = REPO / 'plugins' / 'dsh-ote-brand' / 'assets'
OUT = HERE / 'assets'

INK = (16, 22, 20)
PANEL = (11, 16, 14)
HAIR = (35, 52, 43)
TEXT = (226, 232, 229)
MUTED = (125, 143, 135)
ORANGE = (255, 85, 0)
AMBER = (255, 119, 0)


def baloo():
    """品牌 OFL 字体的 ttf（缓存到 assets/baloo2-700.ttf）。"""
    ttf = OUT / 'baloo2-700.ttf'
    if ttf.exists():
        return ttf
    woff2 = BRAND / 'baloo2-700-latin.woff2'
    if woff2.exists() is False:
        return None
    from fontTools.ttLib import TTFont

    font = TTFont(woff2)
    font.flavor = None
    OUT.mkdir(parents=True, exist_ok=True)
    font.save(ttf)
    return ttf


def label(size, color=TEXT, spacing=0):
    ttf = baloo()
    if ttf is None:
        return None
    return ImageFont.truetype(str(ttf), size)


def mark(size):
    """方形标：官方 mark 反白到深底。"""
    src = Image.open(BRAND / 'ote-work-mark.png').convert('RGBA')
    bbox = src.getbbox()
    src = src.crop(bbox)
    side = max(src.size)
    canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    canvas.paste(src.resize(src.size, Image.LANCZOS), ((side - src.width) // 2, (side - src.height) // 2))
    solid = Image.new('RGBA', canvas.size, TEXT + (255,))
    solid.putalpha(canvas.split()[3])
    return solid.resize((size, size), Image.LANCZOS)


def vertical_gradient(size, top, bottom):
    strip = Image.new('RGB', (1, size[1]))
    draw = ImageDraw.Draw(strip)
    for y in range(size[1]):
        k = y / max(size[1] - 1, 1)
        draw.point((0, y), tuple(round(top[i] + (bottom[i] - top[i]) * k) for i in range(3)))
    return strip.resize(size, Image.BILINEAR)


def write_ico(path):
    sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = []
    for size in sizes:
        tile = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        radius = max(round(size * 0.22), 2)
        plate = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        ImageDraw.Draw(plate).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=PANEL + (255,))
        tile.alpha_composite(plate)
        inner = max(round(size * 0.62), 1)
        logo = mark(inner)
        tile.alpha_composite(logo, ((size - inner) // 2, (size - inner) // 2))
        bar = Image.new('RGBA', (size, max(round(size * 0.05), 1)), ORANGE + (255,))
        tile.alpha_composite(bar, (0, 0))
        frames.append(tile)
    frames[-1].save(path, format='ICO', sizes=[(s, s) for s in sizes], append_images=frames[:-1])


def build_nsis():
    header = vertical_gradient((150, 57), PANEL, (18, 25, 22))
    logo = mark(30)
    header.alpha_composite(logo, (11, 14)) if header.mode == 'RGBA' else header.paste(logo, (11, 14), logo)
    font = label(13, TEXT)
    draw = ImageDraw.Draw(header)
    if font is not None:
        draw.text((50, 20), 'OteWork', font=font, fill=TEXT)
    draw.rectangle([0, 56, 149, 57], fill=ORANGE)
    header.convert('RGB').save(OUT / 'nsis-header.bmp', format='BMP')

    welcome = vertical_gradient((164, 314), (22, 30, 27), PANEL)
    art = mark(84)
    welcome.paste(art, (40, 96), art)
    font = label(20, TEXT)
    small = label(11, MUTED)
    draw = ImageDraw.Draw(welcome)
    if font is not None:
        text = 'OteWork'
        draw.text(((164 - draw.textlength(text, font=font)) / 2, 196), text, font=font, fill=TEXT)
    if small is not None:
        text = 'DSH PLUGIN SET'
        draw.text(((164 - draw.textlength(text, font=small)) / 2, 222), text, font=small, fill=MUTED)
    draw.rectangle([81, 250, 83, 268], fill=ORANGE)
    welcome.convert('RGB').save(OUT / 'nsis-welcome.bmp', format='BMP')


def build_banner():
    """Banner 插件的头部动画帧：橘色光带从左往右扫过一行写入槽。"""
    frames = 10
    for index in range(frames):
        frame = vertical_gradient((150, 57), PANEL, (18, 25, 22))
        logo = mark(26)
        frame.paste(logo, (10, 15), logo)
        draw = ImageDraw.Draw(frame)
        font = label(12, TEXT)
        if font is not None:
            draw.text((46, 21), 'OteWork', font=font, fill=TEXT)
        head = round((index / (frames - 1)) * 146)
        draw.rectangle([2, 44, 2 + head, 45], fill=ORANGE)
        for offset, alpha in ((0, 1.0), (6, 0.55), (12, 0.28), (18, 0.12)):
            x = min(head + offset, 147)
            if x <= head:
                continue
            draw.rectangle([x, 44, x + 1, 45], fill=tuple(round(ORANGE[i] * alpha + PANEL[i] * (1 - alpha)) for i in range(3)))
        frame.convert('RGB').save(OUT / f'nsis-banner-{index + 1:02d}.bmp', format='BMP')


def build_splash():
    """AdvSplash 启动闪屏（Windows 安装包开场淡入淡出）。"""
    size = (360, 220)
    image = vertical_gradient(size, (24, 32, 29), PANEL).convert('RGBA')
    art = mark(96)
    image.alpha_composite(art, ((size[0] - 96) // 2, 44))
    draw = ImageDraw.Draw(image)
    font = label(22, TEXT)
    small = label(11, MUTED)
    if font is not None:
        text = 'OteWork'
        draw.text(((size[0] - draw.textlength(text, font=font)) / 2, 150), text, font=font, fill=TEXT)
    if small is not None:
        text = 'DSH PLUGIN SET'
        draw.text(((size[0] - draw.textlength(text, font=small)) / 2, 180), text, font=small, fill=MUTED)
    draw.rectangle([0, size[1] - 3, size[0], size[1]], fill=ORANGE)
    image.convert('RGB').save(OUT / 'nsis-splash.bmp', format='BMP')


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    write_ico(OUT / 'installer.ico')
    build_nsis()
    build_banner()
    build_splash()
    print('素材已生成：' + ', '.join(sorted(p.name for p in OUT.iterdir() if p.is_file())))


if __name__ == '__main__':
    main()
