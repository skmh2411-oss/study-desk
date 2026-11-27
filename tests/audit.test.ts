import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const syncMock = vi.hoisted(() => ({ rpc: vi.fn(), getUser: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: syncMock.rpc,
    auth: { getUser: syncMock.getUser },
  }),
}));
import { runSync, resolveConflict } from "../src/sync";
import { db, saveEntity } from "../src/db";
import {
  startTimer,
  pauseTimer,
  resumeTimer,
  finishTimer,
  splitByDay,
} from "../src/timer";
import {
  previewImport,
  applyImport,
  normalizeEntity,
  sessionsToCSV,
} from "../src/exchange";
import { createEmptyCard, reviewCard } from "../src/review";
import type { Flashcard } from "../src/models";
import type { Entity, Target } from "../src/models";

beforeEach(async () => {
  vi.stubEnv("VITE_SUPABASE_ORIGIN", "https://audit.supabase.co");
  await db.delete();
  await db.open();
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) || null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  localStorage.setItem(
    "study-desk-sync-config",
    JSON.stringify({
      url: "https://audit.supabase.co",
      key: "sb_publishable_audit",
      enabled: true,
    }),
  );
  vi.stubGlobal("navigator", { onLine: true });
  syncMock.getUser.mockResolvedValue({
    data: { user: { id: "audit-user" } },
    error: null,
  });
  syncMock.rpc.mockReset();
});
const target = () =>
  saveEntity<Target>({
    kind: "target",
    title: "Audit target",
    examDate: "2030-01-10",
    goalMinutes: 120,
    passCriteria: "",
  });
const wrap = (records: unknown[]) =>
  JSON.stringify({ format: "study-desk", schemaVersion: 1, records });
function note(id: string, title = "Audit note"): Entity {
  return {
    id,
    kind: "note",
    title,
    body: "safe",
    tags: [],
    bookmark: false,
    importance: 3,
    source: "",
    verifiedOn: "",
    createdAt: "2026-11-27T00:00:00.000Z",
    updatedAt: "2026-11-27T00:00:00.000Z",
    version: 1,
  };
}

