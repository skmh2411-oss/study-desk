import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  db,
  saveEntity,
  getPreferences,
  setPreferences,
  trashEntity,
  restoreEntity,
} from "../src/db";
import {
  startTimer,
  pauseTimer,
  resumeTimer,
  finishTimer,
  elapsedMs,
  splitByDay,
} from "../src/timer";
import { generatePlan, applyPlan } from "../src/planner";
import {
  createBackup,
  previewImport,
  applyImport,
  normalizeEntity,
  sessionsToCSV,
} from "../src/exchange";
import {
  defaultPreferences,
  type Target,
  type Subject,
  type Session,
  type Task,
} from "../src/models";
beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});
async function target() {
  return saveEntity<Target>({
    kind: "target",
    title: "試験",
    examDate: "2026-12-10",
    goalMinutes: 600,
    passCriteria: "",
  });
}
const envelope = (records: unknown[]) =>
  JSON.stringify({ format: "study-desk", schemaVersion: 1, records });
describe("persistent timer integrity", () => {
  it("resumes persisted state, excludes pauses and saves once concurrently", async () => {
    const t = await target(),
      state = await startTimer({ targetId: t.id }, 1000);
    await pauseTimer(state.token, 61000);
    await resumeTimer(state.token, 121000);
    expect(elapsedMs((await db.timers.get("active"))!, 181000)).toBe(120000);
    const both = await Promise.all([
      finishTimer(state.token, 181000),
      finishTimer(state.token, 181000),
    ]);
    expect(both[0]!.id).toBe(both[1]!.id);
    expect(both[0]!.minutes).toBe(2);
    expect(await db.records.where("kind").equals("session").count()).toBe(1);
    expect(await db.timers.count()).toBe(0);
  });
  it("prevents simultaneous start and caps countdown background time", async () => {
    const t = await target();
    const starts = await Promise.allSettled([
      startTimer(
        { targetId: t.id, mode: "countdown", durationMinutes: 2 },
        1000,
      ),
      startTimer({ targetId: t.id }, 1000),
    ]);
    expect(starts.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    const state = (await db.timers.get("active"))!;
    expect(elapsedMs(state, 601000)).toBe(120000);
    const done = await finishTimer(state.token, 601000);
    expect(done!.minutes).toBe(2);
  });
  it("splits actual intervals across local midnight precisely", () => {
    const a = new Date(2026, 10, 27, 23, 50).getTime(),
      b = new Date(2026, 10, 28, 0, 20).getTime();
    expect(splitByDay([{ start: a, end: b }])).toEqual({
      "2026-11-27": 10,
      "2026-11-28": 20,
    });
  });
});
describe("non-destructive store and exchange", () => {
  it("rejects malformed settings and domain edits before replacing persisted data", async () => {
    const t = await target();
    await expect(saveEntity({ ...t, title: "" })).rejects.toThrow();
    expect((await db.records.get(t.id))!.title).toBe("試験");
    await setPreferences({ dailyNewLimit: 30 });
    await expect(
      setPreferences({ weekdayMinutes: [NaN, 60, 60, 60, 60, 60, 60] }),
    ).rejects.toThrow();
    expect((await getPreferences()).dailyNewLimit).toBe(30);
    expect((await getPreferences()).weekdayMinutes.every(Number.isFinite)).toBe(
      true,
    );
  });
  it("rejects stale writes, retains trash, and restores", async () => {
    const t = await target();
    await saveEntity({ ...t, title: "更新" });
    await expect(saveEntity({ ...t, title: "古い変更" })).rejects.toThrow();
    await trashEntity(t.id);
    expect((await db.records.get(t.id))!.deletedAt).toBeTruthy();
    await restoreEntity(t.id);
    expect((await db.records.get(t.id))!.deletedAt).toBeUndefined();
  });
  it("backup roundtrip is additive and revives dates", async () => {
    const t = await target();
    const card = normalizeEntity({
      kind: "card",
      targetId: t.id,
      question: "Q",
      answer: "A",
    });
    await saveEntity(card);
    const backup = await createBackup();
    const first = await previewImport(backup);
    expect(first.records).toHaveLength(0);
    expect(first.duplicates).toBe(2);
    await db.records.clear();
    const p = await previewImport(backup);
    expect(p.records).toHaveLength(2);
    await applyImport(p);
    const row = (await db.records.get(card.id))!;
    expect((row.fsrs as any).due).toBeInstanceOf(Date);
  });
  it("rejects malformed later row and missing hierarchy without partial writes", async () => {
    await expect(
      previewImport(
        envelope([
          { kind: "target", title: "valid" },
          { kind: "card", question: "missing answer" },
        ]),
      ),
    ).rejects.toThrow();
    expect(await db.records.count()).toBe(0);
    await expect(
      previewImport(
        envelope([{ kind: "subject", title: "orphan", targetId: "missing" }]),
      ),
    ).rejects.toThrow();
    expect(await db.records.count()).toBe(0);
  });
  it("skips duplicates and ID conflicts without overriding existing records", async () => {
    const t = await target();
    const p = await previewImport(
      envelope([
        { ...t, title: "different" },
        { ...t, id: "duplicate-target" },
      ]),
    );
    expect(p.conflicts).toBe(1);
    expect(p.duplicates).toBe(1);
    await applyImport(p);
    expect((await db.records.get(t.id))!.title).toBe("試験");
    expect(await db.records.count()).toBe(1);
  });
  it("neutralizes spreadsheet formula fields in CSV", () => {
    const row = {
      id: "a",
      targetId: "b",
      subjectId: "",
      unitId: "",
      kind: "session",
      minutes: 1,
      method: "=1+1",
      memo: "@SUM(1)",
      segments: [{ start: 1000, end: 61000 }],
    } as Session;
    const csv = sessionsToCSV([row]);
    expect(csv).toContain("'=1+1");
    expect(csv).toContain("'@SUM(1)");
  });
});
describe("plan feasibility and approval", () => {
  it("reserves other targets pending tasks in addition to their actual study", async () => {
    const t = await target(),
      a = await saveEntity<Target>({
        kind: "target",
        title: "対象A",
        examDate: "2026-12-10",
        goalMinutes: 60,
        passCriteria: "",
      }),
      b = await saveEntity<Target>({
        kind: "target",
        title: "対象B",
        examDate: "2026-12-10",
        goalMinutes: 60,
        passCriteria: "",
      });
    const start = new Date("2026-12-05T08:00:00").getTime();
    const session = await saveEntity<Session>({
      kind: "session",
      targetId: a.id,
      subjectId: "",
      unitId: "",
      method: "読書",
      segments: [{ start, end: start + 3600000 }],
      minutes: 60,
      memo: "",
    });
    const pending = await saveEntity<Task>({
      kind: "task",
      targetId: b.id,
      subjectId: "",
      date: "2026-12-05",
      minutes: 30,
      completed: false,
      review: false,
      planId: "other",
    });
    const p = generatePlan({
      target: t,
      subjects: [],
      sessions: [session],
      tasks: [pending],
      preferences: {
        ...defaultPreferences,
        weekdayMinutes: Array(7).fill(120),
      },
      startDate: "2026-12-05",
    });
    expect(
      p.tasks
        .filter((t) => t.date === "2026-12-05")
        .reduce((sum, t) => sum + t.minutes, 0),
    ).toBeCloseTo(30);
  });
  it("shares actual daily capacity across targets and invalidates previews on another target session", async () => {
    const t = await target(),
      other = await saveEntity<Target>({
        kind: "target",
        title: "別試験",
        examDate: "2026-12-10",
        goalMinutes: 60,
        passCriteria: "",
      });
    const start = new Date("2026-12-05T08:00:00").getTime();
    const session = await saveEntity<Session>({
      kind: "session",
      targetId: other.id,
      subjectId: "",
      unitId: "",
      method: "読書",
      segments: [{ start, end: start + 3600000 }],
      minutes: 60,
      memo: "",
    });
    const prefs = { ...defaultPreferences, weekdayMinutes: Array(7).fill(60) };
    await setPreferences(prefs);
    const p = generatePlan({
      target: t,
      subjects: [],
      sessions: [session],
      tasks: [],
      preferences: prefs,
      startDate: "2026-12-05",
    });
    expect(p.availableMinutes).toBe(120);
    expect(p.tasks.some((t) => t.date === "2026-12-05")).toBe(false);
    await saveEntity({ ...session, memo: "更新" });
    await expect(applyPlan(p)).rejects.toThrow();
    expect(await db.records.where("kind").equals("task").count()).toBe(0);
  });
  it("covers target remaining goal and reports shortage, excluding buffers", async () => {
    const t = await target();
    const s = await saveEntity<Subject>({
      kind: "subject",
      title: "科目",
      targetId: t.id,
      importance: 5,
      mastery: 0,
      requiredMinutes: 60,
      status: "未着手",
    });
    const p = generatePlan({
      target: t,
      subjects: [s],
      sessions: [],
      tasks: [],
      preferences: { ...defaultPreferences, weekdayMinutes: Array(7).fill(60) },
      startDate: "2026-12-05",
    });
    expect(p.requiredMinutes).toBe(750);
    expect(p.availableMinutes).toBe(180);
    expect(p.shortageMinutes).toBeCloseTo(570);
    expect(p.tasks.every((t) => t.date < "2026-12-08")).toBe(true);
    expect(p.tasks.reduce((a, t) => a + t.minutes, 0)).toBeCloseTo(180);
  });
  it("keeps completed and past tasks; stale preview cannot overwrite edits", async () => {
    const t = await target(),
      prefs = await getPreferences();
    const completed = await saveEntity<Task>({
      kind: "task",
      targetId: t.id,
      subjectId: "",
      date: "2026-12-01",
      minutes: 20,
      completed: true,
      review: false,
      planId: "old",
    });
    const past = await saveEntity<Task>({
      kind: "task",
      targetId: t.id,
      subjectId: "",
      date: "2026-11-01",
      minutes: 10,
      completed: false,
      review: false,
      planId: "old",
    });
    const pending = await saveEntity<Task>({
      kind: "task",
      targetId: t.id,
      subjectId: "",
      date: "2026-12-02",
      minutes: 20,
      completed: false,
      review: false,
      planId: "old",
    });
    const input = {
      target: t,
      subjects: [],
      sessions: [],
      tasks: [completed, past, pending],
      preferences: prefs,
      startDate: "2026-11-27",
    };
    const p = generatePlan(input);
    expect(p.preservedTaskIds).toEqual([completed.id, past.id]);
    await saveEntity({ ...pending, minutes: 30 });
    await expect(applyPlan(p)).rejects.toThrow();
    expect((await db.records.get(pending.id))!.deletedAt).toBeUndefined();
    const next = generatePlan({
      ...input,
      tasks: [completed, past, (await db.records.get(pending.id))! as Task],
    });
    await applyPlan(next);
    expect((await db.records.get(pending.id))!.deletedAt).toBeTruthy();
    expect((await db.records.get(completed.id))!.deletedAt).toBeUndefined();
    expect((await db.records.get(past.id))!.deletedAt).toBeUndefined();
  });
});
