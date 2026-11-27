import { db, getPreferences, type Conflict } from "./db";
import { type Entity, type Preferences, type Session } from "./models";
import { normalizeEntity, normalizePreferences } from "./validation";
export { normalizeEntity, normalizePreferences } from "./validation";
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
function fail(field: string): never {
  throw new Error(`取り込み形式が不正です：${field}`);
}
function text(v: unknown, name: string) {
  if (typeof v !== "string" || v.length > 1000000) fail(name);
  return v as string;
}

export interface ImportPreview {
  records: Entity[];
  duplicates: number;
  conflicts: number;
  preferences?: Preferences;
  warnings: string[];
  conflictArchives?: { key: string; value: unknown }[];
  unresolvedConflicts?: Conflict[];
}
function contentKey(r: Entity, includeScheduling = false) {
  const { id, createdAt, updatedAt, version, deletedAt, ...domain } =
    normalizeEntity(r);
  const stable = (v: unknown): string =>
    v instanceof Date
      ? JSON.stringify(v.toISOString())
      : Array.isArray(v)
        ? "[" + v.map(stable).join(",") + "]"
        : isObject(v)
          ? "{" +
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => JSON.stringify(k) + ":" + stable(x))
              .join(",") +
            "}"
          : JSON.stringify(v);
  if (r.kind === "card" && !includeScheduling) {
    const { fsrs, history, ...base } = domain;
    return stable(base);
  }
  return stable(domain);
}
export function validateReferences(rows: Entity[], existing: Entity[]) {
  const map = new Map([...existing, ...rows].map((r) => [r.id, r]));
  for (const r of rows) {
    if (r.deletedAt) continue;
    for (const [field, kind] of [
      ["targetId", "target"],
      ["subjectId", "subject"],
      ["unitId", "unit"],
      ["noteId", "note"],
      ["questionId", "question"],
    ] as const) {
      const id = r[field];
      if (!id) continue;
      const ref = map.get(String(id));
      if (!ref || ref.kind !== kind)
        fail(`${r.kind}.${field}：参照先がありません`);
      if (field === "subjectId" && r.targetId && ref.targetId !== r.targetId)
        fail("科目の学習対象が一致しません");
      if (
        field === "unitId" &&
        (ref.targetId !== r.targetId || ref.subjectId !== r.subjectId)
      )
        fail("単元の所属が一致しません");
    }
  }
}
export async function createBackup(): Promise<string> {
  return db.transaction(
    "r",
    [db.records, db.settings, db.syncMeta, db.conflicts],
    async () => {
      const [records, preferences, meta, unresolvedConflicts] =
        await Promise.all([
          db.records.toArray(),
          getPreferences(),
          db.syncMeta.toArray(),
          db.conflicts.toArray(),
        ]);
      return JSON.stringify(
        {
          format: "study-desk",
          schemaVersion: 1,
          exportedAt: new Date().toISOString(),
          records,
          preferences,
          unresolvedConflicts,
          conflictArchives: meta.filter((m) =>
            m.key.startsWith("conflict-archive:"),
          ),
        },
        null,
        2,
      );
    },
  );
}
export async function previewImport(input: string): Promise<ImportPreview> {
  if (input.length > 50 * 1024 * 1024)
    throw new Error("取り込みファイルは50MB以下にしてください。");
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch {
    throw new Error("JSONを解析できません。形式を確認してください。");
  }
  if (
    !isObject(raw) ||
    raw.format !== "study-desk" ||
    raw.schemaVersion !== 1 ||
    !Array.isArray(raw.records) ||
    raw.records.length > 100000
  )
    fail("format/schemaVersion/records");
  const normalized = raw.records.map(normalizeEntity),
    existing = await db.records.toArray(),
    ids = new Map(existing.map((r) => [r.id, r])),
    keys = new Set(existing.map((r) => contentKey(r))),
    result: ImportPreview = {
      records: [],
      duplicates: 0,
      conflicts: 0,
      warnings: [],
    };
  for (const row of normalized) {
    const old = ids.get(row.id),
      key = contentKey(row);
    if (old) {
      if (contentKey(old, true) === contentKey(row, true)) result.duplicates++;
      else result.conflicts++;
      continue;
    }
    if (keys.has(key)) {
      result.duplicates++;
      continue;
    }
    result.records.push(row);
    ids.set(row.id, row);
    keys.add(key);
  }
  validateReferences(result.records, existing);
  if (raw.preferences !== undefined) {
    const prefs = normalizePreferences(raw.preferences);
    if (!(await db.settings.get("preferences"))) result.preferences = prefs;
    else
      result.warnings.push(
        "既存の設定を保持します。バックアップの設定では上書きしません。",
      );
  }
  if (raw.conflictArchives !== undefined) {
    if (
      !Array.isArray(raw.conflictArchives) ||
      raw.conflictArchives.length > 100000
    )
      fail("conflictArchives");
    result.conflictArchives = raw.conflictArchives.map((a: unknown) => {
      if (
        !isObject(a) ||
        typeof a.key !== "string" ||
        !a.key.startsWith("conflict-archive:") ||
        !isObject(a.value)
      )
        fail("conflictArchives");
      return { key: a.key, value: a.value };
    });
  }
  if (raw.unresolvedConflicts !== undefined) {
    if (
      !Array.isArray(raw.unresolvedConflicts) ||
      raw.unresolvedConflicts.length > 100000
    )
      fail("unresolvedConflicts");
    result.unresolvedConflicts = raw.unresolvedConflicts.map((c: unknown) => {
      if (!isObject(c)) fail("unresolvedConflicts");
      const local = normalizeEntity(c.local),
        remote = normalizeEntity(c.remote),
        id = text(c.id, "conflict.id");
      if (local.id !== id || remote.id !== id) fail("conflict.id");
      return { id, local, remote };
    });
  }
  if (result.conflicts)
    result.warnings.push(
      `${result.conflicts}件は同じIDの別内容です。既存データを保持し、取り込みません。`,
    );
  return result;
}
export async function applyImport(
  preview: ImportPreview,
): Promise<{ added: number; skipped: number }> {
  return db.transaction(
    "rw",
    [db.records, db.outbox, db.settings, db.syncMeta, db.conflicts],
    async () => {
      const rows = preview.records.map(normalizeEntity),
        existing = await db.records.toArray();
      validateReferences(rows, existing);
      const ids = new Set(existing.map((r) => r.id)),
        keys = new Set(existing.map((r) => contentKey(r)));
      let added = 0,
        skipped = preview.duplicates + preview.conflicts;
      for (const row of rows) {
        const key = contentKey(row);
        if (ids.has(row.id) || keys.has(key)) {
          skipped++;
          continue;
        }
        await db.records.add(row);
        await db.outbox.put({ id: row.id, version: row.version });
        ids.add(row.id);
        keys.add(key);
        added++;
      }
      if (preview.preferences && !(await db.settings.get("preferences")))
        await db.settings.add(normalizePreferences(preview.preferences));
      for (const archive of preview.conflictArchives || [])
        if (!(await db.syncMeta.get(archive.key)))
          await db.syncMeta.add(archive);
      for (const c of preview.unresolvedConflicts || [])
        if (!(await db.conflicts.get(c.id)))
          await db.conflicts.add({
            id: c.id,
            local: normalizeEntity(c.local),
            remote: normalizeEntity(c.remote),
          });
      return { added, skipped };
    },
  );
}
export function sessionsToCSV(sessions: Session[]) {
  const esc = (v: unknown) =>
    '"' +
    String(v ?? "")
      .replaceAll('"', '""')
      .replace(/^[\s\u0000-\u001f]*[=+@-]/, "'$&") +
    '"';
  return (
    "\uFEFF" +
    [
      [
        "ID",
        "学習対象ID",
        "科目ID",
        "単元ID",
        "開始",
        "終了",
        "分",
        "学習方法",
        "メモ",
      ],
      ...sessions
        .filter((s) => !s.deletedAt)
        .map((s) => [
          s.id,
          s.targetId,
          s.subjectId,
          s.unitId,
          new Date(s.segments[0]?.start || 0).toISOString(),
          new Date(s.segments.at(-1)?.end || 0).toISOString(),
          s.minutes,
          s.method,
          s.memo,
        ]),
    ]
      .map((row) => row.map(esc).join(","))
      .join("\r\n")
  );
}
