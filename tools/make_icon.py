#!/usr/bin/env python3
"""从 assets/tray.png 生成多尺寸 assets/timer.ico。

exe 图标资源（rsrc_windows_amd64.syso）由此文件生成：
    python tools/make_icon.py
    go run github.com/akavel/rsrc@latest -ico assets/timer.ico -o rsrc_windows_amd64.syso
源图只有 32px：小尺寸忠实缩放，大尺寸 LANCZOS 平滑放大兜底（仅超大图标视图使用）。
"""
from PIL import Image

SRC = "assets/tray.png"
DST = "assets/timer.ico"
SIZES = [16, 20, 24, 32, 48, 64, 128, 256]

src = Image.open(SRC).convert("RGBA")
imgs = [src.resize((s, s), Image.LANCZOS) for s in SIZES]
imgs[-1].save(DST, format="ICO", sizes=[(s, s) for s in SIZES])
print(f"生成 {DST}: {SIZES}")
