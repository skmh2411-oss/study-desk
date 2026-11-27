import Dexie, { type Table } from "dexie";
import { normalizeEntity, normalizePreferences } from "./validation";
import { normalizeReferenceSite } from "./references";
import {
  defaultPreferences,
  type Entity,
  type TimerState,
  type Preferences,
  type ReferenceSite,
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
export class StudyDatabase extends Dexie {
  records!: Table<Entity, string>;
  timers!: Table<TimerState, string>;
  settings!: Table<Preferences, string>;
  outbox!: Table<OutboxEntry, string>;
  syncMeta!: Table<{ key: string; value: unknown }, string>;
  conflicts!: Table<Conflict, string>;
  referenceSites!: Table<ReferenceSite, string>;
  constructor(name = "study-desk-v1") {
    super(name);
    this.version(1).stores({
      records: "id,kind,targetId,subjectId,updatedAt,deletedAt",
      timers: "id",
      settings: "id",
      outbox: "id",
      syncMeta: "key",
      conflicts: "id",
    });
    this.version(2).stores({
      referenceSites: "id,targetId,priority,updatedAt,deletedAt",
    });
  }
}
export const db = new StudyDatabase();
export async function saveEntity<T extends Entity>(
  input: Partial<T> & { kind: T["kind"] },
  expectedVersion?: number,
  options?: { verifySource?: boolean },
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
    if (
      old?.sourceStatus === "verified" &&
      !options?.verifySource &&
      [
        "question",
        "answer",
        "answerUnit",
        "conditions",
        "source",
        "sourceUrl",
      ].some((key) => old[key] !== record[key])
    ) {
      const sourceRecord = record as Entity;
      sourceRecord.sourceStatus = "unverified";
      if (Array.isArray(sourceRecord.citations))
        sourceRecord.citations = sourceRecord.citations.map((c: any) => ({
          ...c,
          checkedOn: "",
        }));
    }
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

/** Reference sites stay local and are intentionally excluded from cloud outbox. */
export async function saveReferenceSite(
  input: Partial<ReferenceSite>,
  expectedVersion?: number,
): Promise<ReferenceSite> {
  return db.transaction("rw", [db.referenceSites, db.records], async () => {
    const id = input.id || crypto.randomUUID();
    const old = await db.referenceSites.get(id);
    const expected = expectedVersion ?? input.version;
    if (old && (expected === undefined || expected !== old.version))
      throw new Error(
        "出典サイトが別の画面で更新されています。読み直してください。",
      );
    const now = new Date().toISOString();
    const site = normalizeReferenceSite({
      ...old,
      ...input,
      id,
      createdAt: old?.createdAt || now,
      updatedAt: now,
      version: (old?.version || 0) + 1,
    });
    if (site.targetId) {
      const target = await db.records.get(site.targetId);
      if (!target || target.kind !== "target")
        throw new Error("出典サイトの学習対象が見つかりません。");
    }
    const duplicate = await db.referenceSites
      .where("targetId")
      .equals(site.targetId)
      .filter((other) => other.id !== site.id && other.url === site.url)
      .first();
    if (duplicate)
      throw new Error(
        "同じURLの出典サイトが登録済みです。ゴミ箱の項目も確認してください。",
      );
    await db.referenceSites.put(site);
    return site;
  });
}
export async function trashReferenceSite(id: string, expectedVersion?: number) {
  return db.transaction("rw", [db.referenceSites, db.records], async () => {
    const site = await db.referenceSites.get(id);
    if (!site) throw new Error("出典サイトが見つかりません。");
    if (expectedVersion === undefined || expectedVersion !== site.version)
      throw new Error("出典サイトが更新されています。読み直してください。");
    if (site.deletedAt) return site;
    return saveReferenceSite(
      { ...site, deletedAt: new Date().toISOString() },
      expectedVersion,
    );
  });
}
export async function restoreReferenceSite(
  id: string,
  expectedVersion?: number,
) {
  return db.transaction("rw", [db.referenceSites, db.records], async () => {
    const site = await db.referenceSites.get(id);
    if (!site) throw new Error("出典サイトが見つかりません。");
    if (expectedVersion === undefined || expectedVersion !== site.version)
      throw new Error("出典サイトが更新されています。読み直してください。");
    return saveReferenceSite(
      { ...site, deletedAt: undefined },
      expectedVersion,
    );
  });
}
