"""開発用の静的サーバー（標準ライブラリのみ）。

    python tools/serve.py            # http://127.0.0.1:5173/
    python tools/serve.py --dir dist # ビルド成果物を配信
    python tools/serve.py --port 8080

- localhost は「安全なコンテキスト」なので Service Worker・Wake Lock が動く
- .js / .webmanifest に正しい MIME を付ける（ES Modules に必須）
- 開発中はキャッシュさせない
- 外部への通信はしない。127.0.0.1 にだけ待ち受ける
"""
from __future__ import annotations

import argparse
import functools
import http.server
import mimetypes
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("image/svg+xml", ".svg")


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".webmanifest": "application/manifest+json",
        ".svg": "image/svg+xml",
        ".json": "application/json",
    }

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), screen-wake-lock=(self)")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:  # 静かに
        if getattr(self.server, "quiet", False):
            return
        super().log_message(fmt, *args)


def make_server(directory: Path, port: int, quiet: bool = False) -> http.server.ThreadingHTTPServer:
    handler = functools.partial(Handler, directory=str(directory))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    httpd.quiet = quiet  # type: ignore[attr-defined]
    return httpd


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5173)
    ap.add_argument("--dir", default=".")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()
    directory = (ROOT / args.dir).resolve()
    httpd = make_server(directory, args.port, args.quiet)
    print(f"serving {directory} at http://127.0.0.1:{args.port}/")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
