import Papa from "papaparse";

export const learningOutputInstructions = `【出力形式】
次のJSON形式のみを返す。可能ならstudy-desk-learning.jsonとしてファイルを用意する。できない場合はJSONコードブロックだけを返す。itemsはcard/question/note、合計100件以内。
{"format":"study-desk-learning","schemaVersion":1,"items":[
{"kind":"card","question":"対象・条件を含む問い","answer":"答え","cardType":"qa","answerUnit":"","conditions":"適用条件","originalText":"根拠の原文","importance":3,"tags":[],"source":"会話または資料の名称","sourceUrl":""},
{"kind":"question","question":"本文を含む○×または選択問題","answer":"○","choices":["○","×"],"originalText":"根拠の原文","importance":3,"tags":[],"source":"出典"},
{"kind":"note","title":"題名","body":"# 結論\\n\\nMarkdown本文","originalText":"根拠の原文","importance":3,"tags":[],"source":"出典"}
]}
ID・設定・保存先ID・履歴・確認済みの宣言は出力しない。cardTypeはqa（一問一答）/formula（計算式）/number（数値確認）。演習のanswerはchoicesの文字列と完全一致させる。解説は原則不要。数値の単位・条件は解答にも含める。計画や分析の提案はノートに整理する。
カード・演習問題には特定できる根拠の原文をoriginalTextへ引用する。原文や出典を捏造しない。原文が特定できない内容は要確認と明記したノートにする。会話の最終訂正を優先する。上記は形式見本なので見本の文自体は出力しない。`;

type Row = Record<string, unknown>;
const object = (v: unknown): v is Row =>
  !!v && typeof v === "object" && !Array.isArray(v);
