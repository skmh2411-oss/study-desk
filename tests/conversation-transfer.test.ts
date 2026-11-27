import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db, saveEntity } from "../src/db";
import { createBackup, previewImport, applyImport } from "../src/exchange";
import {
  buildConversationPrompt,
  parseLearningPackage,
  previewLearningImport,
} from "../src/conversationTransfer";
const scope = { targetId: "", subjectId: "", unitId: "" };
const card = {
  kind: "card",
  question: "単位を確認するときに照合するものは？",
  answer: "数値と単位",
  originalText: "数値と単位を一緒に確認する。",
  importance: 4,
};
const note = {
  kind: "note",
  title: "照合の手順",
  body: "# 結論\n\n| 項目 | 確認 |\n|---|---|\n| 数字 | 原文 |\n\n$x^2$",
  originalText: "原文を照合する。",
  importance: 3,
};
const question = {
  kind: "question",
  question: "数値と単位は一緒に確認する。正しいか？",
  answer: "○",
  choices: ["○", "×"],
  originalText: "数値と単位を一緒に確認する。",
  importance: 5,
};
const packet = (items: unknown[]) =>
  JSON.stringify({ format: "study-desk-learning", schemaVersion: 1, items });
beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});
describe("conversation material roundtrip", () => {
  it("generates a conversation-aware prompt with source, correction and external-site rules", () => {
    const p = buildConversationPrompt(
      ["note", "card", "question"],
      20,
      "計算式を優先",
      "登録外の使用理由を明記",
    );
    expect(p).toContain("この会話");
    expect(p).toContain("最終的な訂正");
    expect(p).toContain("study-desk-learning");
    expect(p).toContain("originalText");
    expect(p).toContain("登録外の使用理由");
    expect(p).toContain("解説は原則不要");
    expect(() => buildConversationPrompt([], 20, "", "")).toThrow();
    expect(() => buildConversationPrompt(["note"], 101, "", "")).toThrow();
  });
  it("imports mixed notes, flashcards and exercises only after explicit apply", async () => {
    const drafts = parseLearningPackage(packet([card, note, question]));
    const p = await previewLearningImport(drafts, scope);
    expect(await db.records.count()).toBe(0);
    expect(p.records).toHaveLength(3);
    await applyImport(p);
    const saved = await db.records.toArray();
    expect(saved.map((r) => r.kind).sort()).toEqual([
      "card",
      "note",
      "question",
    ]);
    expect(saved.find((r) => r.kind === "note")?.body).toBe(note.body);
    expect(saved.find((r) => r.kind === "card")?.history).toEqual([]);
  });
  it("preserves numerical units and conditions alongside original evidence", async () => {
    const d = parseLearningPackage(
      packet([
        {
          ...card,
          question: "架空ルールで条件Aの期限は？",
          answer: "起算日から30日以内",
          cardType: "number",
          answerUnit: "日",
          conditions: "条件Aのみ。条件Bは対象外。",
          originalText: "条件Aは起算日から30日以内。条件Bは対象外。",
        },
      ]),
    );
    const p = await previewLearningImport(d, scope);
    expect(p.records[0]).toMatchObject({
      answerUnit: "日",
      conditions: "条件Aのみ。条件Bは対象外。",
      sourceStatus: "unverified",
    });
  });
  it("does not import IDs, private arbitrary fields, histories, source verification or preferences", async () => {
    const d = parseLearningPackage(
      packet([
        {
          ...card,
          id: "old",
          history: [{ rating: 4 }],
          fsrs: { reps: 999 },
          sourceStatus: "verified",
          password: "secret",
          citations: [
            { url: "https://example.com/ref", checkedOn: "2026-11-27" },
          ],
        },
      ]),
    );
    expect(d[0].record.id).not.toBe("old");
    expect(d[0].record.history).toEqual([]);
    expect(d[0].record.password).toBeUndefined();
    expect(d[0].record.sourceStatus).toBe("unverified");
    expect((d[0].record.citations as any[])[0].checkedOn).toBe("");
    await applyImport(await previewLearningImport(d, scope));
    expect(await db.settings.count()).toBe(0);
  });
  it("selects only approved material types and preserves scope chosen in the app", async () => {
    const t = await saveEntity({ kind: "target", title: "架空対象" });
    const s = await saveEntity({
      kind: "subject",
      title: "架空科目",
      targetId: t.id,
    });
    const d = parseLearningPackage(packet([card, note, question]));
    d[0].selected = false;
    d[2].selected = false;
    const p = await previewLearningImport(d, {
      targetId: t.id,
      subjectId: s.id,
      unitId: "",
    });
    expect(p.records).toHaveLength(1);
    expect(p.records[0]).toMatchObject({
      kind: "note",
      targetId: t.id,
      subjectId: s.id,
    });
  });
  it("deduplicates a repeated conversation package without overwriting the saved content", async () => {
    await applyImport(
      await previewLearningImport(
        parseLearningPackage(packet([card, note, question])),
        scope,
      ),
    );
    const second = await previewLearningImport(
      parseLearningPackage(packet([card, note, question])),
      scope,
    );
    expect(second.records).toHaveLength(0);
    expect(second.duplicates).toBe(3);
    expect(await db.records.count()).toBe(3);
  });
  it("rechecks duplicates atomically when two previews are saved together", async () => {
    const a = await previewLearningImport(
        parseLearningPackage(packet([note, card])),
        scope,
      ),
      b = await previewLearningImport(
        parseLearningPackage(packet([note, card])),
        scope,
      );
    const results = await Promise.all([applyImport(a), applyImport(b)]);
    expect(results.reduce((n, r) => n + r.added, 0)).toBe(2);
    expect(await db.records.count()).toBe(2);
  });
  it("retains note evidence in backups and restoration previews", async () => {
    await applyImport(
      await previewLearningImport(parseLearningPackage(packet([note])), scope),
    );
    const backup = await createBackup();
    await db.records.clear();
    const p = await previewImport(backup);
    expect(p.records[0].originalText).toBe(note.originalText);
    expect(p.records[0].sourceStatus).toBe("unverified");
  });
  it("imports a Markdown file as one note without stripping code fences", () => {
    const body = '```json\n{"key":"value"}\n```';
    const d = parseLearningPackage(body, "会話メモ.md");
    expect(d[0].record.body).toBe(body);
    expect(d[0].record.title).toBe("会話メモ");
  });
  it("accepts fenced JSON and rejects ordinary conversation text", () => {
    expect(
      parseLearningPackage("```json\n" + packet([note]) + "\n```"),
    ).toHaveLength(1);
    expect(() =>
      parseLearningPackage("会話の本文から適当に分割してほしい"),
    ).toThrow("JSON");
  });
  it("rejects meaningless stems, invalid answers and empty notes", () => {
    for (const invalid of [
      { ...question, question: "次の記述の正誤を答えなさい。" },
      { ...question, answer: "別の答え" },
      { ...note, title: "" },
      { ...note, body: "" },
      { ...card, importance: 1.5 },
    ])
      expect(() => parseLearningPackage(packet([invalid]))).toThrow();
  });
  it("refuses record types outside the material contract, unsafe URLs and huge inputs", () => {
    expect(() =>
      parseLearningPackage(packet([{ kind: "target", title: "不正" }])),
    ).toThrow();
    expect(() =>
      parseLearningPackage(
        packet([{ ...card, sourceUrl: "javascript:alert(1)" }]),
      ),
    ).toThrow();
    expect(() => parseLearningPackage("x".repeat(500001))).toThrow();
    expect(() => parseLearningPackage(packet(Array(101).fill(note)))).toThrow();
  });
});
