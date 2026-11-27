import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db, saveEntity } from "../src/db";
import type { Entity } from "../src/models";
import { applyImport } from "../src/exchange";
import {
  extractCandidates,
  prepareBulk,
  duplicateCandidateIds,
  trashImportBatch,
  type BulkSettings,
} from "../src/bulk";
const settings: BulkSettings = {
  kind: "card",
  targetId: "",
  subjectId: "",
  unitId: "",
  cardType: "auto",
  importance: 3,
  source: "架空資料",
  sourceUrl: "",
  asOf: "",
};
beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});
describe("bulk extraction and approved storage", () => {
  it("retains citation location, flags source rules, and supports atomic reversible batch undo", async () => {
    const { referenceInstructions } = await import("../src/references");
    expect(referenceInstructions([])).toContain("登録外資料を使用");
    expect(referenceInstructions([])).toContain("使用理由");
    const raw = JSON.stringify({
      cards: [
        {
          question: "根拠の確認",
          answer: "答え",
          citations: [
            {
              url: "https://example.com/source",
              locator: "第1条",
              asOf: "2026-11-27",
              checkedOn: "2026-11-27",
            },
          ],
        },
      ],
    });
    const p = await prepareBulk(extractCandidates(raw, settings), settings);
    expect((p.records[0].citations as any[])[0]).toMatchObject({
      locator: "第1条",
      asOf: "2026-11-27",
      checkedOn: "",
    });
    await applyImport(p);
    const snapshot = await db.records.toArray();
    const changed = await saveEntity(
      { ...snapshot[0], tags: ["変更"] },
      snapshot[0].version,
    );
    await expect(trashImportBatch(snapshot)).rejects.toThrow("変更");
    expect((await db.records.get(changed.id))?.deletedAt).toBeUndefined();
    await trashImportBatch([changed]);
    expect((await db.records.get(changed.id))?.deletedAt).toBeTruthy();
    expect((await db.records.get(changed.id))?.answer).toBe("答え");
  });
  it("keeps QA pairs, formulas and numerical conditions without invention", () => {
    const rows = extractCandidates(
      "Q: 用語の意味は？\nA: 用語の定義\n割合 = 部分 ÷ 全体 × 100\n上限：30日以内（申込日から）\n判読できない行",
      settings,
    );
    expect(rows).toHaveLength(4);
    expect(rows[0].answer).toBe("用語の定義");
    expect(rows[1].cardType).toBe("formula");
    expect(rows[2].cardType).toBe("number");
    expect(rows[2].answer).toBe("30日以内（申込日から）");
    expect(rows[3].answer).toBe("");
    expect(rows[3].selected).toBe(false);
  });
  it("parses quoted multiline CSV, TSV headers, importance and choice arrays", () => {
    const rows = extractCandidates(
      'question,answer,importance,conditions\n"問題,引用","答え\n2行",5,"適用条件"',
      settings,
    );
    expect(rows[0].question).toBe("問題,引用");
    expect(rows[0].answer).toBe("答え\n2行");
    expect(rows[0].importance).toBe(5);
    const tsv = extractCandidates("問題\t答え\n問\t答", settings);
    expect(tsv[0].answer).toBe("答");
    const q = extractCandidates(
      '{"questions":[{"question":"正しい？","answer":"○","choices":["○","×"]}]}',
      { ...settings, kind: "question" },
    );
    expect(q[0].choices).toEqual(["○", "×"]);
  });
  it("does not lose an unanswered Q when the next question begins", () => {
    const rows = extractCandidates(
      "Q: 未回答\nQ: 次の問題\nA: 次の答え",
      settings,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].selected).toBe(false);
  });
  it("drops model IDs, histories, confirmation claims and private arbitrary fields", async () => {
    const rows = extractCandidates(
      JSON.stringify({
        cards: [
          {
            id: "unsafe",
            question: "問",
            answer: "答",
            history: [1],
            password: "hidden",
            sourceStatus: "verified",
          },
        ],
      }),
      settings,
    );
    expect(rows[0].originalText).not.toContain("hidden");
    const p = await prepareBulk(rows, settings);
    expect(p.records[0].id).not.toBe("unsafe");
    expect(p.records[0].sourceStatus).toBe("extracted");
    expect(p.records[0].password).toBeUndefined();
    expect(await db.records.count()).toBe(0);
  });
  it("saves only selected candidates and deduplicates concurrent commits", async () => {
    const rows = extractCandidates(
      "問題1\t答え1\n問題2\t答え2\n問題1\t答え1",
      settings,
    );
    expect(duplicateCandidateIds(rows).size).toBe(1);
    rows[1].selected = false;
    const p = await prepareBulk(rows, settings);
    expect(p.records).toHaveLength(1);
    const results = await Promise.all([applyImport(p), applyImport(p)]);
    expect(results.reduce((n, x) => n + x.added, 0)).toBe(1);
    expect(await db.records.count()).toBe(1);
    expect((await prepareBulk(rows, settings)).records).toHaveLength(0);
  });
  it("keeps distinct flashcards from one source question, but prevents duplicate exercise IDs", async () => {
    const data = JSON.stringify({
      questions: [
        {
          question: "正しい？",
          answer: "○",
          choices: ["○", "×"],
          sourceUrl: "https://example.com/q/1",
          sourceQuestionId: "1",
          importance: 5,
        },
      ],
    });
    const qsetting = { ...settings, kind: "question" as const };
    const p = await prepareBulk(extractCandidates(data, qsetting), qsetting);
    await applyImport(p);
    expect((await db.records.toArray())[0].importance).toBe(5);
    const changed = data.replace("正しい？", "文面変更");
    const again = await prepareBulk(
      extractCandidates(changed, qsetting),
      qsetting,
    );
    expect(again.records).toHaveLength(0);
    expect(again.conflicts).toBe(1);
    const p1 = await prepareBulk(
      extractCandidates(
        data.replace('1"', '2"').replace("正しい？", "別問"),
        qsetting,
      ),
      qsetting,
    );
    const p2 = await prepareBulk(
      extractCandidates(
        data.replace('1"', '2"').replace("正しい？", "別文面"),
        qsetting,
      ),
      qsetting,
    );
    await Promise.all([applyImport(p1), applyImport(p2)]);
    expect(await db.records.count()).toBe(2);
  });
  it("removes verified status after answer changes, while FSRS review metadata stays valid", async () => {
    const card = await saveEntity({
      kind: "card",
      question: "問",
      answer: "答",
      sourceStatus: "verified",
      citations: [
        {
          url: "https://example.com",
          locator: "p.1",
          asOf: "",
          checkedOn: "2026-11-27",
        },
      ],
    });
    const edited: Entity = await saveEntity(
      { ...card, answer: "新しい答" },
      card.version,
    );
    expect(edited.sourceStatus).toBe("unverified");
    expect((edited.citations as any[])[0].checkedOn).toBe("");
    const verified = await saveEntity(
      { ...edited, sourceStatus: "verified" },
      edited.version,
      { verifySource: true },
    );
    const unchanged = await saveEntity(
      { ...verified, tags: ["確認"] },
      verified.version,
    );
    expect(unchanged.sourceStatus).toBe("verified");
  });
  it("rejects invalid, mixed, oversized and malformed choice inputs", async () => {
    expect(() => extractCandidates("{bad", settings)).toThrow("JSON");
    expect(() => extractCandidates("x".repeat(500001), settings)).toThrow();
    expect(() =>
      extractCandidates(Array(101).fill("項目: 答え").join("\n"), settings),
    ).toThrow("100");
    expect(() =>
      extractCandidates('{"records":[{"kind":"note"}]}', settings),
    ).toThrow("混在");
    const p = extractCandidates("Q: 問\nA: 答", settings);
    p[0].answer = "";
    await expect(prepareBulk(p, settings)).rejects.toThrow();
    expect(await db.records.count()).toBe(0);
  });
});
