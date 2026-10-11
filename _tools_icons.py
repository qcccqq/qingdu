# -*- coding: utf-8 -*-
"""生成轻读应用图标：icon.ico + 各尺寸 PNG（纯 Python，无依赖）"""
import struct, zlib, os

OUT = r'D:\mode\qingdu\app-tauri\src-tauri\icons'
os.makedirs(OUT, exist_ok=True)

def draw(size):
    """蓝底圆角方块 + 白色文档 + 蓝色横线 + 橙色折角"""
    px = bytearray(size * size * 4)
    s = size / 512.0
    def put(x, y, r, g, b, a=255):
        if 0 <= x < size and 0 <= y < size:
            i = (y * size + x) * 4
            px[i] = r; px[i+1] = g; px[i+2] = b; px[i+3] = a
    rad = 90 * s
    m = 20 * s
    for y in range(size):
        for x in range(size):
            # 圆角矩形内测试
            cx = min(max(x, m + rad), size - m - rad)
            cy = min(max(y, m + rad), size - m - rad)
            d2 = (x - cx) ** 2 + (y - cy) ** 2
            inside = d2 <= rad * rad if (x < m + rad or x > size - m - rad or y < m + rad or y > size - m - rad) else True
            if inside:
                # 蓝色渐变底
                t = y / size
                put(x, y, int(46 - 20 * t), int(116 - 30 * t), int(181 + 30 * t))
    # 白色文档：中上一张纸
    dx0, dy0, dx1, dy1 = int(146*s), int(96*s), int(366*s), int(416*s)
    fold = int(70 * s)
    for y in range(dy0, dy1):
        for x in range(dx0, dx1):
            # 折角：右上角三角缺口
            fx, fy = x - (dx1 - fold), y - dy0
            if fx > 0 and fy < fold - fx:
                continue
            put(x, y, 255, 255, 255)
    # 折角三角形（橙色）
    for fy in range(int(fold)):
        for fx in range(int(fold - fy) + 1):
            put(dx1 - fold + fx, dy0 + fy, 255, 160, 60)
    # 蓝色文字线
    for i, (ly, lw) in enumerate([(200, 12), (250, 12), (300, 12)]):
        ly = int(ly * s) + (0 if i == 0 else 0)
        ly = int((ly) * 1.0)
        yy = int(dy0 + 90*s) + i * int(64*s)
        for y in range(yy, yy + int(lw*s) + 2):
            for x in range(dx0 + int(40*s), dx1 - int(40*s)):
                put(x, y, 46, 116, 181)
    return bytes(px)

def png_chunk(typ, data):
    c = struct.pack('>I', len(data)) + typ + data
    return c + struct.pack('>I', zlib.crc32(typ + data) & 0xffffffff)

def make_png(size):
    raw = draw(size)
    rows = b''
    stride = size * 4
    for y in range(size):
        rows += b'\x00' + raw[y*stride:(y+1)*stride]
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return (b'\x89PNG\r\n\x1a\n' + png_chunk(b'IHDR', ihdr)
            + png_chunk(b'IDAT', zlib.compress(rows, 9)) + png_chunk(b'IEND', b''))

def make_ico(path):
    """256 PNG 条目 + 32 BMP 条目"""
    png256 = make_png(256)
    # 32x32 BMP 条目
    size = 32
    px = draw(size)
    bmp = struct.pack('<IiiHHIIiiII', 40, size, size*2, 1, 32, 0, size*size*4, 0, 0, 0, 0)
    rows = b''
    for y in range(size-1, -1, -1):
        row = b''
        for x in range(size):
            i = (y*size + x) * 4
            row += bytes((px[i+2], px[i+1], px[i], px[i+3]))
        rows += row
    mask_row = b'\x00' * (size // 8)
    mask = mask_row * size
    bmp32 = bmp + rows + mask
    entries = [
        (0, len(png256), png256),          # 256 → 宽高写 0
        (32, len(bmp32), bmp32),
    ]
    ico = struct.pack('<HHH', 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    for w, sz, data in entries:
        ico += struct.pack('<BBBBHHII', w if w < 256 else 0, w if w < 256 else 0, 0, 0, 1, 32, sz, offset)
        offset += sz
    for w, sz, data in entries:
        ico += data
    with open(path, 'wb') as f:
        f.write(ico)

for name, size in [('icon.png', 512), ('128x128@2x.png', 256), ('128x128.png', 128), ('32x32.png', 32)]:
    p = os.path.join(OUT, name)
    with open(p, 'wb') as f:
        f.write(make_png(size))
    print('生成', name, os.path.getsize(p), '字节')

make_ico(os.path.join(OUT, 'icon.ico'))
print('生成 icon.ico', os.path.getsize(os.path.join(OUT, 'icon.ico')), '字节')
