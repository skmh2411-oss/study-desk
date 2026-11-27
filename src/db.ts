import Dexie, { type Table } from "dexie";
import { normalizeEntity, normalizePreferences } from "./validation";
import {
  defaultPreferences,
  type Entity,
  type TimerState,
  type Preferences,
} from "./models";
export interface OutboxEntry {
  id: string;
  version: number;
}
export interface Conflict {
  id: string;
  local: Entity;
  remote: Entity;
}
class StudyDatabase extends Dexie {
  records!: Table<Entity, string>;
  timers!: Table<TimerState, string>;
  settings!: Table<Preferences, string>;
  outbox!: Table<OutboxEntry, string>;
  syncMeta!: Table<{ key: string; value: unknown }, string>;
  conflicts!: Table<Conflict, string>;
  constructor() {
    super("study-desk-v1");
    this.version(1).stores({
      records: "id,kind,targetId,subjectId,updatedAt,deletedAt",
      timers: "id",
      settings: "id",
      outbox: "id",
      syncMeta: "key",
      conflicts: "id",
    });
  }
}
export const db = new StudyDatabase();
export async function saveEntity<T extends Entity>(
  input: Partial<T> & { kind: T["kind"] },
  expectedVersion?: number,
): Promise<T> {
  return db.transaction("rw", [db.records, db.outbox], async () => {
    const id = input.id || crypto.randomUUID(),
      old = await db.records.get(id);
    const expected = expectedVersion ?? input.version;
    if (old && (expected === undefined || expected !== old.version))
      throw new Error(
        "別の画面で更新されています。読み直してから保存してください。",
      );
    if (old && old.kind !== input.kind)
      throw new Error("データ種別を変更できません。");
    const now = new Date().toISOString();
    const record = normalizeEntity({
      ...old,
      ...input,
      id,
      createdAt: old?.createdAt || now,
      updatedAt: now,
      version: (old?.version || 0) + 1,
    }) as T;
    await db.records.put(record);
    await db.outbox.put({ id, version: record.version });
    return record;
  });
}
export async function trashEntity(id: string) {
  return db.transaction("rw", [db.records, db.outbox], async () => {
    const row = await db.records.get(id);
    if (!row) throw new Error("データが見つかりません。");
    if (row.deletedAt) return;
    await saveEntity({ ...row, deletedAt: new Date().toISOString() });
  });
}
export async function restoreEntity(id: string) {
  return db.transaction("rw", [db.records, db.outbox], async () => {
    const row = await db.records.get(id);
    if (!row) throw new Error("データが見つかりません。");
    await saveEntity({ ...row, deletedAt: undefined });
  });
}
export async function getPreferences(): Promise<Preferences> {
  return { ...defaultPreferences, ...(await db.settings.get("preferences")) };
}
export async function setPreferences(patch: Partial<Preferences>) {
  return db.transaction("rw", db.settings, async () => {
    const prefs = normalizePreferences({
      ...(await getPreferences()),
      ...patch,
      id: "preferences",
    });
    await db.settings.put(prefs);
    return prefs;
  });
}
