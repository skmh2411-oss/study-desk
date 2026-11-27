# ChatGPTとの共通データ交換

設定のChatGPT画面で依頼文を生成し、ChatGPTに貼付します。学習データを含めるチェックは初期無効です。返答は以下のJSON（コードフェンスの外側だけを除いてコピー）をバックアップ画面へ貼付し、検証・プレビュー→追加。追加操作まではDBへ書き込みません。

```json
{
  "format": "study-desk",
  "schemaVersion": 1,
  "records": [
    {
      "kind": "note",
      "title": "要点まとめ",
      "body": "## 原則\n\n## 例外\n\n## 適用条件\n\n## 出典",
      "tags": ["復習"],
      "importance": 3,
      "bookmark": false,
      "source": "",
      "verifiedOn": ""
    },
    {
      "kind": "card",
      "question": "ここに問題",
      "answer": "ここに解答",
      "explanation": "ここに補足",
      "tags": [],
      "importance": 3,
      "source": ""
    }
  ]
}
```

ID・日時・版・FSRS初期状態は省略時に生成します。targetId/subjectId/unitIdは実在IDを使用し、指定しない場合は未分類です。分類する場合は、生成依頼文に含まれるIDをコピーしてください。新しい分類と子要素を同時に作る場合は、親にも固定IDを割り当て、同じバッチに含めてください。

検証処理は `src/validation.ts`、重複・参照検証と追加処理は `src/exchange.ts`。未知のkind/スキーマ・不正な日付/時間・参照先のないID・不正な復習状態は拒否します。既存の同じIDの別内容は上書きしません。法律等の説明内容の真偽はJSON検証では保証できないため、出典・法改正・適用範囲は学習時に別途確認してください。
