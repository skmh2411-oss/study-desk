import { db, getPreferences, type Conflict } from "./db";
import {
  type Entity,
  type Preferences,
  type Session,
  type ReferenceSite,
} from "./models";
import { normalizeEntity, normalizePreferences } from "./validation";
import { normalizeReferenceSite } from "./references";
export { normalizeEntity, normalizePreferences } from "./validation";
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
function sourceQuestionKey(row: Entity) {
  return row.kind === "question" && row.sourceUrl && row.sourceQuestionId
    ? JSON.stringify([row.sourceUrl, row.sourceQuestionId])
    : "";
}
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
  referenceSites?: ReferenceSite[];
  referenceSiteDuplicates?: number;
  referenceSiteConflicts?: number;
}
export function entityContentKey(r: Entity, includeScheduling = false) {
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
  if (!includeScheduling && (r.kind === "card" || r.kind === "question")) {
    // Provenance/review state must not make the same study content new again.
    const {
      batchId,
      sourceStatus,
      citations,
      sourceUrl,
      sourceQuestionId,
      originalText,
      fsrs,
      history,
      wrongCount,
      cause,
      ...base
    } = domain;
    if (base.cardType === "qa") delete base.cardType;
    if (base.answerUnit === "") delete base.answerUnit;
    if (base.conditions === "") delete base.conditions;
    if (r.kind === "question") {
      if (base.importance === 3) delete base.importance;
      if (Array.isArray(base.tags) && !base.tags.length) delete base.tags;
    }
    return stable(base);
  }
  return stable(domain);
}
/** External imports cannot assert that a human has verified a source. */
export function normalizeImportedEntity(raw: unknown): Entity {
  const record = normalizeEntity(raw);
  if (record.sourceStatus === "verified") record.sourceStatus = "unverified";
  if (Array.isArray(record.citations))
    record.citations = record.citations.map((c) => ({ ...c, checkedOn: "" }));
  return record;
}
function referenceSiteKey(site: ReferenceSite) {
  return `${site.targetId}\n${site.url}`;
}
function validateReferenceSiteTargets(
  sites: ReferenceSite[],
  records: Entity[],
) {
  const targets = new Set(
    records.filter((r) => r.kind === "target").map((r) => r.id),
  );
  for (const site of sites)
    if (site.targetId && !targets.has(site.targetId))
      fail("referenceSites.targetId：学習対象がありません");
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
    [db.records, db.settings, db.syncMeta, db.conflicts, db.referenceSites],
    async () => {
      const [records, preferences, meta, unresolvedConflicts, referenceSites] =
        await Promise.all([
          db.records.toArray(),
          getPreferences(),
          db.syncMeta.toArray(),
          db.conflicts.toArray(),
          db.referenceSites.toArray(),
        ]);
      return JSON.stringify(
        {
          format: "study-desk",
          schemaVersion: 1,
          exportedAt: new Date().toISOString(),
          records,
          preferences,
          unresolvedConflicts,
          referenceSites,
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
  const normalized = raw.records.map(normalizeImportedEntity),
    existing = await db.records.toArray(),
    ids = new Map(existing.map((r) => [r.id, r])),
    keys = new Set(existing.map((r) => entityContentKey(r))),
    result: ImportPreview = {
      records: [],
      duplicates: 0,
      conflicts: 0,
      warnings: [],
    };
  for (const row of normalized) {
    const old = ids.get(row.id),
      key = entityContentKey(row);
    if (old) {
      if (entityContentKey(old, true) === entityContentKey(row, true))
        result.duplicates++;
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
  const downgraded = raw.records.filter(
    (row) => isObject(row) && row.sourceStatus === "verified",
  ).length;
  if (downgraded)
    result.warnings.push(
      `${downgraded}件の外部JSONの「確認済み」は「未確認」に変更します。実際の出典を照合してください。`,
    );
  if (raw.referenceSites !== undefined) {
    if (!Array.isArray(raw.referenceSites) || raw.referenceSites.length > 10000)
      fail("referenceSites");
    const sites = raw.referenceSites.map(normalizeReferenceSite);
    const previous = await db.referenceSites.toArray();
    const siteIds = new Map(previous.map((site) => [site.id, site]));
    const siteKeys = new Set(previous.map(referenceSiteKey));
    result.referenceSites = [];
    result.referenceSiteDuplicates = 0;
    result.referenceSiteConflicts = 0;
    for (const site of sites) {
      const old = siteIds.get(site.id);
      if (old) {
        const {
          createdAt: _a,
          updatedAt: _b,
          version: _c,
          ...oldContent
        } = old;
        const {
          createdAt: _d,
          updatedAt: _e,
          version: _f,
          ...newContent
        } = site;
        if (JSON.stringify(oldContent) === JSON.stringify(newContent))
          result.referenceSiteDuplicates++;
        else result.referenceSiteConflicts++;
        continue;
      }
      const key = referenceSiteKey(site);
      if (siteKeys.has(key)) {
        result.referenceSiteDuplicates++;
        continue;
      }
      result.referenceSites.push(site);
      siteIds.set(site.id, site);
      siteKeys.add(key);
    }
    validateReferenceSiteTargets(result.referenceSites, [
      ...existing,
      ...result.records,
    ]);
    if (result.referenceSiteConflicts)
      result.warnings.push(
        `${result.referenceSiteConflicts}件の出典サイトは既存IDと内容が異なるため取り込みません。`,
      );
  }

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
      const local = normalizeImportedEntity(c.local),
        remote = normalizeImportedEntity(c.remote),
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
export async function applyImport(preview: ImportPreview): Promise<{
  added: number;
  skipped: number;
  referenceSitesAdded?: number;
  referenceSitesSkipped?: number;
}> {
  return db.transaction(
    "rw",
    [
      db.records,
      db.outbox,
      db.settings,
      db.syncMeta,
      db.conflicts,
      db.referenceSites,
    ],
    async () => {
      const rows = preview.records.map(normalizeImportedEntity),
        existing = await db.records.toArray();
      validateReferences(rows, existing);
      const referenceSites = (preview.referenceSites || []).map(
        normalizeReferenceSite,
      );
      validateReferenceSiteTargets(referenceSites, [...existing, ...rows]);
      const ids = new Set(existing.map((r) => r.id)),
        keys = new Set(existing.map((r) => entityContentKey(r)));
      const questionKeys = new Set(
        existing.map(sourceQuestionKey).filter(Boolean),
      );
      let added = 0,
        skipped = preview.duplicates + preview.conflicts;
      for (const row of rows) {
        const key = entityContentKey(row);
        const questionKey = sourceQuestionKey(row);
        if (
          ids.has(row.id) ||
          keys.has(key) ||
          (questionKey && questionKeys.has(questionKey))
        ) {
          skipped++;
          continue;
        }
        await db.records.add(row);
        await db.outbox.put({ id: row.id, version: row.version });
        ids.add(row.id);
        keys.add(key);
        if (questionKey) questionKeys.add(questionKey);
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
            local: normalizeImportedEntity(c.local),
            remote: normalizeImportedEntity(c.remote),
          });
      const previousSites = await db.referenceSites.toArray();
      const siteIds = new Set(previousSites.map((site) => site.id));
      const siteKeys = new Set(previousSites.map(referenceSiteKey));
      let referenceSitesAdded = 0,
        referenceSitesSkipped =
          (preview.referenceSiteDuplicates || 0) +
          (preview.referenceSiteConflicts || 0);
      for (const site of referenceSites) {
        const key = referenceSiteKey(site);
        if (siteIds.has(site.id) || siteKeys.has(key)) {
          referenceSitesSkipped++;
          continue;
        }
        await db.referenceSites.add(site);
        siteIds.add(site.id);
        siteKeys.add(key);
        referenceSitesAdded++;
      }
      return {
        added,
        skipped,
        ...(preview.referenceSites
          ? { referenceSitesAdded, referenceSitesSkipped }
          : {}),
      };
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
