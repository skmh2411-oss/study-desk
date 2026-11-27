import { db, saveEntity, setPreferences } from "./db";
import {
  localDate,
  type TimerState,
  type Segment,
  type Session,
} from "./models";
export function timerLimitMs(t: TimerState) {
  return t.mode === "stopwatch"
    ? Infinity
    : 60000 *
        (t.mode === "pomodoro"
          ? t.phase === "break"
            ? t.breakMinutes
            : t.focusMinutes
          : t.durationMinutes);
}
export function elapsedMs(t: TimerState, now = Date.now()) {
  const closed = t.segments.reduce(
    (sum, s) => sum + Math.max(0, s.end - s.start),
    0,
  );
  return Math.min(
    timerLimitMs(t),
    closed + (t.runningSince === null ? 0 : Math.max(0, now - t.runningSince)),
  );
}
function closedSegments(t: TimerState, now: number): Segment[] {
  const all = [...t.segments];
  if (t.runningSince !== null)
    all.push({ start: t.runningSince, end: Math.max(t.runningSince, now) });
  let remaining = timerLimitMs(t);
  return all
    .map((s) => {
      const duration = Math.min(Math.max(0, s.end - s.start), remaining);
      remaining -= duration;
      return { start: s.start, end: s.start + duration };
    })
    .filter((s) => s.end > s.start);
}
export function splitByDay(segments: Segment[]): Record<string, number> {
  const days: Record<string, number> = {};
  for (const s of segments) {
    let at = s.start;
    while (at < s.end) {
      const d = new Date(at),
        key = localDate(d);
      d.setHours(24, 0, 0, 0);
      const end = Math.min(s.end, d.getTime());
      if (end <= at) break;
      days[key] = (days[key] || 0) + (end - at) / 60000;
      at = end;
    }
  }
  return days;
}
export async function startTimer(
  config: Partial<TimerState>,
  now = Date.now(),
): Promise<TimerState> {
  return db.transaction(
    "rw",
    [db.timers, db.settings, db.records],
    async () => {
      if (await db.timers.get("active"))
        throw new Error("計測中のタイマーがあります。");
      const t: TimerState = {
        id: "active",
        token: crypto.randomUUID(),
        mode: "stopwatch",
        targetId: "",
        subjectId: "",
        unitId: "",
        method: "読書",
        startedAt: now,
        runningSince: now,
        segments: [],
        durationMinutes: 25,
        focusMinutes: 25,
        breakMinutes: 5,
        phase: "focus",
        ...config,
      };
      t.id = "active";
      t.token = crypto.randomUUID();
      t.startedAt = now;
      t.runningSince = now;
      t.segments = [];
      if (!t.targetId) throw new Error("学習対象を選択してください。");
      const target = await db.records.get(t.targetId);
      if (!target || target.kind !== "target" || target.deletedAt)
        throw new Error("有効な学習対象を選択してください。");
      if (t.subjectId) {
        const subject = await db.records.get(t.subjectId);
        if (
          !subject ||
          subject.kind !== "subject" ||
          subject.targetId !== t.targetId ||
          subject.deletedAt
        )
          throw new Error("有効な科目を選択してください。");
      }
      if (t.unitId) {
        const unit = await db.records.get(t.unitId);
        if (
          !unit ||
          unit.kind !== "unit" ||
          unit.targetId !== t.targetId ||
          unit.subjectId !== t.subjectId ||
          unit.deletedAt
        )
          throw new Error("有効な単元を選択してください。");
      }
      if (
        !["stopwatch", "countdown", "pomodoro"].includes(t.mode) ||
        ![t.durationMinutes, t.focusMinutes, t.breakMinutes].every(
          (n) => Number.isFinite(n) && n > 0 && n <= 1440,
        )
      )
        throw new Error("タイマー時間は1日以内の正の数を指定してください。");
      await db.timers.add(t);
      await setPreferences({
        lastTimer: {
          mode: t.mode,
          targetId: t.targetId,
          subjectId: t.subjectId,
          unitId: t.unitId,
          method: t.method,
          durationMinutes: t.durationMinutes,
          focusMinutes: t.focusMinutes,
          breakMinutes: t.breakMinutes,
        },
      });
      return t;
    },
  );
}
export async function pauseTimer(token: string, now = Date.now()) {
  return db.transaction("rw", db.timers, async () => {
    const t = await db.timers.get("active");
    if (!t || t.token !== token)
      throw new Error("タイマーが変更されています。");
    if (t.runningSince === null) return t;
    const next = { ...t, segments: closedSegments(t, now), runningSince: null };
    await db.timers.put(next);
    return next;
  });
}
export async function resumeTimer(token: string, now = Date.now()) {
  return db.transaction("rw", db.timers, async () => {
    const t = await db.timers.get("active");
    if (!t || t.token !== token)
      throw new Error("タイマーが変更されています。");
    if (t.runningSince !== null) return t;
    if (elapsedMs(t, now) >= timerLimitMs(t))
      throw new Error("設定時間に達しました。終了して記録してください。");
    const next = { ...t, runningSince: now };
    await db.timers.put(next);
    return next;
  });
}
export async function finishTimer(
  token: string,
  now = Date.now(),
): Promise<Session | undefined> {
  return db.transaction("rw", [db.timers, db.records, db.outbox], async () => {
    const id = `session-${token}`,
      existing = await db.records.get(id);
    if (existing) return existing as Session;
    const t = await db.timers.get("active");
    if (!t || t.token !== token)
      throw new Error("タイマーが変更されています。");
    let session: Session | undefined;
    if (t.phase !== "break") {
      const segments = closedSegments(t, now),
        minutes = segments.reduce((a, s) => a + (s.end - s.start) / 60000, 0);
      if (minutes <= 0)
        throw new Error(
          "学習時間が0分です。少し計測してから記録してください。",
        );
      session = await saveEntity<Session>({
        id,
        kind: "session",
        targetId: t.targetId,
        subjectId: t.subjectId,
        unitId: t.unitId,
        method: t.method,
        segments,
        minutes,
        memo: "",
      });
    }
    await db.timers.delete("active");
    return session;
  });
}
