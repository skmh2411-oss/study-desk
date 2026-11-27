import { createEmptyCard, type Card } from "ts-fsrs";
import { normalizeCitation, normalizeReferenceUrl } from "./references";
import {
  defaultPreferences,
  localDate,
  type Entity,
  type Preferences,
  type Kind,
} from "./models";
const kinds: Kind[] = [
  "target",
  "subject",
  "unit",
  "session",
  "task",
  "note",
  "card",
  "attempt",
  "question",
];
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
function fail(field: string): never {
  throw new Error(`取り込み形式が不正です：${field}`);
}
function text(v: unknown, name: string, defaultValue?: string) {
  if (v === undefined && defaultValue !== undefined) return defaultValue;
  if (typeof v !== "string" || v.length > 1000000) fail(name);
  return v as string;
}
function number(
  v: unknown,
  name: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  defaultValue?: number,
) {
  if (v === undefined && defaultValue !== undefined) return defaultValue;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
    fail(name);
  return v as number;
}
function bool(v: unknown, name: string, defaultValue = false) {
  if (v === undefined) return defaultValue;
  if (typeof v !== "boolean") fail(name);
  return v as boolean;
}
function strings(v: unknown, name: string) {
  if (v === undefined) return [];
  if (
    !Array.isArray(v) ||
    v.length > 10000 ||
    v.some((s) => typeof s !== "string" || s.length > 10000)
  )
    fail(name);
  return v as string[];
}
function date(v: unknown, name: string, empty = false) {
  const s = text(v, name, empty ? "" : undefined);
  if (empty && s === "") return s;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(s) ||
    localDate(new Date(s + "T00:00:00")) !== s
  )
    fail(name);
  return s;
}
function timestamp(v: unknown, name: string) {
  const s = text(v, name);
  if (!Number.isFinite(new Date(s).getTime())) fail(name);
  return new Date(s).toISOString();
}
export function normalizeEntity(raw: unknown): Entity {
  if (!isObject(raw) || !kinds.includes(raw.kind as Kind)) fail("kind");
  const now = new Date().toISOString(),
    kind = raw.kind as Kind;
  const r: Entity = {
    id: text(raw.id, "id", crypto.randomUUID()),
    kind,
    createdAt:
      raw.createdAt === undefined ? now : timestamp(raw.createdAt, "createdAt"),
    updatedAt:
      raw.updatedAt === undefined ? now : timestamp(raw.updatedAt, "updatedAt"),
    version: number(raw.version, "version", 1, Number.MAX_SAFE_INTEGER, 1),
  };
  if (!r.id.trim() || r.id.length > 200 || !Number.isInteger(r.version))
    fail("id/version");
  if (raw.deletedAt !== undefined)
    r.deletedAt = timestamp(raw.deletedAt, "deletedAt");
  for (const field of ["targetId", "subjectId", "unitId"])
    r[field] = text(raw[field], field, "");
  if (["target", "subject", "unit", "note"].includes(kind)) {
    r.title = text(raw.title, "title");
    if (!r.title.trim()) fail("title");
  }
  if (kind === "target") {
    r.examDate = date(raw.examDate, "examDate", true);
    r.goalMinutes = number(raw.goalMinutes, "goalMinutes", 0, 52560000, 0);
    r.passCriteria = text(raw.passCriteria, "passCriteria", "");
  }
  if (kind === "subject" || kind === "unit") {
    r.importance = number(raw.importance, "importance", 1, 5, 3);
    r.mastery = number(raw.mastery, "mastery", 0, 100, 0);
    r.status = text(raw.status, "status", "未着手");
    if (!r.targetId || (kind === "unit" && !r.subjectId))
      fail("学習対象・科目");
    if (kind === "subject")
      r.requiredMinutes = number(
        raw.requiredMinutes,
        "requiredMinutes",
        0,
        52560000,
        0,
      );
  }
  if (kind === "session") {
    if (
      !Array.isArray(raw.segments) ||
      !raw.segments.length ||
      raw.segments.length > 10000
    )
      fail("segments");
    let previousEnd = -Infinity;
    r.segments = raw.segments.map((s: unknown) => {
      if (!isObject(s)) fail("segments");
      const start = number(s.start, "segments.start", 0, 8640000000000000),
        end = number(s.end, "segments.end", start, 8640000000000000);
      if (start < previousEnd || end <= start) fail("segments overlap");
      previousEnd = end;
      return { start, end };
    });
    const calculated = (r.segments as { start: number; end: number }[]).reduce(
      (a, s) => a + (s.end - s.start) / 60000,
      0,
    );
    r.minutes = number(raw.minutes, "minutes", 0, 52560000, calculated);
    if (Math.abs(Number(r.minutes) - calculated) > 0.00001)
      fail("学習時間と区間の不一致");
    r.method = text(raw.method, "method", "その他");
    r.memo = text(raw.memo, "memo", "");
    if (!r.targetId) fail("targetId");
  }
  if (kind === "task") {
    r.date = date(raw.date, "date");
    r.minutes = number(raw.minutes, "minutes", 0.0000001, 1440);
    r.completed = bool(raw.completed, "completed");
    r.review = bool(raw.review, "review");
    r.planId = text(raw.planId, "planId", "import");
    if (!r.targetId) fail("targetId");
  }
  if (kind === "note") {
    r.body = text(raw.body, "body", "");
    r.tags = strings(raw.tags, "tags");
    r.bookmark = bool(raw.bookmark, "bookmark");
    r.importance = number(raw.importance, "importance", 1, 5, 3);
    r.source = text(raw.source, "source", "");
    r.verifiedOn = date(raw.verifiedOn, "verifiedOn", true);
  }
  if (kind === "card") {
    r.question = text(raw.question, "question");
    r.answer = text(raw.answer, "answer");
    if (!String(r.question).trim() || !String(r.answer).trim())
      fail("問題と解答");
    r.explanation = text(raw.explanation, "explanation", "");
    r.tags = strings(raw.tags, "tags");
    r.importance = number(raw.importance, "importance", 1, 5, 3);
    r.source = text(raw.source, "source", "");
    if (raw.noteId !== undefined) r.noteId = text(raw.noteId, "noteId");
    const f = { ...createEmptyCard<Card>(new Date()) } as unknown as Record<
      string,
      unknown
    >;
    if (raw.fsrs !== undefined) {
      if (!isObject(raw.fsrs)) fail("fsrs");
      for (const k of [
        "stability",
        "difficulty",
        "elapsed_days",
        "scheduled_days",
        "reps",
        "lapses",
        "state",
        "learning_steps",
      ])
        if (raw.fsrs[k] !== undefined)
          f[k] = number(
            raw.fsrs[k],
            `fsrs.${k}`,
            0,
            k === "state" ? 3 : Number.MAX_SAFE_INTEGER,
          );
      if (raw.fsrs.due !== undefined) {
        const val = raw.fsrs.due;
        if (!(val instanceof Date) && typeof val !== "string") fail("fsrs.due");
        const parsed = new Date(val as string);
        if (!Number.isFinite(parsed.getTime())) fail("fsrs.due");
        f.due = parsed;
      }
      if (raw.fsrs.last_review !== undefined) {
        const parsed = new Date(raw.fsrs.last_review as string);
        if (!Number.isFinite(parsed.getTime())) fail("fsrs.last_review");
        f.last_review = parsed;
      }
    }
    for (const k of ["state", "reps", "lapses", "learning_steps"])
      if (!Number.isInteger(f[k])) fail(`fsrs.${k}`);
    if (Number(f.difficulty) > 10) fail("fsrs.difficulty");
    if (Number(f.state) > 0 && Number(f.difficulty) < 1)
      fail("fsrs.difficulty");
    r.fsrs = f;
    r.history = [];
    if (raw.history !== undefined) {
      if (!Array.isArray(raw.history) || raw.history.length > 1000000)
        fail("history");
      r.history = raw.history.map((h: unknown) => {
        if (!isObject(h)) fail("history");
        const rating = number(h.rating, "history.rating", 1, 4);
        if (!Number.isInteger(rating)) fail("history.rating");
        return { at: timestamp(h.at, "history.at"), rating };
      });
    }
  }
  if (kind === "question") {
    r.question = text(raw.question, "question");
    r.answer = text(raw.answer, "answer");
    if (!String(r.question).trim() || !String(r.answer).trim())
      fail("問題と解答");
    r.explanation = text(raw.explanation, "explanation", "");
    r.source = text(raw.source, "source", "");
    r.choices = strings(raw.choices, "choices");
    const choices = r.choices as string[];
    if (
      choices.length < 2 ||
      choices.some((c) => !c.trim()) ||
      new Set(choices).size !== choices.length ||
      !choices.includes(r.answer as string)
    )
      fail("選択肢は正解を含む重複しない2つ以上を指定してください");
    r.cause = text(raw.cause, "cause", "");
    r.wrongCount = number(
      raw.wrongCount,
      "wrongCount",
      0,
      Number.MAX_SAFE_INTEGER,
      0,
    );
    if (!Number.isInteger(r.wrongCount)) fail("wrongCount");
  }
  if (kind === "card" || kind === "question" || kind === "note") {
    if (kind === "question") {
      if (raw.importance !== undefined) {
        r.importance = number(raw.importance, "importance", 1, 5);
        if (!Number.isInteger(r.importance)) fail("importance");
      }
      if (raw.tags !== undefined) r.tags = strings(raw.tags, "tags");
    }
    if (raw.cardType !== undefined) {
      if (!["qa", "formula", "number"].includes(String(raw.cardType)))
        fail("cardType");
      r.cardType = raw.cardType;
    }
    for (const field of [
      "answerUnit",
      "conditions",
      "originalText",
      "sourceQuestionId",
      "batchId",
    ] as const)
      if (raw[field] !== undefined) r[field] = text(raw[field], field);
    if (raw.sourceUrl !== undefined) {
      const url = text(raw.sourceUrl, "sourceUrl");
      r.sourceUrl = url ? normalizeReferenceUrl(url) : "";
    }
    if (raw.sourceStatus !== undefined) {
      if (
        !["extracted", "unverified", "verified"].includes(
          String(raw.sourceStatus),
        )
      )
        fail("sourceStatus");
      r.sourceStatus = raw.sourceStatus;
    }
    if (raw.citations !== undefined) {
      if (!Array.isArray(raw.citations) || raw.citations.length > 100)
        fail("citations");
      r.citations = raw.citations.map(normalizeCitation);
    }
  }
  if (kind === "attempt") {
    r.total = number(raw.total, "total", 1, 1000000);
    r.correct = number(raw.correct, "correct", 0, r.total as number);
    if (!Number.isInteger(r.total) || !Number.isInteger(r.correct))
      fail("問題数");
    r.cause = text(raw.cause, "cause", "");
    r.date = date(raw.date, "date");
    if (raw.questionId !== undefined)
      r.questionId = text(raw.questionId, "questionId");
  }
  return r;
}
export function normalizePreferences(raw: unknown): Preferences {
  if (!isObject(raw)) fail("preferences");
  const p = { ...defaultPreferences };
  if (raw.theme !== undefined) {
    if (!["light", "dark", "system"].includes(raw.theme as string))
      fail("theme");
    p.theme = raw.theme as Preferences["theme"];
  }
  p.dailyNewLimit = number(raw.dailyNewLimit, "dailyNewLimit", 0, 10000, 20);
  if (!Number.isInteger(p.dailyNewLimit)) fail("dailyNewLimit");
  if (raw.weekdayMinutes !== undefined) {
    if (!Array.isArray(raw.weekdayMinutes) || raw.weekdayMinutes.length !== 7)
      fail("weekdayMinutes");
    p.weekdayMinutes = raw.weekdayMinutes.map((m) =>
      number(m, "weekdayMinutes", 0, 1440),
    );
  }
  p.unavailableDates = strings(raw.unavailableDates, "unavailableDates").map(
    (d) => date(d, "unavailableDates"),
  );
  p.reviewRatio = number(raw.reviewRatio, "reviewRatio", 0, 0.95, 0.2);
  p.bufferDays = number(raw.bufferDays, "bufferDays", 0, 3660, 2);
  if (!Number.isInteger(p.bufferDays)) fail("bufferDays");
  if (raw.lastTimer !== undefined) {
    if (!isObject(raw.lastTimer)) fail("lastTimer");
    const t = raw.lastTimer;
    const last: NonNullable<Preferences["lastTimer"]> = {};
    if (t.mode !== undefined) {
      if (!["stopwatch", "countdown", "pomodoro"].includes(String(t.mode)))
        fail("lastTimer.mode");
      last.mode = t.mode as typeof last.mode;
    }
    for (const k of ["targetId", "subjectId", "unitId", "method"] as const)
      if (t[k] !== undefined) last[k] = text(t[k], `lastTimer.${k}`);
    for (const k of [
      "durationMinutes",
      "focusMinutes",
      "breakMinutes",
    ] as const)
      if (t[k] !== undefined)
        last[k] = number(t[k], `lastTimer.${k}`, 0.000001, 1440);
    p.lastTimer = last;
  }
  if (raw.lastLearningScope !== undefined) {
    if (!isObject(raw.lastLearningScope)) fail("lastLearningScope");
    p.lastLearningScope = {
      targetId: text(
        raw.lastLearningScope.targetId,
        "lastLearningScope.targetId",
        "",
      ),
      subjectId: text(
        raw.lastLearningScope.subjectId,
        "lastLearningScope.subjectId",
        "",
      ),
      unitId: text(
        raw.lastLearningScope.unitId,
        "lastLearningScope.unitId",
        "",
      ),
    };
  }
  return p;
}
