# 無料運用・依存関係の確認

確認日：2026-11-27。採用したnpm版はpackage-lock.jsonに固定。インストール済みパッケージのpackage.jsonのlicenseも照合しました。

- React / React DOM、Vite、TypeScript、ts-fsrs、React Markdown、KaTeX、Supabase JS、Lucide等：MIT等の無料OSS。
- Dexie：Apache-2.0。Dexie Cloudの有料サービスは使用しません。
- グラフ：CSS/HTMLで自前表示。追加ライブラリ不要。
- GitHub FreeのPages：公開ソースリポジトリを使用。アプリ本体とソースは公開されます。端末内の学習データ、バックアップ、秘密キーをリポジトリへ入れないでください。学習データはアプリの配布物に含まれません。公開サイトのサイズ上限1GB、帯域のソフト制限100GB/月。サイトアクセス時のIP等はホスティング提供者のログ対象です。
- Supabaseは任意：Freeでデータベース500MB。低活動が7日続くと休止対象。Freeのまま使い、有料プランへアップグレードしないでください。上限到達や休止時でも端末内で学習を続けられます。
- ChatGPTは既存契約・利用枠を使用。API課金なし。プロンプト生成と手動取り込みのみ。

一次資料：

- https://github.com/dexie/Dexie.js/blob/master/LICENSE
- https://github.com/open-spaced-repetition/ts-fsrs/blob/main/LICENSE
- https://github.com/facebook/react/blob/main/LICENSE
- https://github.com/vitejs/vite/blob/main/packages/vite/LICENSE.md
- https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages
- https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
- https://supabase.com/pricing
- https://supabase.com/docs/guides/platform/free-project-pausing
- https://supabase.com/docs/guides/database/postgres/row-level-security

無料枠・利用条件は提供元が変更する可能性があります。公開時に再確認してください。個人の学習管理用途での月額追加費用は0円の構成ですが、すべてのサービスの無制限・永久無料を保証するものではありません。
