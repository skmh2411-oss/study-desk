# 公開・進捗記録（2026-11-27）

このファイルは、公開前に作成したPROGRESS.mdの「未公開」という状態を更新する追加記録です。

## 利用先

- アプリ：https://skmh2411-oss.github.io/study-desk/
- ソース：https://github.com/skmh2411-oss/study-desk
- 現在の工程：Phase 6、GitHub Pages公開と利用準備。
- 初回公開：GitHub Actions #1（45993356480）で61テスト・本番ビルド・配置が成功。HTTPSの実URLでホーム、ノート画面、ChatGPT共有0件、CSPを確認。
- アプリのソース、テスト、利用手順、SQL、公開ワークフローを配置。既存の別リポジトリには変更なし。

## プライバシー

公開するのはプログラムです。個人の学習記録、バックアップ、秘密鍵、パスワード、実際の環境設定ファイルは含めません。
この配布はSupabaseの接続先を設定しておらず、CSPのconnect-srcはselfのみです。学習データはアクセスした端末のIndexedDBに保存されます。
他人が同じURLを開いても、あなたの学習データは表示されません。ただし端末・ブラウザを他人に操作される場合の本人認証やデータ暗号化はありません。
アクセス時のIP等は配信事業者が処理します。ChatGPTへは選択した内容を利用者がコピーして送ります。

## v1.1.1：公開時の依存監査による修正

- GitHubのnpm ciで開発用依存に7件（Critical 2、Moderate 5）を検出。実行用依存は0件。
- テスト用Vitestを5.1.2に更新し、workbox-buildのglobのみ14.0.6に限定。修正前ソースとZIPは維持した別作業コピーで実施。
- アプリ機能のソース・データ構造は変更なし。変更はpackage.jsonとpackage-lock.json。
- 更新後：61/61テスト成功、TypeScript・Vite本番ビルド成功、Service Worker生成成功。
- npm audit：実行用と開発用を含め0件（2026-11-27時点）。将来の安全性を保証する数値ではありません。
- 公式参考：https://github.com/advisories/GHSA-5gmw-xhrv-c9v3 、https://github.com/advisories/GHSA-85c8-ppgw-ccpr

## iPhoneとPC

1. iPhoneのSafariでアプリURLを開く。
2. 共有メニューから「ホーム画面に追加」。追加したアイコンで起動する。
3. 初回はオンラインで読み込みを完了させる。以後の基本機能は端末内で利用する。
4. PCは同じURLをEdge/Chromeで開く。同期は初期無効なので、端末間の移動はJSONバックアップと追加インポートを使う。

SafariのWebサイトデータ消去、端末故障などに備え、設定→バックアップから定期的にJSONを書き出してください。バックアップは平文なので保管先に注意してください。

## 残課題

- iPhone実機のインストール、Safari終了・復帰、実機オフラインは未検証。以前のブラウザによる配信停止テストと区別する。
- 実Supabaseの認証・RLS・二端末同期は未検証/未接続。利用には本人によるプロジェクト作成と設定が必要。
- 本人ロック・暗号化バックアップ・E2E暗号化は未実装。
- P3：Actionsの旧Nodeターゲット警告（GitHubがNode24で実行し、公開は成功）。ビルドのMarkdown/数式チャンク循環警告。今後の保守で確認。
- 既存のAUDIT/TEST_RESULTSは初回版の検証履歴。公開時の追加結果はこの記録を参照。

## 更新手順と費用

変更前にアプリからバックアップ。ソースの変更は別ブランチで行い、npm ci、npm test、npm run buildを確認する。GitHubのActions→Deploy Study Desk to GitHub Pages→Run workflowでmainを指定して公開する。自動push公開は設定していない。

公開リポジトリとGitHub Pagesの標準機能で追加月額0円。独自ドメイン、有料API、外部解析、課金サービスは使わない。GitHubの無料枠や条件は将来変わり得る。Supabaseは今回未使用。
