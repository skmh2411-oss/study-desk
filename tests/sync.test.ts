import "fake-indexeddb/auto";
import { beforeEach, describe, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  getUser: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: mocks.rpc,
    auth: {
      getUser: mocks.getUser,
      signInWithPassword: mocks.signIn,
      signOut: mocks.signOut,
    },
  }),
}));
import { db, saveEntity } from "../src/db";
import {
  saveSyncConfig,
  validateSyncConfig,
  runSync,
  resolveConflict,
} from "../src/sync";
import type { Entity } from "../src/models";
const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (k: string) => memory.get(k) || null,
    setItem: (k: string, v: string) => memory.set(k, v),
  },
  configurable: true,
});
Object.defineProperty(globalThis.navigator, "onLine", {
  value: true,
  writable: true,
  configurable: true,
});
const config = {
  url: "https://project.supabase.co",
  key: "sb_publishable_test",
  enabled: false,
};
const target = (id = "target-1", title = "試験"): Entity => ({
  id,
  kind: "target",
  title,
  examDate: "",
  goalMinutes: 60,
  passCriteria: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1,
});
beforeEach(async () => {
  vi.stubEnv("VITE_SUPABASE_ORIGIN", "https://project.supabase.co");
  await db.open();
  await Promise.all(db.tables.map((t) => t.clear()));
  memory.clear();
  mocks.rpc.mockReset();
  mocks.getUser.mockResolvedValue({
    data: { user: { id: "owner-1" } },
    error: null,
  });
  saveSyncConfig(config);
  Object.defineProperty(globalThis.navigator, "onLine", {
    value: true,
    writable: true,
    configurable: true,
  });
});
describe("同期の安全性（モック）", () => {
  it("秘密鍵とHTTP接続先を拒否する", () => {
    expect(() =>
      validateSyncConfig({ ...config, key: "sb_secret_123" }),
    ).toThrow();
    expect(() =>
      validateSyncConfig({ ...config, url: "http://project.supabase.co" }),
    ).toThrow();
    const key = `eyJ.${btoa(JSON.stringify({ role: "service_role" }))}.sig`;
    expect(() => validateSyncConfig({ ...config, key })).toThrow();
  });
  it("未接続時のローカル編集はキューに残る", async () => {
    const row = await saveEntity(target());
    expect(await db.outbox.get(row.id)).toEqual({ id: row.id, version: 1 });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("送信中の追加編集をキューから消さない", async () => {
    await saveEntity(target());
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "study_push") {
        await saveEntity({ ...target(), title: "送信中の編集", version: 1 });
        return { data: { ok: true, revision: 1, data: target() }, error: null };
      }
      return { data: { cursor: 1, records: [] }, error: null };
    });
    await runSync();
    expect((await db.outbox.get("target-1"))?.version).toBe(2);
    expect((await db.records.get("target-1"))?.title).toBe("送信中の編集");
  });
  it("競合は上書きせず両方の版を保持する", async () => {
    await saveEntity(target());
    mocks.rpc.mockImplementation(async (name: string) =>
      name === "study_push"
        ? {
            data: {
              ok: false,
              revision: 2,
              data: target("target-1", "別端末"),
            },
            error: null,
          }
        : { data: { cursor: 2, records: [] }, error: null },
    );
    await runSync();
    expect((await db.records.get("target-1"))?.title).toBe("試験");
    expect((await db.conflicts.get("target-1"))?.remote.title).toBe("別端末");
    expect(await db.outbox.get("target-1")).toBeDefined();
  });
  it("競合後の追加編集は次の同期でプレビューを更新できる", async () => {
    await saveEntity(target());
    await db.conflicts.put({
      id: "target-1",
      local: target(),
      remote: target("target-1", "別端末"),
    });
    await db.syncMeta.put({ key: "conflict-revision:target-1", value: 2 });
    await saveEntity({ ...target(), version: 1, title: "さらに編集" });
    mocks.rpc.mockResolvedValue({
      data: { cursor: 2, records: [] },
      error: null,
    });
    await runSync();
    expect((await db.conflicts.get("target-1"))?.local.title).toBe(
      "さらに編集",
    );
    await resolveConflict("target-1", "local");
    expect(await db.conflicts.count()).toBe(0);
    expect((await db.records.get("target-1"))?.title).toBe("さらに編集");
    expect(
      await db.syncMeta
        .filter((x) => x.key.startsWith("conflict-archive:"))
        .toArray(),
    ).toHaveLength(1);
  });
  it("不正なカードを全件保存前に拒否する", async () => {
    mocks.rpc.mockResolvedValue({
      data: {
        cursor: 2,
        records: [
          { id: "target-1", revision: 1, data: target() },
          {
            id: "bad",
            revision: 2,
            data: {
              ...target("bad"),
              kind: "card",
              question: "Q",
              answer: "A",
              history: "bad",
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
  it("参照先のない科目の差分を保存しない", async () => {
    mocks.rpc.mockResolvedValue({
      data: {
        cursor: 1,
        records: [
          {
            id: "subject-1",
            revision: 1,
            data: {
              ...target("subject-1"),
              kind: "subject",
              title: "科目",
              targetId: "missing",
              importance: 3,
              mastery: 0,
              requiredMinutes: 60,
              status: "未着手",
            },
          },
        ],
      },
      error: null,
    });
    await expect(runSync()).rejects.toThrow("参照先");
    expect(await db.records.count()).toBe(0);
  });
  it("異なる本人アカウントへの接続では学習データを送信しない", async () => {
    await db.syncMeta.put({
      key: "account-binding",
      value: "project.supabase.co/another-user",
    });
    await saveEntity(target());
    await expect(runSync()).rejects.toThrow("別の同期アカウント");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("オフライン時も変更キューを保持する", async () => {
    await saveEntity(target());
    Object.defineProperty(globalThis.navigator, "onLine", {
      value: false,
      writable: true,
      configurable: true,
    });
    await expect(runSync()).rejects.toThrow("オフライン");
    expect(await db.outbox.count()).toBe(1);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
