# 生成 README 展示图：把 CapturePage 的透明截图合成到深色渐变背景上
from PIL import Image, ImageDraw, ImageFilter

DARK_TL = (43, 53, 70)    # 左上
DARK_BR = (18, 23, 32)    # 右下
GLOW = (86, 122, 176)     # 设备背后的柔光


def gradient(w, h, c1, c2):
    """对角渐变：2x2 四角颜色双三次放大"""
    base = Image.new("RGB", (2, 2))
    base.putpixel((0, 0), c1)
    base.putpixel((1, 0), tuple((a + b) // 2 for a, b in zip(c1, c2)))
    base.putpixel((0, 1), tuple((a + b) // 2 for a, b in zip(c1, c2)))
    base.putpixel((1, 1), c2)
    return base.resize((w, h), Image.BICUBIC)


def glow_layer(w, h, cx, cy, rx, ry, color, alpha):
    """椭圆柔光"""
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=color + (alpha,))
    return layer.filter(ImageFilter.GaussianBlur(80))


def rounded_shadow(w, h, box, radius, blur, alpha, dy):
    """圆角卡片投影"""
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    x0, y0, x1, y1 = box
    d.rounded_rectangle([x0, y0 + dy, x1, y1 + dy], radius=radius, fill=(0, 0, 0, alpha))
    return layer.filter(ImageFilter.GaussianBlur(blur))


def rounded_paste(canvas, img, xy, radius):
    """带圆角遮罩粘贴"""
    mask = Image.new("L", img.size, 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, img.size[0] - 1, img.size[1] - 1], radius=radius, fill=255)
    canvas.paste(img, xy, mask)


def make_device_shot(raw, out, canvas=(1680, 680)):
    W, H = canvas
    bg = gradient(W, H, DARK_TL, DARK_BR)
    dev = Image.open(raw).convert("RGBA")

    cx, cy = W // 2, H // 2
    bg = Image.alpha_composite(bg.convert("RGBA"),
                               glow_layer(W, H, cx, cy + 10, 560, 170, GLOW, 70))

    box = (cx - dev.size[0] // 2, cy - dev.size[1] // 2,
           cx + dev.size[0] // 2, cy + dev.size[1] // 2)
    bg = Image.alpha_composite(bg, rounded_shadow(W, H, box, 28, 40, 120, 22))
    bg.paste(dev, (box[0], box[1]), dev)

    bg.convert("RGB").save(out, optimize=True)
    print("saved", out)


def make_settings_shot(raw, out, canvas=(1150, 940)):
    W, H = canvas
    bg = gradient(W, H, DARK_TL, DARK_BR)
    card = Image.open(raw).convert("RGB")

    scale = 0.92
    card = card.resize((int(card.size[0] * scale), int(card.size[1] * scale)), Image.LANCZOS)
    cx, cy = W // 2, H // 2
    box = (cx - card.size[0] // 2, cy - card.size[1] // 2,
           cx + card.size[0] // 2, cy + card.size[1] // 2)

    bg = Image.alpha_composite(bg.convert("RGBA"),
                               rounded_shadow(W, H, box, 24, 40, 150, 24))
    rounded_paste(bg, card, (box[0], box[1]), 18)

    bg.convert("RGB").save(out, optimize=True)
    print("saved", out)


make_device_shot(".raw-idle.png", "assets/preview.png")
make_device_shot(".raw-controls.png", "assets/preview-controls.png")
make_settings_shot(".raw-settings.png", "assets/preview-settings.png")
