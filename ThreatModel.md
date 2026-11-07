# ThreatModel

## 資産
1. 内省の記録（タグ・ひとこと）— 心の状態を含むセンシティブな情報
2. 利用の痕跡（いつ・どれだけ座ったか）
3. 体験の完全性（座禅中に意図しない音・通知・操作が起きないこと）

## 信頼境界
- アプリは静的ファイルのみ。サーバー側の処理・API・アカウントはない。
- データは端末の localStorage にだけある（オリジン単位で分離）。

## 脅威と対策（STRIDE を簡略化）

| 脅威 | 例 | 対策 | 残るリスク |
|---|---|---|---|
| XSS による記録の窃取 | ひとこと欄に `<script>` を書く／悪意ある保存データ | DOM は textContent でのみ生成（innerHTML 禁止を静的検査）。CSP `script-src 'self'`、インラインスクリプト・style 属性なし | 配信サーバーが改ざんされた場合は防げない（HTTPS と配信基盤に依存） |
| 外部への送信 | 解析・広告 SDK・フォント CDN による漏えい | 依存ゼロ。外部 URL・fetch・ビーコンを静的検査で禁止。CSP `connect-src 'self'` | — |
| 端末の共有・覗き見 | 家族が記録を見る | ひとことは折りたたみ表示。全削除・自動で手放す設定 | 端末のロックはユーザー次第。localStorage は暗号化されない（OS のストレージ暗号化に依存） |
| 改ざん・破損データ | 壊れた JSON、型の違う値 | すべての読み込みを検証し既定値へ。壊れたデータは退避（`.corrupt`） | — |
| サプライチェーン | npm パッケージの乗っ取り | 依存パッケージなし。ツールは Python 標準ライブラリのみ | ブラウザ自体の脆弱性 |
| Service Worker の汚染 | 古い／不正なキャッシュの固定化 | ビルドごとに内容ハッシュでバージョンを変え、古いキャッシュを削除。同一オリジンの GET のみ扱う | — |
| 通知による情報漏えい | ロック画面に感情が出る | 通知は「時間が終わった」だけ | — |
| クリックジャッキング | 他サイトに埋め込まれて誤操作 | 配信時に `frame-ancestors 'none'`（HTTP ヘッダー）を推奨（meta CSP では効かない）。README に記載 | 配信側の設定に依存 |
| 体験の妨害 | 予期しない大音量 | リミッター、出力先変更時の環境音停止、音量の上限 | OS 側の音量 |
| ログへの漏えい | console に記録内容 | console.log を静的検査で禁止 | — |

## 依存関係の監査
- 実行時依存: 0。開発時依存: Python 3 標準ライブラリ、Chromium 系ブラウザ（テスト用）。
- 「依存関係の脆弱性確認」は対象がないため、静的検査で「外部 URL・通信 API がない」ことの確認に置き換えた。

## 配信時の推奨 HTTP ヘッダー
```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
Permissions-Policy: camera=(), microphone=(), geolocation=(), screen-wake-lock=(self)
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
Strict-Transport-Security: max-age=31536000
```
