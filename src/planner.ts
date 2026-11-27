import { db, saveEntity, getPreferences } from "./db";
import { splitByDay } from "./timer";
import {
  localDate,
  type Target,
  type Subject,
  type Session,
  type Task,
  type Preferences,
  type Flashcard,
  type Entity,
} from "./models";
export interface PlanInput {
  target: Target;
  subjects: Subject[];
  sessions: Session[];
  tasks: Task[];
  preferences: Preferences;
  startDate?: string;
  cards?: Flashcard[];
}
export interface PlanPreview {
  tasks: Task[];
  shortageMinutes: number;
  availableMinutes: number;
  requiredMinutes: number;
  preservedTaskIds: string[];
  replaceTaskIds: string[];
  generatedAt: string;
  targetId: string;
  startDate: string;
  sourceFingerprint: string;
}
function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
function fingerprint(i: PlanInput) {
  const sort = (rows: Entity[]) =>
    rows
      .filter((r) => !r.deletedAt)
      .map((r) => ({ id: r.id, version: r.version, updatedAt: r.updatedAt }))
      .sort((a, b) => a.id.localeCompare(b.id));
  return canonical({
    target: sort([i.target]),
    subjects: sort(i.subjects.filter((r) => r.targetId === i.target.id)),
    sessions: sort(i.sessions),
    tasks: sort(i.tasks),
    cards: sort((i.cards || []).filter((r) => r.targetId === i.target.id)),
    preferences: i.preferences,
  });
}
export function generatePlan(input: PlanInput): PlanPreview {
  const { target, preferences: p } = input,
    start = input.startDate || localDate(new Date());
  const startDay = new Date(start + "T00:00:00"),
    exam = new Date(target.examDate + "T00:00:00");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(target.examDate) ||
    !Number.isFinite(exam.getTime()) ||
    localDate(exam) !== target.examDate
  )
    throw new Error("試験日を設定してください。");
  if (
    !Number.isFinite(startDay.getTime()) ||
    localDate(startDay) !== start ||
    exam < startDay
  )
    throw new Error("試験日は今日以降に設定してください。");
  if ((exam.getTime() - startDay.getTime()) / 86400000 > 3660)
    throw new Error("計画期間は10年以内に設定してください。");
  if (
    p.reviewRatio < 0 ||
    p.reviewRatio >= 1 ||
    !Number.isFinite(p.reviewRatio) ||
    p.weekdayMinutes.length !== 7 ||
    p.weekdayMinutes.some((m) => !Number.isFinite(m) || m < 0 || m > 1440) ||
    !Number.isInteger(p.bufferDays) ||
    p.bufferDays < 0
  )
    throw new Error("計画の設定値が正しくありません。");
  if (
    !Number.isFinite(target.goalMinutes) ||
    target.goalMinutes < 0 ||
    input.subjects.some(
      (s) =>
        ![s.requiredMinutes, s.importance, s.mastery].every(Number.isFinite) ||
        s.requiredMinutes < 0 ||
        s.importance < 1 ||
        s.importance > 5 ||
        s.mastery < 0 ||
        s.mastery > 100,
    )
  )
    throw new Error("目標時間・科目の重要度と習熟度を確認してください。");
  const old = input.tasks.filter((t) => !t.deletedAt),
    relevant = old.filter((t) => t.targetId === target.id),
    preserved = relevant.filter((t) => t.completed || t.date < start),
    replaced = relevant.filter((t) => !t.completed && t.date >= start);
  const subjects = input.subjects.filter(
    (s) => s.targetId === target.id && !s.deletedAt,
  );
  const studied = input.sessions.filter(
    (s) => s.targetId === target.id && !s.deletedAt,
  );
  const completedBySubject = (id: string) =>
    preserved
      .filter((t) => t.subjectId === id && t.completed && !t.review)
      .reduce((a, t) => a + t.minutes, 0);
  const done = (id: string) =>
    Math.max(
      studied
        .filter((s) => s.subjectId === id)
        .reduce((a, s) => a + s.minutes, 0),
      completedBySubject(id),
    );
  const doneTotal = Math.max(
    studied.reduce((a, s) => a + s.minutes, 0),
    preserved
      .filter((t) => t.completed && !t.review)
      .reduce((a, t) => a + t.minutes, 0),
  );
  const targetRemaining = Math.max(0, target.goalMinutes - doneTotal);
  const source = subjects.length
    ? subjects
    : [
        {
          id: "",
          importance: 3,
          mastery: 0,
          requiredMinutes: target.goalMinutes,
        },
      ];
  const remaining = source.map((s) => ({
    subjectId: s.id,
    minutes: Math.max(0, s.requiredMinutes - done(s.id)),
    weight:
      Math.max(0.05, s.importance * (1 - s.mastery / 100)) *
      (1 +
        (input.cards || []).filter(
          (c) =>
            c.subjectId === s.id &&
            new Date(c.fsrs.due).getTime() <= Date.now(),
        ).length *
          0.05),
  }));
  const subjectRemaining = remaining.reduce((a, r) => a + r.minutes, 0);
  if (subjectRemaining < targetRemaining) {
    const sum = remaining.reduce((a, r) => a + r.weight, 0);
    for (const r of remaining)
      r.minutes += ((targetRemaining - subjectRemaining) * r.weight) / sum;
  }
  const dueCards = (input.cards || []).filter(
    (c) =>
      !c.deletedAt &&
      c.targetId === target.id &&
      new Date(c.fsrs.due).getTime() <= Date.now(),
  ).length;
  const newNeed = remaining.reduce((a, r) => a + r.minutes, 0),
    reviewNeed = Math.max(
      (newNeed * p.reviewRatio) / (1 - p.reviewRatio),
      dueCards * 2,
    ),
    totalNeed = newNeed + reviewNeed;
  const dayUsage = new Map<
    string,
    Map<string, { actual: number; pending: number; completed: number }>
  >();
  const usage = (date: string, targetId: string) => {
    let day = dayUsage.get(date);
    if (!day) {
      day = new Map();
      dayUsage.set(date, day);
    }
    let u = day.get(targetId);
    if (!u) {
      u = { actual: 0, pending: 0, completed: 0 };
      day.set(targetId, u);
    }
    return u;
  };
  for (const session of input.sessions.filter((s) => !s.deletedAt))
    for (const [date, minutes] of Object.entries(splitByDay(session.segments)))
      usage(date, session.targetId).actual += minutes;
  const replaceIds = new Set(replaced.map((t) => t.id));
  for (const task of old)
    if (!replaceIds.has(task.id)) {
      const u = usage(task.date, task.targetId);
      if (task.completed) u.completed += task.minutes;
      else u.pending += task.minutes;
    }
  const budgetDates: { date: string; minutes: number }[] = [];
  const last = new Date(exam);
  last.setDate(last.getDate() - p.bufferDays);
  for (const d = new Date(startDay); d < last; d.setDate(d.getDate() + 1)) {
    const date = localDate(d);
    if (p.unavailableDates.includes(date)) continue;
    const occupied = [...(dayUsage.get(date)?.values() || [])].reduce(
      (sum, u) =>
        sum + u.actual + u.pending + Math.max(0, u.completed - u.actual),
      0,
    );
    budgetDates.push({
      date,
      minutes: Math.max(0, p.weekdayMinutes[(d.getDay() + 6) % 7] - occupied),
    });
  }
  const available = budgetDates.reduce((a, d) => a + d.minutes, 0),
    planId = crypto.randomUUID(),
    now = new Date().toISOString(),
    tasks: Task[] = [];
  let remainingReview = reviewNeed,
    remainingNew = newNeed;
  const add = (
    date: string,
    minutes: number,
    subjectId: string,
    review: boolean,
  ) => {
    if (minutes <= 1e-7) return;
    tasks.push({
      id: crypto.randomUUID(),
      kind: "task",
      targetId: target.id,
      subjectId,
      date,
      minutes,
      completed: false,
      review,
      planId,
      createdAt: now,
      updatedAt: now,
      version: 1,
    });
  };
  for (const day of budgetDates) {
    let capacity = day.minutes;
    if (capacity <= 0) continue;
    // Reserve the configured review share every day, then prioritize unfinished subjects.
    const rev = Math.min(remainingReview, capacity * p.reviewRatio);
    if (rev > 0) {
      const due = [...remaining].sort((a, b) => b.weight - a.weight)[0];
      add(day.date, rev, due?.subjectId || "", true);
      remainingReview -= rev;
      capacity -= rev;
    }
    while (capacity > 1e-7 && remainingNew > 1e-7) {
      const chosen = remaining
        .filter((r) => r.minutes > 1e-7)
        .sort(
          (a, b) =>
            b.weight * Math.sqrt(b.minutes) - a.weight * Math.sqrt(a.minutes),
        )[0];
      if (!chosen) break;
      const allocated = Math.min(30, capacity, chosen.minutes);
      add(day.date, allocated, chosen.subjectId, false);
      chosen.minutes -= allocated;
      remainingNew -= allocated;
      capacity -= allocated;
    }
    const extra = Math.min(remainingReview, capacity);
    add(day.date, extra, remaining[0]?.subjectId || "", true);
    remainingReview -= extra;
  }
  return {
    tasks,
    shortageMinutes: Math.max(0, remainingNew + remainingReview),
    availableMinutes: available,
    requiredMinutes: totalNeed,
    preservedTaskIds: preserved.map((t) => t.id),
    replaceTaskIds: replaced.map((t) => t.id),
    generatedAt: now,
    targetId: target.id,
    startDate: start,
    sourceFingerprint: fingerprint(input),
  };
}
export async function applyPlan(preview: PlanPreview) {
  return db.transaction(
    "rw",
    [db.records, db.outbox, db.settings],
    async () => {
      const rows = (await db.records.toArray()).filter((r) => !r.deletedAt),
        target = rows.find(
          (r) => r.id === preview.targetId && r.kind === "target",
        ) as Target | undefined;
      if (!target) throw new Error("学習対象が見つかりません。");
      const input: PlanInput = {
        target,
        subjects: rows.filter(
          (r) => r.kind === "subject" && r.targetId === target.id,
        ) as Subject[],
        sessions: rows.filter((r) => r.kind === "session") as Session[],
        tasks: rows.filter((r) => r.kind === "task") as Task[],
        cards: rows.filter(
          (r) => r.kind === "card" && r.targetId === target.id,
        ) as Flashcard[],
        preferences: await getPreferences(),
      };
      if (fingerprint(input) !== preview.sourceFingerprint)
        throw new Error(
          "プレビュー後にデータが更新されました。計画を再作成してください。",
        );
      for (const id of preview.replaceTaskIds) {
        const row = await db.records.get(id);
        if (
          row &&
          row.kind === "task" &&
          !row.completed &&
          String(row.date) >= preview.startDate
        )
          await saveEntity({ ...row, deletedAt: new Date().toISOString() });
      }
      for (const task of preview.tasks)
        await saveEntity({ ...task, version: undefined });
      return preview.tasks.length;
    },
  );
}