const aliases: Record<string, string[]> = {
  question: ["question", "front", "q", "Q", "問題", "質問", "表面"],
  answer: ["answer", "back", "a", "A", "解答", "回答", "答え", "正解", "裏面"],
  title: ["title", "タイトル", "題名"],
  body: ["body", "markdown", "content", "本文"],
  kind: ["kind", "素材の種類"],
  originalText: ["originalText", "original_text", "原文", "根拠の原文"],
  importance: ["importance", "重要度"],
  tags: ["tags", "タグ"],
  choices: ["choices", "選択肢"],
  source: ["source", "出典"],
  sourceUrl: ["sourceUrl", "source_url", "出典URL"],
  explanation: ["explanation", "解説"],
  conditions: ["conditions", "適用条件", "条件"],
  answerUnit: ["answerUnit", "単位"],
  cardType: ["cardType", "カード種別"],
  citations: ["citations"],
};
function field(row: Row, name: string) {
  for (const key of aliases[name] || [name])
    if (Object.hasOwn(row, key)) return row[key];
  return undefined;
}
function list(value: unknown, name: string) {
  if (typeof value !== "string") return value;
  const raw = value.trim();
  if (!raw) return [];
  if (raw.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* A malformed array is reported below, never silently split. */
    }
    throw new Error(`${name}のJSON配列を確認してください。`);
  }
  return raw.split(name === "選択肢" ? /\|/ : /[|,、]/).map((s) => s.trim());
}
function project(row: unknown, defaultKind?: string): Row {
  if (!object(row)) throw new Error("各項目はオブジェクトにしてください。");
  const result = Object.fromEntries(
    Object.keys(aliases).map((key) => [key, field(row, key)]),
  );
  if (typeof result.kind === "string") result.kind = result.kind.trim();
  const kind =
    (result.kind === "" ? undefined : result.kind) ??
    defaultKind ??
    ((typeof result.title === "string" && result.title.trim()) ||
    (typeof result.body === "string" && result.body.trim())
      ? "note"
      : "card");
  result.kind =
    (
      {
        flashcard: "card",
        flashcards: "card",
        暗記カード: "card",
        ノート: "note",
        演習問題: "question",
      } as Row
    )[String(kind)] ?? kind;
  if (
    typeof result.importance === "string" &&
    /^[1-5]$/.test(result.importance.trim())
  )
    result.importance = Number(result.importance);
  if (result.importance === "") result.importance = undefined;
  result.tags = list(result.tags, "タグ");
  if (result.kind === "question")
    result.choices = list(result.choices, "選択肢");
  return result;
}
function note(input: string, fileName: string) {
  return {
    formatLabel: "Markdown・テキストノート",
    items: [
      {
        kind: "note",
        title:
          input.match(/^#\s+(.+)$/m)?.[1] ||
          fileName.replace(/\.[^.]+$/, "") ||
          "GPT会話のノート",
        body: input,
      },
    ],
  };
}
function qaRows(raw: string): Row[] {
  const rows: Row[] = [];
  let question: string[] = [],
    answer: string[] = [],
    inAnswer = false;
  const flush = () => {
    if (question.length)
      rows.push({
        kind: "card",
        question: question.join("\n").trim(),
        answer: answer.join("\n").trim(),
      });
  };
  for (const line of raw.split(/\r?\n/)) {
    if (/^(?:Q|問(?:題)?)[：:]\s*/i.test(line)) {
      flush();
      question = [line.replace(/^(?:Q|問(?:題)?)[：:]\s*/i, "")];
      answer = [];
      inAnswer = false;
    } else if (/^(?:A|答(?:え)?|解答)[：:]\s*/i.test(line) && question.length) {
      if (inAnswer)
        throw new Error(
          "A:が重複しています。各問題をQ:とA:で区切ってください。",
        );
      inAnswer = true;
      answer.push(line.replace(/^(?:A|答(?:え)?|解答)[：:]\s*/i, ""));
    } else if (question.length) (inAnswer ? answer : question).push(line);
    else if (line.trim()) throw new Error("Q:/A:以外の文章が混在しています。");
  }
  flush();
  return rows;
}

/** Decode only explicit study structures. Never generate questions from prose. */
export function decodeLearningInput(
  input: string,
  fileName = "",
  asNote = false,
): { formatLabel: string; items: Row[] } {
  if (input.length > 500000)
    throw new Error("取り込み内容は50万文字以下に分けてください。");
  const text = input.replace(/^\uFEFF/, "").trim();
  if (!text) throw new Error("ファイルの内容または貼り付けた文章が空です。");
  if (
    fileName &&
    !/\.(?:json|flashcards|csv|tsv|txt|md|markdown|mdown)$/i.test(fileName)
  )
    throw new Error(
      "対応形式はJSON・CSV・TSV・TXT・Markdownです。PDF・Word・画像の直接読み取りには対応していません。",
    );
  if (asNote || /\.(?:md|markdown|mdown)$/i.test(fileName))
    return note(text, fileName);
  const markdownFence = /^```(?:md|markdown)\s*\n([\s\S]*?)\n```$/i.exec(text);
  if (markdownFence) return note(markdownFence[1], fileName);
  const raw = text
    .replace(/^```(?:json|csv|tsv|text|txt)?\s*\n?([\s\S]*?)\n?```$/i, "$1")
    .trim();
  if (
    (!/\.(?:csv|tsv)$/i.test(fileName) && /^[{[]/.test(raw)) ||
    /\.(?:json|flashcards)$/i.test(fileName)
  ) {
    let packet: unknown;
    try {
      packet = JSON.parse(raw);
    } catch {
      throw new Error(
        "JSONを解析できません。JSON全体をコピーし、引用符・末尾のカンマ・数式のバックスラッシュを確認してください。CSV・Q:/A:・Markdownでも取り込めます。",
      );
    }
    if (Array.isArray(packet))
      return { formatLabel: "JSON配列", items: packet.map((r) => project(r)) };
    if (!object(packet))
      throw new Error("JSONにはカード・問題・ノートの項目を指定してください。");
    if (
      packet.format !== undefined &&
      !["study-desk-learning", "study-desk"].includes(String(packet.format))
    )
      throw new Error(
        `未対応のJSON形式です：${String(packet.format)}。cards配列または専用テンプレートを利用してください。`,
      );
    if (packet.format !== undefined && packet.schemaVersion !== 1)
      throw new Error(
        "このJSONのschemaVersionには対応していません（対応：1）。",
      );
    if (
      packet.type === "flashcards" &&
      packet.version !== undefined &&
      packet.version !== 1
    )
      throw new Error(
        "このカードJSONのversionには対応していません（対応：1）。",
      );
    if (
      packet.format === "study-desk" &&
      (packet.preferences ||
        packet.referenceSites ||
        packet.conflictArchives ||
        packet.unresolvedConflicts ||
        packet.exportedAt)
    )
      throw new Error(
        "全データのバックアップは「設定」の復元から取り込んでください。この画面は学習素材専用です。",
      );
    const keys = ["items", "cards", "questions", "notes", "records"].filter(
      (key) => Object.hasOwn(packet, key),
    );
    if (!keys.length)
      return { formatLabel: "JSON単体", items: [project(packet)] };
    if (keys.length > 1)
      throw new Error(
        "items・cards・questions・notes・recordsは1種類の配列にまとめてください。",
      );
    const key = keys[0],
      rows = packet[key];
    if (!Array.isArray(rows)) throw new Error(`${key}を配列にしてください。`);
    const defaultKind =
      key === "questions"
        ? "question"
        : key === "notes"
          ? "note"
          : key === "cards"
            ? "card"
            : undefined;
    return {
      formatLabel: key === "cards" ? "カード用JSON（互換）" : "学習素材JSON",
      items: rows.map((r) => project(r, defaultKind)),
    };
  }
  if (/^(?:Q|問(?:題)?)[：:]/i.test(raw))
    return { formatLabel: "Q:/A:テキスト", items: qaRows(raw) };
  const delimiter =
    /\.tsv$/i.test(fileName) || raw.split(/\r?\n/)[0].includes("\t")
      ? "\t"
      : ",";
  const parsed = Papa.parse<string[]>(raw, {
    delimiter,
    skipEmptyLines: "greedy",
  });
  const header = parsed.data[0]?.map((h) => h.trim()) || [];
  const has = (key: string) => aliases[key].some((a) => header.includes(a));
  const hasHeader =
    (has("question") && has("answer")) || (has("title") && has("body"));
  const bareTsv =
    delimiter === "\t" && parsed.data.every((r) => r.length === 2);
  if (hasHeader || bareTsv || /\.(?:csv|tsv)$/i.test(fileName)) {
    if (parsed.errors.length)
      throw new Error("CSV/TSVの引用符・区切り・列数を確認してください。");
    if (!hasHeader && !bareTsv)
      throw new Error(
        "CSVの1行目に「問題,解答」または「title,body」の見出しを付けてください。TSVは見出しなしの問題・解答2列にも対応します。",
      );
    const rows = hasHeader ? parsed.data.slice(1) : parsed.data;
    if (rows.some((row) => row.length !== (hasHeader ? header.length : 2)))
      throw new Error(
        "CSV/TSVの列数が一致していません。カンマや改行を含むセルは二重引用符で囲んでください。",
      );
    return {
      formatLabel: delimiter === "\t" ? "TSV" : "CSV",
      items: rows.map((row) =>
        project(
          hasHeader
            ? Object.fromEntries(header.map((h, i) => [h, row[i]]))
            : { question: row[0], answer: row[1] },
        ),
      ),
    };
  }
  if (/\.txt$/i.test(fileName) || /^#{1,6}\s/m.test(raw))
    return note(raw, fileName);
  throw new Error(
    "形式を判別できません。JSON・CSV・TSV・Q:/A:を入力するか、「ノート1件として取り込む」を選んでください。一般文章から問題を自動生成しません。",
  );
}

/** UTF-8 first; legacy Japanese text files may use Shift_JIS. Binary formats stay unsupported. */
export function decodeLearningBytes(
  bytes: ArrayBuffer,
  fileName: string,
): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    if (!/\.(?:csv|tsv|txt)$/i.test(fileName))
      throw new Error("UTF-8のテキストファイルを選んでください。");
    try {
      return new TextDecoder("shift_jis", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(
        "文字コードを読み取れません。UTF-8で保存し直してください。",
      );
    }
  }
}
