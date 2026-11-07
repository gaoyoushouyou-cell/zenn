# Architecture

## 技術選定

| 候補 | 評価 |
|---|---|
| **Web / PWA（採用）** | 配布が容易（URL とホーム画面追加）、オフライン（Service Worker）、Web Audio で鐘の精密な予約、Wake Lock、アクセシビリティ API が成熟。保守とテストが容易 |
| React Native / Flutter | ネイティブのバックグラウンド音声・通知は強いが、ストア配布・ビルド環境・依存が増える。MVP の検証には過剰 |
| Swift / Kotlin | ロック画面で確実に鐘を鳴らすには最良（ROADMAP の「ネイティブ殻」）。2 プラットフォームの二重実装になる |
| Unity / Godot | 3D 表現は不要。起動速度・容量・アクセシビリティで不利 |

### Web の中での選択: 依存ゼロ・ビルド不要の ES Modules
- **フレームワークなし**: 画面は 7 つ、状態は 1 つのセッション。小さな DOM ヘルパー（`ui/dom.js`、innerHTML 不使用）で十分。依存の脆弱性・サプライチェーンの危険がゼロ。
- **TypeScript なし**: 実行環境に Node.js がなかったため、ビルド不要の JS + JSDoc を選んだ。型の代わりに、純粋関数（core）を厚いユニットテストで守る。
- **バンドラーなし**: 約 20 ファイルを Service Worker がすべて保存する。2 回目以降の初回描画は 52ms（Performance.md）。
- **テスト**: Vitest / Playwright の代わりに、ブラウザ内で動く自作ハーネス＋ヘッドレス Chrome / Edge（`tools/test.py`）。実ブラウザの Web Audio（OfflineAudioContext）で環境音の音量まで実測できる。

## ディレクトリと責務

```
index.html            骨組み・CSP・ライブ領域・<dialog>
sw.js                 オフライン（キャッシュ優先）、通知クリック
manifest.webmanifest  PWA
styles/app.css        デザインシステム（トークン）と全スタイル
src/
  main.js             起動（?test では仮想時計を差し込めるよう保留）
  app.js              司令塔: 状態遷移・音・保存・画面切替
  platform.js         Wake Lock・振動・通知・音声合成・省電力推定
  core/               ← DOM に依存しない純粋なロジック（ユニットテスト対象）
    clock.js          補正済み単調時計（スリープ補正・時刻変更耐性）
    session.js        セッションエンジン（区間の積み上げ、イベント、保存/復元）
    settings.js       スキーマ・検証・静寂モード
    storage.js        localStorage ラッパー（容量不足・破損・無効化に耐える）
    history.js        記録（累積・リズム・薄れ・手放す。ストリークなし）
    format.js         残り時間の表示
  i18n/strings.js     日本語・英語（形が一致することをテスト）
  audio/
    bell.js           鐘の加算合成（純粋関数）と打ち方
    ambience.js       生成的環境音（Web Audio グラフ）
    engine.js         AudioContext 管理・予約・二重防止・ダッキング・リミッター
  visual/scene.js     墨と霧の 2D 景色（Canvas）
  ui/dom.js, views.js 画面
tests/                ブラウザ内テスト（unit / e2e / a11y）
tools/                serve / build / check / test / make_icons（Python 標準ライブラリのみ）
```

## 状態遷移

```
          ┌──────────── 復元（途中だった）──── 続ける ───┐
          │                                              ▼
 home ──座る──▶ session[prep] ──鐘──▶ session[sitting] ⇄ session[paused]
  ▲                │   │                    │      │
  │                │   └──── 終える ────────┼──────┤
  │                │                        ▼      ▼
  │                └─────────────────▶ afterglow ──残す／残さず──▶ home
  │                                      │  ▲
  │                                      └──もう少し座る（延長）──▶ session
  └── guide / kinhin / history / settings（どこからでも戻る）
```

- セッションの状態: `running | paused | finished | ended`。相は経過から導く: `prep | sitting | done`。
- 経過 = `elapsedBefore + (running ? now − anchor : 0)`。**tick の回数に依存しない**（setInterval が間引かれても狂わない）。
- `now` は `correctedClock`: performance.now() に、壁時計が 2 秒以上先へ進んだ分（＝単調時計が凍っていたスリープ）を足す。壁時計の後退は無視。
- 保存（5 秒ごと・非表示時・pagehide）: `elapsedBefore` と `checkpointWall`。復元時は閉じていた時間（壁時計の差、0〜7 日に制限）を加える。
- イベント: `dueEvents` は未処理の start / interval / end を返す。5 秒以上遅れた途中の鐘は `silent`（鳴らさず既読）。

