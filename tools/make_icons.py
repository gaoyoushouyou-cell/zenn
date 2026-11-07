"""アプリアイコン（PNG）を標準ライブラリだけで生成する。

icons/icon.svg と同じ「閉じきらない輪」を、アンチエイリアス付きで描く。
外部の画像素材やライブラリを使わないため、ライセンス上の懸念がない。

    python tools/make_icons.py
"""
from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BG = (11, 13, 18)
FG = (201, 180, 138)
GAP_FROM = math.radians(-47.8)  # 輪が切れている角度の範囲（画面座標、y 下向き）
GAP_TO = math.radians(15.0)


def png(width: int, height: int, rows: list[bytes]) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + r for r in rows)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def in_gap(a: float) -> bool:
    return GAP_FROM < a < GAP_TO


def coverage(x: float, y: float, cx: float, cy: float, r: float, half: float) -> float:
    """点 (x, y) が輪（丸い端つき）にどれだけ覆われるか 0..1"""
    dx, dy = x - cx, y - cy
    a = math.atan2(dy, dx)
    if not in_gap(a):
        d = abs(math.hypot(dx, dy) - r)
    else:
        # 端の丸み: 切れ目の両端点までの距離
        p1 = (cx + r * math.cos(GAP_FROM), cy + r * math.sin(GAP_FROM))
        p2 = (cx + r * math.cos(GAP_TO), cy + r * math.sin(GAP_TO))
        d = min(math.hypot(x - p1[0], y - p1[1]), math.hypot(x - p2[0], y - p2[1]))
    return max(0.0, min(1.0, half - d + 0.5))


def render(size: int, maskable: bool) -> bytes:
    s = size / 64.0
    # maskable はセーフゾーン（中央 80%）に収めるため少し小さく描き、角丸なしで全面を塗る
    scale = 0.78 if maskable else 1.0
    cx = cy = size / 2
    r = 19 * s * scale
    half = 1.6 * s * scale
    radius = 0 if maskable else 14 * s
    rows = []
    sub = 3
    for j in range(size):
        row = bytearray()
        for i in range(size):
            # 角丸の背景（アンチエイリアス）
            bg_a = 1.0
            if radius:
                qx = max(radius - (i + 0.5), 0, (i + 0.5) - (size - radius))
                qy = max(radius - (j + 0.5), 0, (j + 0.5) - (size - radius))
                if qx or qy:
                    bg_a = max(0.0, min(1.0, radius - math.hypot(qx, qy) + 0.5))
            cov = 0.0
            for sy in range(sub):
                for sx in range(sub):
                    cov += coverage(i + (sx + 0.5) / sub, j + (sy + 0.5) / sub, cx, cy, r, half)
            cov /= sub * sub
            col = [round(BG[k] * (1 - cov) + FG[k] * cov) for k in range(3)]
            row += bytes(col + [round(255 * bg_a)])
        rows.append(bytes(row))
    return png(size, size, rows)


def main() -> None:
    out = ROOT / "icons"
    out.mkdir(exist_ok=True)
    (out / "icon-192.png").write_bytes(render(192, False))
    (out / "icon-512.png").write_bytes(render(512, False))
    (out / "icon-maskable-512.png").write_bytes(render(512, True))
    print("icons written to", out)


if __name__ == "__main__":
    main()