describe("Independent data safety audit", () => {
  it("blocks a stale editor without changing the current record", async () => {
    const first = await target();
    await saveEntity({ ...first, title: "New title" }, first.version);
    await expect(
      saveEntity({ ...first, title: "Stale title" }, first.version),
    ).rejects.toThrow();
    expect((await db.records.get(first.id))?.title).toBe("New title");
  });
  it("concurrent stop requests create at most one study record", async () => {
    const t = await target();
    const start = Date.parse("2026-11-27T10:00:00Z");
    const active = await startTimer(
      { targetId: t.id, mode: "stopwatch" },
      start,
    );
    await Promise.allSettled([
      finishTimer(active.token, start + 60000),
      finishTimer(active.token, start + 60000),
    ]);
    const records = await db.records.toArray();
    expect(records.filter((r) => r.kind === "session")).toHaveLength(1);
    expect(records.find((r) => r.kind === "session")?.minutes).toBe(1);
    expect(await db.timers.get("active")).toBeUndefined();
  });
  it("one active timer survives attempts to start a second", async () => {
    const t = await target();
    const now = Date.now();
    const results = await Promise.allSettled([
      startTimer({ targetId: t.id }, now),
      startTimer({ targetId: t.id }, now),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.timers.count()).toBe(1);
  });
  it("excludes pause time through reload and resume", async () => {
    const t = await target();
    const now = Date.parse("2026-11-27T10:00:00Z");
    const active = await startTimer({ targetId: t.id }, now);
    await pauseTimer(active.token, now + 60000);
    db.close();
    await db.open();
    await resumeTimer(active.token, now + 3600000);
    await finishTimer(active.token, now + 3660000);
    const session = (await db.records.toArray()).find(
      (r) => r.kind === "session",
    );
    expect(session?.minutes).toBe(2);
  });
  it("splits real local midnight rather than allocating pause time", () => {
    const midnight = new Date(2026, 10, 28, 0, 0, 0).getTime();
    const split = splitByDay([
      { start: midnight - 60000, end: midnight },
      { start: midnight + 3600000, end: midnight + 3660000 },
    ]);
    expect(split["2026-11-27"]).toBe(1);
    expect(split["2026-11-28"]).toBe(1);
    expect(Object.values(split).reduce((a, b) => a + b, 0)).toBe(2);
  });
  it("rejects an invalid final import record before writing the earlier valid record", async () => {
    await expect(
      previewImport(
        wrap([
          note("valid-id"),
          { ...note("bad-id"), kind: "session", minutes: -10 },
        ]),
      ),
    ).rejects.toThrow();
    expect(await db.records.count()).toBe(0);
  });
  it("does not overwrite an ID conflict or duplicate a repeated import", async () => {
    const first = await previewImport(wrap([note("import-note")]));
    await applyImport(first);
    await applyImport(
      await previewImport(wrap([note("import-note", "Conflicting title")])),
    );
    await applyImport(await previewImport(wrap([note("import-note")])));
    expect(await db.records.count()).toBe(1);
    expect((await db.records.get("import-note"))?.title).toBe("Audit note");
  });
  it("does not trust a mutated preview at import commit time", async () => {
    const p = await previewImport(wrap([note("preview-note")]));
    p.records[0] = { ...p.records[0], importance: 999 };
    await expect(applyImport(p)).rejects.toThrow();
    expect(await db.records.count()).toBe(0);
  });
  it("rejects duplicate FSRS ratings submitted from the same card version", async () => {
    const c = await saveEntity<Flashcard>({
      kind: "card",
      question: "Question",
      answer: "Answer",
      explanation: "",
      tags: [],
      importance: 3,
      source: "",
      fsrs: createEmptyCard(new Date()),
      history: [],
    });
    const results = await Promise.allSettled([
      reviewCard(c.id, c.version, 3),
      reviewCard(c.id, c.version, 3),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await db.records.get(c.id))?.history).toHaveLength(1);
  });
  it("rejects fractional FSRS states that cannot be scheduled", () => {
    expect(() =>
      normalizeEntity({
        kind: "card",
        question: "q",
        answer: "a",
        fsrs: { ...createEmptyCard(new Date()), state: 1.5 },
      }),
    ).toThrow();
  });
  it("rejects imported quizzes that have no usable correct choice", () => {
    expect(() =>
      normalizeEntity({
        kind: "question",
        question: "q",
        answer: "A",
        choices: [],
      }),
    ).toThrow();
    expect(() =>
      normalizeEntity({
        kind: "question",
        question: "q",
        answer: "C",
        choices: ["A", "B"],
      }),
    ).toThrow();
  });
  it("rejects malformed JSON and unsupported schema versions", async () => {
    await expect(previewImport("{")).rejects.toThrow();
    await expect(
      previewImport(
        JSON.stringify({
          format: "study-desk",
          schemaVersion: 999,
          records: [],
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("Independent synchronization audit using a mocked transport", () => {
  it("retains a concurrent local edit after acknowledging an older pushed version", async () => {
    const original = await target();
    syncMock.rpc.mockImplementation(async (name: string) => {
      if (name === "study_push") {
        await saveEntity(
          { ...original, title: "Edit during upload" },
          original.version,
        );
        return { data: { ok: true, revision: 1, data: original }, error: null };
      }
      return { data: { cursor: 1, records: [] }, error: null };
    });
    await runSync();
    expect((await db.records.get(original.id))?.title).toBe(
      "Edit during upload",
    );
    expect((await db.outbox.get(original.id))?.version).toBe(2);
  });
  it("rejects malformed remote records before changing the local database or cursor", async () => {
    syncMock.rpc.mockResolvedValue({
      data: {
        cursor: 10,
        records: [
          {
            id: "broken-card",
            revision: 10,
            data: {
              id: "broken-card",
              kind: "card",
              createdAt: "2026-11-27T00:00:00Z",
              updatedAt: "2026-11-27T00:00:00Z",
              version: 1,
              question: "x",
              answer: "y",
              fsrs: { due: "invalid" },
              history: [],
            },
          },
        ],
      },
      error: null,
    });
    await expect(runSync()).rejects.toThrow();
    expect(await db.records.count()).toBe(0);
    expect(await db.syncMeta.get("cursor")).toBeUndefined();
  });
  it("keeps a conflict resolvable after a later local edit", async () => {
    const original = await target();
    const remote = { ...original, title: "Remote edit", version: 2 };
    await db.conflicts.put({ id: original.id, local: original, remote });
    await db.syncMeta.put({
      key: `conflict-revision:${original.id}`,
      value: 2,
    });
    await saveEntity(
      { ...original, title: "Latest local edit" },
      original.version,
    );
    syncMock.rpc.mockResolvedValue({
      data: { cursor: 2, records: [] },
      error: null,
    });
    await runSync();
    await expect(
      resolveConflict(original.id, "local"),
    ).resolves.toBeUndefined();
    expect((await db.records.get(original.id))?.title).toBe(
      "Latest local edit",
    );
    expect(await db.conflicts.get(original.id)).toBeUndefined();
  });
});

import { generatePlan, applyPlan } from "../src/planner";
import { defaultPreferences, type Subject, type Task } from "../src/models";

describe("Independent planner audit", () => {
  it("respects daily capacity, unavailable dates, completed history and shortages", async () => {
    const t = await target();
    const s = await saveEntity<Subject>({
      kind: "subject",
      targetId: t.id,
      title: "Subject",
      importance: 5,
      mastery: 0,
      requiredMinutes: 600,
      status: "未着手",
    });
    const completed = await saveEntity<Task>({
      kind: "task",
      targetId: t.id,
      subjectId: s.id,
      date: "2030-01-02",
      minutes: 20,
      completed: true,
      review: false,
      planId: "old",
    });
    const past = await saveEntity<Task>({
      kind: "task",
      targetId: t.id,
      subjectId: s.id,
      date: "2029-12-31",
      minutes: 30,
      completed: false,
      review: false,
      planId: "old",
    });
    const preferences = {
      ...defaultPreferences,
      weekdayMinutes: [60, 60, 60, 60, 60, 60, 60],
      unavailableDates: ["2030-01-03"],
      bufferDays: 0,
    };
    const p = generatePlan({
      target: { ...t, examDate: "2030-01-04" },
      subjects: [s],
      sessions: [],
      tasks: [completed, past],
      preferences,
      startDate: "2030-01-01",
    });
    expect(p.shortageMinutes).toBeGreaterThan(0);
    expect(p.preservedTaskIds).toEqual(
      expect.arrayContaining([completed.id, past.id]),
    );
    expect(p.replaceTaskIds).not.toEqual(
      expect.arrayContaining([completed.id]),
    );
    expect(
      p.tasks.every(
        (task) =>
          task.minutes > 0 &&
          task.date >= "2030-01-01" &&
          task.date < "2030-01-04" &&
          task.date !== "2030-01-03",
      ),
    ).toBe(true);
    expect(
      p.tasks
        .filter((task) => task.date === "2030-01-01")
        .reduce((n, task) => n + task.minutes, 0),
    ).toBeLessThanOrEqual(60.00001);
    expect(
      p.tasks
        .filter((task) => task.date === "2030-01-02")
        .reduce((n, task) => n + task.minutes, 0),
    ).toBeLessThanOrEqual(40.00001);
  });
  it("refuses a plan preview after a data edit without deleting current tasks", async () => {
    const t = await target();
    const existing = await saveEntity<Task>({
      kind: "task",
      targetId: t.id,
      subjectId: "",
      date: "2030-01-01",
      minutes: 20,
      completed: false,
      review: false,
      planId: "old",
    });
    const p = generatePlan({
      target: t,
      subjects: [],
      sessions: [],
      tasks: [existing],
      preferences: defaultPreferences,
      startDate: "2030-01-01",
    });
    await saveEntity({ ...t, title: "Changed after preview" }, t.version);
    await expect(applyPlan(p)).rejects.toThrow();
    expect((await db.records.get(existing.id))?.deletedAt).toBeUndefined();
    expect(
      (await db.records.toArray()).filter((r) => r.kind === "task"),
    ).toHaveLength(1);
  });
});
