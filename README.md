# Study Desk

iPhoneを優先した、個人用・オフライン対応の勉強管理PWA。学習内容はブラウザのIndexedDBに保存。外部送信は初期状態で無効です。

## 起動

Node.js 22.12以上（推奨24）を用意して、展開したフォルダ内で実行します。

```sh
npm ci
npm run dev
```

表示されたlocalhostをPCで開きます。PWAのオフライン動作は本番ビルドで確認してください。

```sh
npm test
npm run build
npx vite preview --host 0.0.0.0
```

iPhoneでは、GitHub PagesなどHTTPSで公開したURLをSafariで開き、共有 → ホーム画面に追加します。PCのlocalhostはiPhoneから直接開けません。

- [利用・公開・バックアップ手順](docs/USER_GUIDE.md)
- [任意の同期設定](docs/SYNC.md)
- [進捗・設計・残課題](PROGRESS.md)
- [独立したQA担当による監査](docs/AUDIT.md)
- [公式条件と依存ライセンス](docs/DEPENDENCIES.md)

## 構成

React / TypeScript / Vite / Dexie / ts-fsrs。データの保存、タイマー、計画、復習、入出力、同期を分離しています。Chart.jsの代わりに軽量なCSS棒グラフを使用しています。MarkdownのHTMLは実行せず、外部画像も自動取得しません。無料OSSのみ使用。有料API・解析トラッカー・CDN読込はありません。

学習対象→科目→単元の3階層。学習記録とノート等は不変ID・版番号を持ちます。競合更新を拒否し、削除は復元可能なゴミ箱へ移動します。IndexedDBの初期スキーマはversion(1)です。変更時はdb.tsの新しいversion().upgrade()を追加し、旧バックアップ形式を維持してください。データ移行のためDBを削除しないでください。

## 更新

変更前にアプリからJSONバックアップを保存。ソースを別フォルダ・別ブランチに保管してから修正し、`npm test`と`npm run build`を実施します。同じ公開URLにdistを配布し、アプリの更新確認に応答してください。URLやブラウザを変えると端末保存先が別になります。保存先を変更する前にJSONを移行してください。

## v1.1の追加

ChatGPTに共有するデータの個別選択・最小化、確認前のコピー防止、選択変更時の再作成要求を追加。公開用HTMLへCSPを埋め込み、外部API通信を初期状態で制限します。同期する版ではビルド前に本人のProject URLを承認します。[追加機能・制限と設定方法](docs/PRIVACY_SECURITY.md)と[追加監査](docs/AUDIT_V1_1.md)を参照。

更新時も公開URLとIndexedDB名を維持し、DB削除や自動上書きはしません。更新前にJSONバックアップを保存してください。今回の配布は別ファイルなので前のZIPも引き続き保管できます。
