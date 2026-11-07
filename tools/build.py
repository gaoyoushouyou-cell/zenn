"""プロダクションビルド（依存なし）。

    python tools/build.py           # dist/ を作る
    python tools/serve.py --dir dist

- 静的検査（tools/check.py）に通らなければビルドしない
- アプリのファイルを dist/ にコピーする（テストや文書は含めない）
- 内容のハッシュから Service Worker の VERSION を決める（更新時に古いキャッシュを確実に入れ替える）

バンドラーを使わない理由: ES Modules をそのまま配信しても、ファイル数が少なく（約 20）
HTTP/2 と Service Worker のキャッシュで十分に速い。依存ゼロでサプライチェーンの危険もない。
"""
from __future__ import annotations

import hashlib
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
sys.path.insert(0, str(Path(__file__).resolve().parent))
from check import app_files  # noqa: E402


def main() -> int:
    r = subprocess.run([sys.executable, str(ROOT / "tools" / "check.py")])
    if r.returncode != 0:
        print("静的検査に失敗したため、ビルドを中止しました")
        return 1
    files = app_files()
    # OneDrive などの同期フォルダではディレクトリの削除が拒否されることがあるため、
    # dist/ を丸ごと消さず「上書き + 不要になったファイルだけ削除」にする。
    keep = set(files) | {"sw.js"}
    if DIST.exists():
        for p in sorted(DIST.rglob("*"), reverse=True):
            rel = p.relative_to(DIST).as_posix()
            try:
                if p.is_file() and rel not in keep:
                    p.unlink()
                elif p.is_dir() and not any(p.iterdir()):
                    p.rmdir()
            except OSError:
                pass  # 空ディレクトリが残っても配信には影響しない
    h = hashlib.sha256()
    for f in files:
        src = ROOT / f
        dst = DIST / f
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        h.update(f.encode())
        h.update(src.read_bytes())
    sw = (ROOT / "sw.js").read_text(encoding="utf-8")
    h.update(sw.encode())
    version = h.hexdigest()[:10]
    if "const VERSION = 'dev';" not in sw:
        print("sw.js: VERSION の置き換え位置が見つかりません")
        return 1
    (DIST / "sw.js").write_text(sw.replace("const VERSION = 'dev';", f"const VERSION = '{version}';"), encoding="utf-8")
    print(f"built {len(files) + 1} files into {DIST} (sw version {version})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
