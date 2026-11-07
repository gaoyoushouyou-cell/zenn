# しずか — 座禅の時間

開いて一度触れれば座り始められ、あとは画面を見なくても鐘が始まりと終わりを告げ、終わったら静かに日常へ戻れる座禅アプリ（PWA）。
アカウント・広告・解析・通信なし。すべて端末の中だけで動きます。

> このアプリは医療機器ではありません。病気の診断・治療を目的としていません。

## 主要機能
- **すぐ座る**: 起動 → 「座る」1 回。前回の時間・音・景色を復元。5 / 10 / 20 / 30 分・自由（1〜240 分）・終わりを決めない
- **鐘**: 合成した鏧（低く長い）／鈴（高く澄んだ）。始め三つ・終わり一つ（伝統）または一つずつ。途中の鐘（5〜30 分ごと）
- **正確で中断に強いタイマー**: 基準時刻の差分で数え、スリープ・端末時刻の変更・バックグラウンド・再読み込みに耐える。鐘は音声クロックに先行予約
- **一時停止・延長・途中で終える**（責めない）、終了後の「もう少し座る」
- **静寂モード**: 景色・環境音・残り時間・字幕を消し、鐘だけで座る
- **環境**: 墨と霧の 2D の景色（時刻と実際の月相に連動、毎日わずかに違う山並み）、雨・雪、闇。環境音（雨・風・波・川）
- **はじめての座禅**: 安全 → 座る場所（床・椅子・立つ・横になる）→ 背すじ → 手 → 目 → 呼吸 → 考え。5 分の案内付き座禅（字幕・任意の読み上げ）
- **経行（歩く座禅）**: 座り続けるのがつらい日に
- **余韻**: 終わったあと 20 秒の静かな時間。記録は任意で、「残さずに終える」を同じ重さで
- **記録**: 累積と最近 4 週間のリズムだけ（ストリークなし）。古い記録は薄れ、任意で手放す。書き出し・全削除
- **アクセシビリティ**: キーボード、スクリーンリーダー、文字 200%、高コントラスト、Reduce Motion、明暗テーマ、日本語/英語
- **オフライン**: Service Worker がアプリ全体を保存

## 採用技術
依存ゼロの Web（HTML / CSS / ES Modules）、Web Audio API（鐘の加算合成・生成的環境音・先行予約）、Canvas 2D、Service Worker、Screen Wake Lock、localStorage。
開発ツールは Python 3 標準ライブラリのみ（サーバー・ビルド・静的検査・テストランナー）。テストはブラウザ内ハーネス＋ヘッドレス Chrome/Edge。
選定理由は [Architecture.md](Architecture.md)。

## 起動方法
必要なもの: Python 3.9 以上、Chrome または Edge（テスト時）。
```
python tools/serve.py
```
→ <http://127.0.0.1:5173/> を開く。localhost は安全なコンテキストなので、Service Worker と Wake Lock も動きます。
（`file://` で直接開くと ES Modules と Service Worker が動きません。）

## ビルド方法
```
python tools/build.py           # 静的検査 → dist/ を作成（SW のバージョンは内容ハッシュ）
python tools/serve.py --dir dist --port 5174
```
`dist/` を任意の静的ホスティング（HTTPS）に置けば配信できます。推奨 HTTP ヘッダーは [ThreatModel.md](ThreatModel.md)。

## テスト方法
```
python tools/check.py           # 静的検査
python tools/test.py            # 96 件（ユニット・音声・E2E・アクセシビリティ）
python tools/test.py --browser edge
```
詳細は [TestPlan.md](TestPlan.md)。ブラウザで `/tests/index.html` を開いても実行できます。

アイコンを作り直す場合: `python tools/make_icons.py`

## 環境変数
ありません（設定はすべてアプリ内、端末内に保存）。

## ディレクトリ構造
```
index.html, sw.js, manifest.webmanifest
styles/app.css            デザインシステム
src/main.js, app.js       起動・司令塔
src/core/                 時計・セッション・設定・保存・記録（純粋関数）
src/audio/                鐘の合成・環境音・音声エンジン
src/visual/scene.js       景色
src/ui/                   画面
src/i18n/strings.js       日本語・英語
icons/                    アイコン
tests/                    テスト（harness・unit・e2e）
tools/                    serve / build / check / test / make_icons
*.md                      設計文書
```

## 既知の制約
- **画面ロック中の鐘**: Web の制約上、画面が消えると鐘が鳴らない端末があります（特に iOS）。既定で「座っている間は画面を消さない」（暗いまま）を有効にし、端末を伏せて置けるようにしています。確実性が必要な場合はネイティブ殻が必要です（ROADMAP P0）。
- iOS Safari で AudioContext が `interrupted` のまま戻らない不具合が報告されています。その場合は画面に触れて復帰、または振動・通知・画面で終わりを知らせます。
- バックグラウンドの通知は、ブラウザがページを止めると遅れることがあります（iOS の Web は特に）。
- 実機（iOS / Android）、Firefox / Safari、実機スクリーンリーダーでの検証は未実施。テストは Windows の Chrome / Edge で実施。
- Bluetooth 切断の検知（`devicechange`）はブラウザによって発火しないことがあります。
- 鐘・環境音の音色は数値（クリック・音量・減衰）で検証済みですが、聴感評価は未実施です。
- 端末時刻を「未来へ」大きく進めると、スリープと区別できずセッションが早く終わります（過去へ戻す変更には影響されません）。

## アクセシビリティ
WCAG 2.2 AA を目標。詳細は [Accessibility.md](Accessibility.md)。座禅中は任意のキーで操作表示、**P** で一時停止、**Esc** で隠す。「残り時間を聞く」で端末の音声合成が読み上げ、画面にも数秒表示します。

## プライバシー
送信ゼロ・アカウントなし・解析なし。記録と設定は端末の中だけ。いつでも書き出し・削除できます。詳細は [Privacy.md](Privacy.md)、[ThreatModel.md](ThreatModel.md)。

## 今後の拡張
[ROADMAP.md](ROADMAP.md)。

## 文書
[Research.md](Research.md) · [ProductBrief.md](ProductBrief.md) · [Architecture.md](Architecture.md) · [DesignSystem.md](DesignSystem.md) · [Accessibility.md](Accessibility.md) · [Privacy.md](Privacy.md) · [ThreatModel.md](ThreatModel.md) · [Performance.md](Performance.md) · [TestPlan.md](TestPlan.md) · [ROADMAP.md](ROADMAP.md) · [LICENSES.md](LICENSES.md)
