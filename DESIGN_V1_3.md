# v1.3 共通設計・進捗

既存版を変更せず最新GitHubから別checkout。ホーム相談入口、ローカルOCR、共通一括カード/問題作成、科目/重要度/選択、出典レジストリ。外部サイト巡回や有料APIは実装しない。

## 共通契約

- CardType = qa | formula | number。旧カードはqa扱い。
- カード/問題の任意フィールド: cardType, answerUnit:string, conditions:string, originalText:string, sourceUrl:string, sourceQuestionId:string, sourceStatus:extracted|unverified|verified, citations:Citation[], batchId:string。既存FSRS/履歴を保持。
- Citation = { url:string, locator:string, asOf:string, checkedOn:string }。日付空文字可、URLはhttp(s)のみ。画像本体はDBに入れない。
- ReferenceSite = { id,name,url,targetId,priority,asOf,createdAt,updatedAt,version,deletedAt? }。targetId空は全対象、priorityは1〜99、asOfは日付または空。
- db.referenceSites はDexie version2で追加（既存tableを消さない）。バックアップにはoptional referenceSitesを追加、旧schemaVersion1も引続き読込。既存設定/既存参照サイトの無断上書きなし。参照サイトは今回クラウド同期しない。
- references.ts pure helpers: normalizeReferenceSite(raw), citationSiteStatus(url, sites, targetId?) => registered|external|missing, referenceInstructions(sites,targetId?) => string。登録はURL hostの完全一致＋指定path配下、悪意あるsuffixを認めない。
- OCR API: recognizeImages(files: File[], options:{onProgress:(message:string)=>void,signal?:AbortSignal}) => Promise<{name:string,text:string}[]>。5枚まで・各10MBまで、順番に処理。自己配信assetsのみ、外部送信なし、キャンセル時worker終了。WASM用最小CSP変更のみ。
- 生成候補は100件まで。候補は選択/編集/警告を表示し、未承認ではDBを変更しない。CSV/JSON/TSV/印刷テキスト対象。数式/数値は推論せず元資料から抽出。未知入力はQA候補として要確認。
- ホームにGPT相談・一括カード作成・問題取り込み。共通作成画面を再利用。

## 担当
主担当: App.tsx, Learning.tsx, ChatGPTPanel/promptSharing/cardAssist.ts, 新BulkStudio.tsx/bulk.ts/ReferenceManager.tsx/style、統合。
データ担当: models.ts, db.ts, validation.ts, exchange.ts, references.ts、データテスト。
OCR担当: ocr.ts, scripts/prepare-ocr.mjs, package.json/package-lock.json, security.ts, vite.config.ts, OCR assets/license。
独立QA: 統合後コードとテストを監査。

## 完了記録（2026-11-27）
- 実装・統合・ローカル検証完了。公開反映を実施する工程。詳細は UPDATE_V1_3.md。
- 95/95自動テスト、本番ビルド、配信停止後の起動と日本語OCR、中止復帰を確認。
- 開発担当とは別のデータ担当が移行等10テストを実施。最終統合監査は主担当が担当切替で実施し、独立した第三者監査とはしない。
- 既知P0/P1なし（確認範囲）。iPhone実機、Safari、クラウド同期への新メタデータ反映は未検証。
- 初回読込にOCRを含む約9.6MiB。素材の画像本体はDBへ保存しない。参照サイトは今回端末内・バックアップのみ。
- 今後: iPhone実機OCR/メモリ確認、必要なら参照サイトの競合対応付き同期。

## 公開完了（2026-11-27 22:20 JST）
公開URL: https://skmh2411-oss.github.io/study-desk/
GitHub Actions run 46006112539: build/deploy成功、95/95テスト成功。対象コード: fb74924397c0f49a84518bb957464b83f01294c1。アップロード27ファイルはローカル検証版とバイト一致を確認。公開URLで旧版の更新確認から新版へ切り替わり、ホームの4入口、日本語画像OCR完了、2件の候補作成を確認。公開版の検証では架空画像のみ使い、DBへの保存はしていない。
現在工程: v1.3の実装・検証・公開完了。次の作業: iPhone実機で画像読み取りとオフライン利用を確認。残課題・未検証事項は上記の通り。
既存ワークフローのNodeランタイム非推奨警告、既存Markdown/数式チャンクの循環警告は非阻害（P3）として記録。今回のデプロイは成功しており、ワークフロー世代更新は別の保守作業とする。
