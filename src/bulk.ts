import Papa from "papaparse";
import { db, saveEntity } from "./db";
import { previewImport, applyImport, type ImportPreview } from "./exchange";
import type { CardType, Citation, Entity } from "./models";
import { normalizeCitation } from "./references";

export type DraftKind = "card" | "question";
export interface BulkCandidate {
  id: string;
  question: string;
  answer: string;
  choices: string[];
  cardType: CardType;
  answerUnit: string;
  conditions: string;
  originalText: string;
  source: string;
  sourceUrl: string;
  sourceQuestionId: string;
  citations: Citation[];
  importance: number;
  selected: boolean;
  warnings: string[];
}
export interface BulkSettings {
  kind: DraftKind;
  targetId: string;
  subjectId: string;
  unitId: string;
  cardType: CardType | "auto";
  importance: number;
  source: string;
  sourceUrl: string;
  asOf: string;
}
const text = (x: unknown) => (typeof x === "string" ? x.trim() : "");
const numberPattern =
  /\d[\d,.]*(?:\s*(?:%|％|円|万円|億円|日|営業日|年|月|か月|ヶ月|時間|分|倍|歳|件|人|株))/;
const fields: Record<string, string[]> = {
  question: ["question", "問題", "質問", "用語", "項目"],
  answer: ["answer", "解答", "回答", "答え", "正解", "定義", "数値", "式"],
  choices: ["choices", "選択肢"],
  source: ["source", "出典"],
  sourceUrl: ["sourceUrl", "source_url", "元URL", "出典URL"],
  sourceQuestionId: ["sourceQuestionId", "source_question_id", "問題ID"],
  conditions: ["conditions", "条件", "適用条件"],
  answerUnit: ["answerUnit", "単位"],
  cardType: ["cardType", "種類"],
  importance: ["importance", "重要度"],
};
function field(row: Record<string, unknown>, name: string) {
  for (const key of fields[name] || [name])
    if (row[key] !== undefined) return row[key];
  return undefined;
}
function candidate(
  row: Record<string, unknown>,
  original: string,
  setting: BulkSettings,
): BulkCandidate {
  const answer = text(field(row, "answer"));
  const citations = Array.isArray(row.citations)
    ? row.citations
        .slice(0, 1)
        .map((c) => ({ ...normalizeCitation(c), checkedOn: "" }))
    : [];
  const hint = text(field(row, "cardType"));
  const type =
    setting.cardType !== "auto"
      ? setting.cardType
      : ["formula", "計算式"].includes(hint)
        ? "formula"
        : ["number", "数値"].includes(hint)
          ? "number"
          : /[=＝]/.test(answer)
            ? "formula"
            : numberPattern.test(answer)
              ? "number"
              : "qa";
  const choicesRaw = field(row, "choices");
  let choices: string[] = [];
  if (Array.isArray(choicesRaw))
    choices = choicesRaw
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter(Boolean);
  else if (typeof choicesRaw === "string" && choicesRaw.trim()) {
    if (choicesRaw.trim().startsWith("[")) {
      try {
        const v = JSON.parse(choicesRaw);
        if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
          throw Error();
        choices = v.map((s: string) => s.trim()).filter(Boolean);
      } catch {
        throw new Error("選択肢はJSON配列または | 区切りで入力してください。");
      }
    } else
      choices = choicesRaw
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean);
  }
  if (
    setting.kind === "question" &&
    !choices.length &&
    ["○", "〇", "×"].includes(answer)
  )
    choices = ["○", "×"];
  const normalizedAnswer =
    setting.kind === "question" && answer === "〇" ? "○" : answer;
  const question = text(field(row, "question"));
  const warnings: string[] = [];
  if (!question || !answer) warnings.push("問題または答えが空です");
  if (type === "formula")
    warnings.push("式・記号・単位を原文と照合してください");
  if (type === "number")
    warnings.push("数値・単位・起算点・適用条件を確認してください");
  if (
    setting.kind === "question" &&
    (choices.length < 2 || !choices.includes(normalizedAnswer))
  )
    warnings.push("2つ以上の選択肢と、それに一致する正解が必要です");
  const importance = field(row, "importance");
  return {
    id: crypto.randomUUID(),
    question,
    answer: normalizedAnswer,
    choices,
    cardType: type,
    conditions: text(field(row, "conditions")),
    answerUnit: text(field(row, "answerUnit")),
    originalText: original,
    source: text(field(row, "source")) || setting.source,
    sourceUrl:
      text(field(row, "sourceUrl")) || citations[0]?.url || setting.sourceUrl,
    citations,
    sourceQuestionId: text(field(row, "sourceQuestionId")),
    importance:
      Number.isInteger(Number(importance)) &&
      Number(importance) >= 1 &&
      Number(importance) <= 5
        ? Number(importance)
        : setting.importance,
    selected: !!question && !!answer,
    warnings,
  };
}
export function extractCandidates(
  input: string,
  settings: BulkSettings,
): BulkCandidate[] {
  if (input.length > 500000)
    throw new Error("素材は50万文字以下に分けてください。");
  const raw = input
    .trim()
    .replace(/^```(?:json|csv|tsv)?\s*\n?([\s\S]*?)\n?```$/i, "$1");
  if (!raw)
    throw new Error(
      "テキスト・CSV・JSON、または画像の読み取り結果を入力してください。",
    );
  let rows: { row: Record<string, unknown>; original: string }[] = [];
  if (/^[{[]/.test(raw)) {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("JSONを解析できません。");
    }
    const obj =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
    const list = Array.isArray(value)
      ? value
      : (obj.cards ?? obj.questions ?? obj.records);
    if (
      !Array.isArray(list) ||
      list.some((x) => !x || typeof x !== "object" || Array.isArray(x))
    )
      throw new Error("cards または questions の配列を指定してください。");
    if (list.some((x) => x.kind && x.kind !== settings.kind))
      throw new Error(
        "カードと演習問題を混在させず、取り込み先を選んでください。",
      );
    rows = list.map((row) => ({
      row,
      original:
        text(row.originalText) ||
        `${text(field(row, "question"))}\n${text(field(row, "answer"))}`,
    }));
  } else {
    const parsed = Papa.parse<string[]>(raw, { skipEmptyLines: "greedy" });
    const header = parsed.data[0]?.map((x) => x.trim());
    const hasHeader =
      header?.some((x) => fields.question.includes(x)) &&
      header?.some((x) => fields.answer.includes(x));
    if (hasHeader) {
      if (parsed.errors.length)
        throw new Error("CSV/TSVの引用符や区切りを確認してください。");
      rows = parsed.data.slice(1).map((cols) => ({
        row: Object.fromEntries(header!.map((h, i) => [h, cols[i] || ""])),
        original: cols.join(" / "),
      }));
    } else {
      const lines = raw
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean);
      let pending = "";
      for (const line of lines) {
        if (/^(?:Q|問(?:題)?)[：:.\s]/i.test(line)) {
          if (pending)
            rows.push({
              row: { question: pending, answer: "" },
              original: pending,
            });
          pending = line.replace(/^(?:Q|問(?:題)?)[：:.\s]+/i, "");
          continue;
        }
        if (pending && /^(?:A|答(?:え)?|解答)[：:.\s]/i.test(line)) {
          rows.push({
            row: {
              question: pending,
              answer: line.replace(/^(?:A|答(?:え)?|解答)[：:.\s]+/i, ""),
            },
            original: pending + "\n" + line,
          });
          pending = "";
          continue;
        }
        if (/^\|?\s*[-:]+\s*\|/.test(line)) continue;
        const parts = line.includes("\t")
          ? line.split("\t")
          : line.includes("|")
            ? line.replace(/^\||\|$/g, "").split("|")
            : line.split(/[：:]/);
        if (
          parts.length >= 2 &&
          parts[0].trim() &&
          parts.slice(1).join(":").trim()
        ) {
          if (
            (line.includes("\t") || line.includes("|")) &&
            /^(用語|問題|項目)$/.test(parts[0].trim()) &&
            /^(定義|解答|答え|数値)$/.test(parts[1].trim())
          )
            continue;
          rows.push({
            row: {
              question: parts[0].trim(),
              answer: parts
                .slice(1)
                .join(line.includes("|") ? " | " : ":")
                .trim(),
            },
            original: line,
          });
        } else if (/[=＝]/.test(line)) {
          const lhs = line.split(/[=＝]/)[0].trim();
          rows.push({
            row: {
              question: `「${lhs}」を求める式は？`,
              answer: line,
              cardType: "formula",
            },
            original: line,
          });
        } else
          rows.push({ row: { question: line, answer: "" }, original: line });
      }
      if (pending)
        rows.push({
          row: { question: pending, answer: "" },
          original: pending,
        });
    }
  }
  if (!rows.length) throw new Error("取り込み候補がありません。");
  if (rows.length > 100)
    throw new Error("1回の候補は100件までです。素材を分けてください。");
  return rows.map((x) => candidate(x.row, x.original, settings));
}
export async function prepareBulk(
  candidates: BulkCandidate[],
  settings: BulkSettings,
): Promise<ImportPreview> {
  const chosen = candidates.filter((c) => c.selected);
  if (!chosen.length) throw new Error("保存する候補を選択してください。");
  const batchId = crypto.randomUUID();
  const records = chosen.map((c) => ({
    kind: settings.kind,
    targetId: settings.targetId,
    subjectId: settings.subjectId,
    unitId: settings.unitId,
    question: c.question,
    answer: c.answer,
    ...(settings.kind === "question"
      ? { choices: c.choices, wrongCount: 0, cause: "" }
      : {}),
    importance: c.importance,
    cardType: c.cardType,
    answerUnit: c.answerUnit,
    conditions: c.conditions,
    originalText: c.originalText,
    source: c.source,
    sourceUrl: c.sourceUrl,
    sourceQuestionId: c.sourceQuestionId,
    sourceStatus: "extracted",
    batchId,
    citations: c.sourceUrl
      ? [
          {
            url: c.sourceUrl,
            locator:
              c.citations.find((x) => x.url === c.sourceUrl)?.locator || "",
            asOf:
              settings.asOf ||
              c.citations.find((x) => x.url === c.sourceUrl)?.asOf ||
              "",
            checkedOn: "",
          },
        ]
      : [],
    explanation: "",
    tags: [],
  }));
  const preview = await previewImport(
    JSON.stringify({ format: "study-desk", schemaVersion: 1, records }),
  );
  const existing = await db.records.toArray();
  const sourceKeys = new Set(
    existing
      .filter((r) => r.kind === "question" && r.sourceUrl && r.sourceQuestionId)
      .map((r) => JSON.stringify([r.sourceUrl, r.sourceQuestionId])),
  );
  const before = preview.records.length;
  preview.records = preview.records.filter((r) => {
    if (r.kind !== "question" || !r.sourceUrl || !r.sourceQuestionId)
      return true;
    const key = JSON.stringify([r.sourceUrl, r.sourceQuestionId]);
    if (sourceKeys.has(key)) return false;
    sourceKeys.add(key);
    return true;
  });
  if (before !== preview.records.length) {
    preview.conflicts += before - preview.records.length;
    preview.warnings.push(
      `同じ出典URL・問題IDの${before - preview.records.length}件は、既存データを保持して追加しません。`,
    );
  }
  return preview;
}
export async function commitBulk(preview: ImportPreview) {
  return applyImport(preview);
}
/** Reversible undo of a single batch, retaining all content and review history. */
export async function trashImportBatch(snapshot: Entity[]) {
  if (
    !snapshot.length ||
    !snapshot[0].batchId ||
    snapshot.some(
      (r) =>
        r.batchId !== snapshot[0].batchId ||
        !["card", "question"].includes(r.kind),
    )
  )
    throw new Error("取り込み単位を確認してください。");
  return db.transaction("rw", [db.records, db.outbox], async () => {
    for (const expected of snapshot) {
      const current = await db.records.get(expected.id);
      if (
        !current ||
        current.version !== expected.version ||
        current.deletedAt ||
        current.batchId !== expected.batchId
      )
        throw new Error(
          "別の画面で変更されています。再読み込みしてから取り消してください。",
        );
      await saveEntity(
        { ...current, deletedAt: new Date().toISOString() },
        current.version,
      );
    }
  });
}

export function duplicateCandidateIds(candidates: BulkCandidate[]) {
  const seen = new Set<string>(),
    duplicates = new Set<string>();
  for (const c of candidates) {
    const key = JSON.stringify([c.question.trim(), c.answer.trim(), c.choices]);
    if (seen.has(key)) duplicates.add(c.id);
    else seen.add(key);
  }
  return duplicates;
}
