"""ブラウザ内テストをヘッドレスで実行する（Node 不要）。

    python tools/test.py                 # すべて
    python tools/test.py --filter e2e    # 名前で絞り込み
    python tools/test.py --browser edge  # Edge で実行（既定は Chrome、なければ Edge）
    python tools/test.py --headed        # 画面ありで実行

仕組み: 標準ライブラリの HTTP サーバーで tests/index.html を配信し、
ヘッドレスの Chromium 系ブラウザで開く。テストページが結果を /__report に POST し、
このスクリプトが受け取って表示、失敗があれば終了コード 1 を返す。
ブラウザのプロファイルは一時ディレクトリに作り、終了後に消す。
"""
from __future__ import annotations

import argparse
import functools
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from serve import Handler  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent

CANDIDATES = {
    "chrome": [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "google-chrome", "chromium", "chromium-browser",
    ],
    "edge": [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "microsoft-edge",
    ],
}


def find_browser(pref: str | None) -> str:
    order = [pref] if pref else ["chrome", "edge"]
    for name in order:
        for c in CANDIDATES.get(name, []):
            if os.path.isabs(c) and Path(c).exists():
                return c
            found = shutil.which(c)
            if found:
                return found
    raise SystemExit("Chromium 系ブラウザ（Chrome / Edge）が見つかりません")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--filter", default="")
    ap.add_argument("--browser", choices=["chrome", "edge"])
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--timeout", type=int, default=240)
    ap.add_argument("--json", help="結果を JSON で保存するパス")
    args = ap.parse_args()

    done = threading.Event()
    box: dict = {}

    class ReportHandler(Handler):
        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/__report":
                self.send_error(404)
                return
            n = int(self.headers.get("Content-Length", "0"))
            box["payload"] = json.loads(self.rfile.read(n) or b"{}")
            self.send_response(204)
            self.end_headers()
            done.set()

    port = free_port()
    handler = functools.partial(ReportHandler, directory=str(ROOT))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    httpd.quiet = True  # type: ignore[attr-defined]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    url = f"http://127.0.0.1:{port}/tests/index.html?report=1"
    if args.filter:
        url += "&filter=" + args.filter
    browser = find_browser(args.browser)
    profile = tempfile.mkdtemp(prefix="shizuka-test-")
    cmd = [
        browser,
        f"--user-data-dir={profile}",
        "--no-first-run", "--no-default-browser-check", "--disable-extensions",
        "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
        "--autoplay-policy=no-user-gesture-required", "--mute-audio",
        "--window-size=1200,900",
    ]
    if not args.headed:
        cmd += ["--headless=new", "--disable-gpu"]
    cmd.append(url)
    print(f"browser: {Path(browser).name}\nurl: {url}")
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if not done.wait(args.timeout):
            print("タイムアウト: テスト結果が届きませんでした")
            return 2
    finally:
        proc.terminate()
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            proc.kill()
        httpd.shutdown()
        shutil.rmtree(profile, ignore_errors=True)

    payload = box["payload"]
    results = payload["results"]
    failed = [r for r in results if not r["ok"]]
    for r in results:
        mark = "ok  " if r["ok"] else "FAIL"
        print(f"{mark} [{r['file']}] {r['name']} ({r['ms']}ms)")
        if not r["ok"]:
            print("     " + r["error"].replace("\n", "\n     "))
    if payload.get("errors"):
        print("page errors:", payload["errors"])
    if payload.get("ambienceDb"):
        print("ambience RMS dBFS:", payload["ambienceDb"])
    print(f"\n{len(results) - len(failed)} / {len(results)} passed")
    if args.json:
        Path(args.json).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return 1 if failed or payload.get("errors") else 0


if __name__ == "__main__":
    sys.exit(main())
