import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db, getPreferences, saveEntity, setPreferences } from "../src/db";
import { applyImport, createBackup, previewImport } from "../src/exchange";
import {
  parseLearningPackage,
  previewLearningImport,
  missingEvidenceCount,
  resolveLearningScope,
  applyLearningImport,
} from "../src/conversationTransfer";
import { decodeLearningBytes } from "../src/learningFormats";
import { normalizePreferences } from "../src/validation";
import { buildStudyPrompt } from "../src/promptSharing";
const scope = { targetId: "", subjectId: "", unitId: "" };
const card = { question: "式の確認対象は？", answer: "数値・単位・適用条件" };
beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe("import compatibility and safety", () => {
  it("imports the previously supplied cards envelope without inventing original evidence or losing LaTeX", async () => {
    const answer = "$$\n\\frac{x+y}{z}\\times100\n$$";
    const drafts = parseLearningPackage(
      JSON.stringify({
        type: "flashcards",
        version: 1,
        subject: "架空科目",
        cards: Array.from({ length: 15 }, (_, i) => ({
          question: `式${i}を確認するには？`,
          answer,
          importance: 3,
        })),
      }),
    );
    expect(drafts).toHaveLength(15);
    expect(drafts[0].record).toMatchObject({
      answer,
      originalText: "",
      sourceStatus: "unverified",
    });
    expect(missingEvidenceCount(drafts)).toBe(15);
    await expect(previewLearningImport(drafts, scope)).rejects.toThrow("原文");
    expect(await db.records.count()).toBe(0);
    const preview = await previewLearningImport(drafts, scope, true);
    expect(preview.warnings.join(" ")).toContain("15件");
    expect(await db.records.count()).toBe(0);
    expect((await applyImport(preview)).added).toBe(15);
    expect(
      (await db.records.toArray()).every(
        (r) => r.originalText === "" && r.sourceStatus === "unverified",
      ),
    ).toBe(true);
    const again = await previewLearningImport(drafts, scope, true);
    expect(again.duplicates).toBe(15);
    expect(again.records).toHaveLength(0);
  });
  it.each([
    JSON.stringify([card]),
    JSON.stringify({ cards: [card] }),
    JSON.stringify({
      format: "study-desk",
      schemaVersion: 1,
      records: [{ kind: "card", ...card }],
    }),
    JSON.stringify({
      format: "study-desk-learning",
      schemaVersion: 1,
      items: [{ kind: "card", ...card }],
    }),
    JSON.stringify({ front: card.question, back: card.answer }),
    JSON.stringify([{ 問題: card.question, 解答: card.answer }]),
  ])(
    "accepts explicit card JSON variants with unverified provenance: %s",
    (input) => {
      const [d] = parseLearningPackage(input);
      expect(d.record).toMatchObject({
        ...card,
        kind: "card",
        sourceStatus: "unverified",
        originalText: "",
      });
    },
  );
  it("supports Japanese CSV headers, BOM, quoted commas/newlines and formula characters", () => {
    const d = parseLearningPackage(
      '\uFEFF問題,解答,重要度,原文\r\n"数式を確認するには？","x,y\n\\frac{a}{b}",4,"元の資料"',
      "cards.csv",
    );
    expect(d[0].record).toMatchObject({
      answer: "x,y\n\\frac{a}{b}",
      importance: 4,
      originalText: "元の資料",
    });
    expect(missingEvidenceCount(d)).toBe(0);
  });
  it("supports headerless Excel TSV without converting mathematical prose into arbitrary questions", () => {
    expect(
      parseLearningPackage(
        "確認するものは？\t数値・単位\n次に見るものは？\t適用条件",
      ),
    ).toHaveLength(2);
    expect(() =>
      parseLearningPackage("A = B + C\n通常の説明文：条件を確認する"),
    ).toThrow("形式を判別");
    expect(() =>
      parseLearningPackage("問題,解答\n問い,答え,余分な列", "cards.csv"),
    ).toThrow("列数");
  });
  it("respects CSV/TSV filenames when text begins with brackets and treats blank kind cells as automatic", () => {
    expect(
      parseLearningPackage("[例題] 何を確認するか？\t単位", "a.tsv")[0].record
        .question,
    ).toBe("[例題] 何を確認するか？");
    expect(
      parseLearningPackage(
        "kind,question,answer\n,確認するものは？,単位",
        "a.csv",
      )[0].record.kind,
    ).toBe("card");
  });
  it("keeps multiline Q/A conditions and equations intact", () => {
    const input =
      "Q: 条件Aで確認する式は？\n対象は架空の数値とする。\nA: $$\n\\frac{a}{b}\n$$\nただしbは0以外。\n\nQ: 例外は？\nA: 条件B";
    const d = parseLearningPackage(input, "cards.txt");
    expect(d).toHaveLength(2);
    expect(d[0].record.question).toContain("対象は架空の数値");
    expect(d[0].record.answer).toBe("$$\n\\frac{a}{b}\n$$\nただしbは0以外。");
    expect(d[0].record.originalText).toBe("");
    expect(() =>
      parseLearningPackage("Q: 問いだけ？\nQ: 次の問い？\nA: 答え"),
    ).toThrow();
  });
  it.each(["md", "markdown", "mdown", "txt"])(
    "imports .%s as a note and preserves safe Markdown source",
    (ext) => {
      const body =
        "# 確認手順\n\n| 数値 | 単位 |\n|---|---|\n| 1 | 個 |\n\n<script>alert(1)</script>\n\n$$\\frac{a}{b}$$";
      expect(parseLearningPackage(body, `メモ.${ext}`)[0].record).toMatchObject(
        { kind: "note", title: "確認手順", body, sourceStatus: "unverified" },
      );
    },
  );
  it("supports explicit note mode for pasted conversation text", () => {
    const text = "会話で確認した結論と適用条件。";
    expect(parseLearningPackage(text, "", true)[0].record.body).toBe(text);
    expect(
      parseLearningPackage("```markdown\n# ノート\n本文\n```")[0].record.body,
    ).toBe("# ノート\n本文");
  });
  it("accepts mixed notes and exercises but refuses backup files and non-material kinds", () => {
    expect(
      parseLearningPackage(
        JSON.stringify({
          questions: [{ ...card, choices: [card.answer, "別解"] }],
        }),
      )[0].record.kind,
    ).toBe("question");
    expect(
      parseLearningPackage(
        JSON.stringify({ notes: [{ title: "要点", body: "本文" }] }),
      )[0].record.kind,
    ).toBe("note");
    for (const payload of [
      {
        format: "study-desk",
        schemaVersion: 1,
        records: [{ kind: "card", ...card }],
        preferences: {},
      },
      {
        format: "study-desk",
        schemaVersion: 1,
        records: [{ kind: "task", date: "2026-11-28", minutes: 30 }],
      },
      { format: "unknown", items: [card] },
      { format: "study-desk-learning", schemaVersion: 2, items: [card] },
      { cards: [card], questions: [card] },
    ])
      expect(() => parseLearningPackage(JSON.stringify(payload))).toThrow();
  });
  it("does not copy identities, review history, destinations, arbitrary fields or verified claims through compatibility aliases", async () => {
    const d = parseLearningPackage(
      JSON.stringify({
        cards: [
          {
            ...card,
            id: "foreign",
            targetId: "foreign",
            password: "secret",
            sourceStatus: "verified",
            fsrs: { reps: 999 },
            history: [{ rating: 4 }],
            citations: [
              { url: "https://example.com/ref", checkedOn: "2026-11-28" },
            ],
          },
        ],
      }),
    );
    expect(d[0].record.id).not.toBe("foreign");
    expect(d[0].record.history).toEqual([]);
    expect(d[0].record.password).toBeUndefined();
    expect(d[0].record.sourceStatus).toBe("unverified");
    const preview = await previewLearningImport(d, scope, true);
    await applyImport(preview);
    const saved = (await db.records.toArray())[0];
    expect(saved.targetId).toBe("");
    expect((saved.citations as any[])[0].checkedOn).toBe("");
    expect(await db.settings.count()).toBe(0);
    expect(() =>
      parseLearningPackage(
        JSON.stringify([
          {
            front: card.question,
            back: card.answer,
            sourceUrl: "javascript:alert(1)",
          },
        ]),
      ),
    ).toThrow();
  });
  it("shows invalid/empty JSON, too many records and unsupported files as errors", () => {
    for (const [text, name] of [
      ["{broken}", "cards.json"],
      ["", "cards.json"],
      ["not an image", "image.png"],
      [JSON.stringify({ cards: [] }), "cards.json"],
      [JSON.stringify({ cards: Array(101).fill(card) }), "cards.json"],
      ["x".repeat(500001), "notes.txt"],
    ])
      expect(() => parseLearningPackage(text, name)).toThrow();
  });
  it("decodes UTF-8 and Shift_JIS CSV without mojibake and rejects binary bytes for JSON", () => {
    const utf8 = new TextEncoder().encode("問題,解答\n問,答");
    expect(decodeLearningBytes(utf8.buffer, "cards.csv")).toBe(
      "問題,解答\n問,答",
    );
    // Shift_JIS: あ,い
    expect(
      decodeLearningBytes(
        Uint8Array.from([0x82, 0xa0, 0x2c, 0x82, 0xa2]).buffer,
        "cards.csv",
      ),
    ).toBe("あ,い");
    expect(() =>
      decodeLearningBytes(Uint8Array.from([0xff]).buffer, "cards.json"),
    ).toThrow("UTF-8");
  });
  it("remembers only destination identifiers and discards removed or reparented destinations", async () => {
    const t = await saveEntity({ kind: "target", title: "対象" });
    const s = await saveEntity({
      kind: "subject",
      title: "科目",
      targetId: t.id,
    });
    const u = await saveEntity({
      kind: "unit",
      title: "単元",
      targetId: t.id,
      subjectId: s.id,
    });
    const remembered = { targetId: t.id, subjectId: s.id, unitId: u.id };
    await setPreferences({ lastLearningScope: remembered });
    expect((await getPreferences()).lastLearningScope).toEqual(remembered);
    expect(resolveLearningScope([t, s, u], remembered)).toEqual(remembered);
    expect(
      resolveLearningScope(
        [t, { ...s, deletedAt: new Date().toISOString() }, u],
        remembered,
      ),
    ).toEqual({ targetId: t.id, subjectId: "", unitId: "" });
    expect(
      resolveLearningScope([t, { ...s, targetId: "other" }, u], remembered),
    ).toEqual({ targetId: t.id, subjectId: "", unitId: "" });
    expect(resolveLearningScope([], remembered)).toEqual(scope);
    const backup = await createBackup();
    expect(JSON.parse(backup).preferences.lastLearningScope).toEqual(
      remembered,
    );
    await db.settings.clear();
    const preview = await previewImport(backup);
    expect(preview.preferences?.lastLearningScope).toEqual(remembered);
    expect(
      normalizePreferences({
        lastLearningScope: { ...remembered, password: "secret" },
      }).lastLearningScope,
    ).toEqual(remembered);
  });
  it("checks parents atomically with saving and keeps existing data on rejection", async () => {
    const target = await saveEntity({ kind: "target", title: "対象" });
    const scope = { targetId: target.id, subjectId: "", unitId: "" };
    const preview = await previewLearningImport(
      parseLearningPackage(JSON.stringify({ cards: [card] })),
      scope,
      true,
    );
    await db.records.update(target.id, { deletedAt: new Date().toISOString() });
    await expect(applyLearningImport(preview, scope)).rejects.toThrow("保存先");
    expect(await db.records.where("kind").equals("card").count()).toBe(0);
    expect(await db.records.get(target.id)).toBeDefined();
  });
  it("saves the approved scope through the same atomic import with duplicate detection", async () => {
    const preview = await previewLearningImport(
      parseLearningPackage(JSON.stringify({ cards: [card] })),
      scope,
      true,
    );
    expect((await applyLearningImport(preview, scope)).added).toBe(1);
    expect((await applyLearningImport(preview, scope)).added).toBe(0);
  });
  it("uses the same learning envelope in both conversation and selected-data prompts", () => {
    const prompt = buildStudyPrompt("学習状況の分析", "", []);
    expect(prompt).toContain('"format":"study-desk-learning"');
    expect(prompt).toContain("originalText");
    expect(prompt).not.toContain('"kind":"task"');
  });
});
