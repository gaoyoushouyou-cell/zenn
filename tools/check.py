"""静的検査（依存なし）。ビルドの前に必ず実行される。

    python tools/check.py

検査項目:
- Service Worker の ASSETS と実ファイルが一致している（オフラインで欠けるファイルがない）
- import の参照先がすべて存在する
- 危険な API を使っていない（innerHTML / eval / new Function / document.write）
- 外部 URL を読み込んでいない（ネットワークに依存しない・送信しない）
- console.log を残していない（感情記録などがログに出ないように）
- CSP が設定されている
- manifest が正しく、アイコンが存在する
- 性能予算: 初期転送量（gzip 後）が予算内
"""
from __future__ import annotations

import gzip
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP_DIRS = ["src", "styles", "icons"]
APP_FILES = ["index.html", "manifest.webmanifest"]
BUDGET_GZIP_BYTES = 120_000  # Performance.md 参照

errors: list[str] = []


def err(msg: str) -> None:
    errors.append(msg)


def app_files() -> list[str]:
    out = list(APP_FILES)
    for d in APP_DIRS:
        for p in sorted((ROOT / d).rglob("*")):
            if p.is_file():
                out.append(p.relative_to(ROOT).as_posix())
    return out


def strip_comments(js: str) -> str:
    js = re.sub(r"/\*.*?\*/", "", js, flags=re.S)
    return re.sub(r"(^|[^:'\"`])//[^\n]*", r"\1", js)


def check_sw() -> None:
    sw = (ROOT / "sw.js").read_text(encoding="utf-8")
    m = re.search(r"const ASSETS = \[(.*?)\];", sw, re.S)
    if not m:
        err("sw.js: ASSETS が見つかりません")
        return
    listed = set(re.findall(r"'([^']+)'", m.group(1))) - {"./"}
    actual = set(app_files())
    for missing in sorted(actual - listed):
        err(f"sw.js: ASSETS に {missing} がありません（オフラインで欠けます）")
    for extra in sorted(listed - actual):
        err(f"sw.js: ASSETS の {extra} が存在しません")


def check_js() -> None:
    for p in sorted((ROOT / "src").rglob("*.js")):
        rel = p.relative_to(ROOT).as_posix()
        src = p.read_text(encoding="utf-8")
        code = strip_comments(src)
        for pat, why in [
            (r"\.innerHTML\s*=", "innerHTML（XSS の危険）"),
            (r"\.outerHTML\s*=", "outerHTML 代入"),
            (r"\beval\s*\(", "eval"),
            (r"new\s+Function\s*\(", "new Function"),
            (r"document\.write\s*\(", "document.write"),
            (r"console\.log\s*\(", "console.log（ログに個人情報を出さない）"),
            (r"https?://", "外部 URL"),
            (r"\bfetch\s*\(", "fetch（アプリ本体は通信しない）"),
            (r"XMLHttpRequest|sendBeacon|WebSocket", "通信 API"),
        ]:
            if re.search(pat, code):
                err(f"{rel}: {why} を使っています")
        for imp in re.findall(r"(?:import|from)\s*['\"](\.[^'\"]+)['\"]", code):
            target = (p.parent / imp).resolve()
            if not target.exists():
                err(f"{rel}: import 先 {imp} がありません")


def check_html() -> None:
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    if "Content-Security-Policy" not in html or "script-src 'self'" not in html:
        err("index.html: CSP がありません")
    if re.search(r"<script(?![^>]*src=)[^>]*>", html):
        err("index.html: インラインスクリプトがあります（CSP 違反）")
    if re.search(r"\sstyle=\"", html):
        err("index.html: style 属性があります（CSP 違反）")
    if re.search(r"(src|href)=\"https?://", html):
        err("index.html: 外部リソースを読み込んでいます")
    if 'lang="' not in html:
        err("index.html: lang 属性がありません")


def check_css() -> None:
    css = (ROOT / "styles" / "app.css").read_text(encoding="utf-8")
    if re.search(r"url\(\s*['\"]?https?://", css) or "@import" in css:
        err("app.css: 外部リソースを読み込んでいます")
    for needed in ["prefers-color-scheme", "forced-colors", "data-motion=\"reduce\"", "focus-visible", "prefers-contrast"]:
        if needed not in css:
            err(f"app.css: {needed} への対応がありません")


def check_manifest() -> None:
    try:
        m = json.loads((ROOT / "manifest.webmanifest").read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        err(f"manifest: JSON が不正 {e}")
        return
    for icon in m.get("icons", []):
        if not (ROOT / icon["src"]).exists():
            err(f"manifest: アイコン {icon['src']} がありません")
    if not any("maskable" in i.get("purpose", "") for i in m.get("icons", [])):
        err("manifest: maskable アイコンがありません")


def budget() -> tuple[int, int]:
    raw = gz = 0
    for f in app_files():
        b = (ROOT / f).read_bytes()
        raw += len(b)
        if not f.endswith(".png"):
            gz += len(gzip.compress(b, 9))
        else:
            gz += len(b)
    raw += (ROOT / "sw.js").stat().st_size
    if gz > BUDGET_GZIP_BYTES:
        err(f"性能予算: gzip 後 {gz} bytes > 予算 {BUDGET_GZIP_BYTES}")
    return raw, gz


def main() -> int:
    check_sw()
    check_js()
    check_html()
    check_css()
    check_manifest()
    raw, gz = budget()
    print(f"app size: {raw:,} bytes raw / {gz:,} bytes gzip (budget {BUDGET_GZIP_BYTES:,})")
    if errors:
        print("\n".join("NG  " + e for e in errors))
        return 1
    print("OK  static checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