## 鐘を確実に鳴らす仕組み
1. 「座る」の操作の中で AudioContext を作り resume（自動再生制限）。
2. 開始時・再開時・延長時・10 秒ごとに、今後の鐘を **音声クロックに予約**（`engine.schedule`）。予約時刻が 0.3 秒以上ずれていれば作り直す。
3. JS 側で終わりを検知したら `engine.ensure(key)`: 予約が既に鳴っていれば何もしない／ずれていれば今鳴らす（二重に鳴らない）。
4. 遅れて既読にする鐘は `cancelIfPending`: 鳴っている最中の鐘を止めない（クリック防止）。
5. 音が出ない（非対応・ブロック・中断）とき: 振動（設定がオフでも終わりだけは）、許可があれば通知、画面の余韻。
6. AudioContext の `interrupted / suspended` → 案内を表示し、画面に触れると resume。running に戻ったら予約を作り直す。
7. 出力先の変更（`devicechange`）→ 環境音だけを 50ms で消し、戻すボタンを出す。

## 異常系の対応表

| 状況 | 対応 | テスト |
|---|---|---|
| バックグラウンド / 画面ロック | 鐘は音声クロック予約。復帰時に即 tick。Wake Lock は可視化で再取得 | e2e「裏に回る」 |
| 再読み込み・タブを閉じて復帰 | 保存から復元し「続けますか」（音の再開に操作が必要なため） | e2e「再読み込み」 |
| 閉じている間に終わった | 鐘を鳴らさず余韻へ「離れている間に終わっていました」。6 時間以上前なら破棄 | e2e「閉じている間に」 |
| 端末時刻の変更 | 単調時計で数える。後退は無視、前進はスリープとして補正 | unit・e2e |
| スリープと復帰 | 補正時計 | unit・e2e |
| Bluetooth 切断 | 環境音を即消音・戻すボタン | 手動（Known issues） |
| 自動再生ブロック・通話などの中断 | 案内表示・触れて復帰・振動/通知の代替 | e2e |
| ネットワーク切断 | Service Worker でアプリ全体をキャッシュ。通信を一切使わない | 実ブラウザでサーバー停止後に起動・開始を確認 |
| 容量不足・保存不可・破損 | メモリで継続、穏やかに一度だけ知らせる、破損データは退避 | unit・e2e |
| 権限拒否（通知） | トグルを戻し「鐘と振動で知らせます」 | 手動 |
| 音源の生成失敗 | 例外を握り、鳴らす時に再計算。AudioContext 不可なら音なしで成立 | unit・e2e |
| Canvas コンテキスト喪失 | `contextlost` で停止、`contextrestored` でキャッシュ再構築 | 手動（Known issues） |
| 低メモリ・低性能 | 省電力推定（コア数・メモリ・Save-Data・電池）で 12fps・低解像度。描画が重いと自動で解像度を下げる | 手動計測 |
| 端末回転 | resize で再構築、縦横で月の位置を調整 | 手動 |
| 文字 200% | rem ベース + 折り返し。横スクロールなしを検査 | e2e |
| キーボードのみ | 全操作が button/input。座禅中は任意キーで操作表示、P で一時停止、Esc で隠す | e2e・a11y |
| スクリーンリーダー | ライブ領域、見出しへのフォーカス移動、ラベル | a11y |
| Reduce Motion | data-motion=reduce で全アニメーション 1ms、景色は静止画を 30 秒ごとに更新 | e2e |

## セキュリティ設計の要点
- CSP: `default-src 'self'; script-src 'self'; style-src 'self'` ほか。インラインスクリプト・style 属性なし（`tools/check.py` で検査）。
- DOM 生成は textContent のみ（innerHTML を静的検査で禁止）。
- 外部 URL・fetch・ビーコンを静的検査で禁止。
- 詳細は ThreatModel.md / Privacy.md。

## 拡張の方針
- 景色はパレット＋描画関数の組なので、テーマを追加しやすい（ROADMAP のテーマシステム）。
- 音は `buildAmbience(ctx, type)` に分岐を足すだけ。音量は `LEVEL` をテストの実測値で調整する。
- ネイティブ殻（Capacitor など）で包む場合も、`core/` は無改造で再利用できる。
