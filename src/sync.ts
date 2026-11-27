import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { db } from "./db";
import { assertApprovedSyncOrigin } from "./security";
import { normalizeEntity, validateReferences } from "./exchange";
import type { Entity } from "./models";

export interface SyncConfig {
  url: string;
  key: string;
  enabled: boolean;
}
export interface SyncStatus {
  state: "unconfigured" | "signed-out" | "idle" | "syncing" | "error";
  message: string;
  lastSync?: string;
}
let client: SupabaseClient | undefined;
let clientConfig = "";
let status: SyncStatus = {
  state: "unconfigured",
  message: "端末内に保存中・同期未設定",
};
let active: Promise<void> | undefined;
const configKey = "study-desk-sync-config";
export function getSyncConfig(): SyncConfig {
  try {
    return (
      JSON.parse(localStorage.getItem(configKey) || "null") || {
        url: "",
        key: "",
        enabled: false,
      }
    );
  } catch {
    return { url: "", key: "", enabled: false };
  }
}
export function validateSyncConfig(config: SyncConfig) {
  const url = new URL(config.url);
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".supabase.co") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("SupabaseのHTTPSプロジェクトURLを指定してください。");
  if (config.key.startsWith("sb_secret_"))
    throw new Error(
      "秘密鍵は使用できません。公開用anon / publishable keyを使用してください。",
    );
  if (config.key.startsWith("eyJ")) {
    try {
      const body = JSON.parse(
        atob(config.key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
      );
      if (body.role !== "anon") throw new Error("role");
    } catch {
      throw new Error("anon公開鍵以外は使用できません。");
    }
  } else if (!config.key.startsWith("sb_publishable_"))
    throw new Error("有効なanon / publishable公開鍵を指定してください。");
  assertApprovedSyncOrigin(config.url);
}
export function saveSyncConfig(config: SyncConfig) {
  validateSyncConfig(config);
  localStorage.setItem(
    configKey,
    JSON.stringify({ ...config, url: config.url.replace(/\/$/, "") }),
  );
  client = undefined;
  status = {
    state: "signed-out",
    message: "接続設定を保存しました。認証してください。",
  };
}
function getClient() {
  const config = getSyncConfig();
  if (!config.url || !config.key) throw new Error("同期先が未設定です。");
  validateSyncConfig(config);
  const identity = config.url + "|" + config.key;
  if (clientConfig !== identity) {
    client = undefined;
    clientConfig = identity;
  }
  return (client ??= createClient(config.url, config.key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  }));
}
export function getSyncStatus() {
  return status;
}
async function bindAccount(userId: string) {
  const project = new URL(getSyncConfig().url).host;
  const binding = `${project}/${userId}`;
  await db.transaction("rw", db.syncMeta, async () => {
    const prior = await db.syncMeta.get("account-binding");
    if (prior && prior.value !== binding)
      throw new Error(
        "この端末のデータは別の同期アカウントに紐付いています。別のブラウザプロファイルを使用してください。",
      );
    if (!prior)
      await db.syncMeta.put({ key: "account-binding", value: binding });
  });
}
export async function signInSync(email: string, password: string) {
  const { data, error } = await getClient().auth.signInWithPassword({
    email,
    password,
  });
  if (error) throw error;
  if (data.user) await bindAccount(data.user.id);
  status = { state: "idle", message: "認証済み。同期ボタンで送受信できます。" };
}
export async function signUpSync(email: string, password: string) {
  const { data, error } = await getClient().auth.signUp({ email, password });
  if (error) throw error;
  if (data.user && data.session) await bindAccount(data.user.id);
  status = {
    state: data.session ? "idle" : "signed-out",
    message: data.session
      ? "登録・認証しました。"
      : "確認メールをご確認ください。確認後にログインしてください。",
  };
}
export async function signOutSync() {
  await getClient().auth.signOut();
  status = {
    state: "signed-out",
    message: "ログアウトしました。端末内のデータは保持しています。",
  };
}
function revive(record: Entity): Entity {
  return normalizeEntity(record);
}
function assertRemote(value: unknown): asserts value is Entity {
  if (!value || typeof value !== "object")
    throw new Error("同期データの形式が不正です。");
  const r = value as Entity;
  if (
    typeof r.id !== "string" ||
    ![
      "target",
      "subject",
      "unit",
      "session",
      "task",
      "note",
      "card",
      "attempt",
      "question",
    ].includes(r.kind) ||
    !Number.isInteger(r.version) ||
    r.version < 1 ||
    typeof r.updatedAt !== "string"
  )
    throw new Error("同期データの必須項目が不正です。");
}
async function sync() {
  if (!navigator.onLine)
    throw new Error("オフラインです。変更は端末内に保持しています。");
  const c = getClient();
  const {
    data: { user },
    error,
  } = await c.auth.getUser();
  if (error || !user) throw new Error("同期にはログインが必要です。");
  await bindAccount(user.id);
  status = { state: "syncing", message: "同期中…" };
  // Push snapshots. A concurrent local edit stays queued because removal checks version.
  const queue = await db.outbox.toArray();
  for (const pending of queue) {
    const local = await db.records.get(pending.id);
    if (!local) continue;
    const conflict = await db.conflicts.get(pending.id);
    if (conflict) {
      await db.transaction("rw", db.conflicts, db.records, async () => {
        const latest = await db.records.get(pending.id);
        const latestConflict = await db.conflicts.get(pending.id);
        if (latest && latestConflict)
          await db.conflicts.put({ ...latestConflict, local: latest });
      });
      continue;
    }
    const meta = await db.syncMeta.get(`revision:${local.id}`);
    const expected = Number(meta?.value || 0);
    const { data, error: pushError } = await c.rpc("study_push", {
      p_id: local.id,
      p_expected: expected,
      p_data: JSON.parse(JSON.stringify(local)),
    });
    if (pushError) throw pushError;
    const result = data as { ok: boolean; revision: number; data: Entity };
    if (!result || typeof result.ok !== "boolean")
      throw new Error("同期用SQLが未設定または異なるバージョンです。");
    if (!result.ok) {
      assertRemote(result.data);
      await db.conflicts.put({
        id: local.id,
        local,
        remote: revive(result.data),
      });
      await db.syncMeta.put({
        key: `conflict-revision:${local.id}`,
        value: result.revision,
      });
      continue;
    }
    await db.transaction("rw", db.outbox, db.syncMeta, async () => {
      await db.syncMeta.put({
        key: `revision:${local.id}`,
        value: result.revision,
      });
      const current = await db.outbox.get(local.id);
      if (current?.version === local.version) await db.outbox.delete(local.id);
    });
  }
  const cursor = Number((await db.syncMeta.get("cursor"))?.value || 0);
  const { data, error: pullError } = await c.rpc("study_pull", {
    p_cursor: cursor,
  });
  if (pullError) throw pullError;
  const pulled = data as {
    cursor: number;
    records: { id: string; revision: number; data: Entity }[];
  };
  if (
    !pulled ||
    !Array.isArray(pulled.records) ||
    !Number.isSafeInteger(pulled.cursor)
  )
    throw new Error("同期データの形式が不正です。");
  for (const row of pulled.records) {
    assertRemote(row.data);
    if (
      row.id !== row.data.id ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1
    )
      throw new Error("同期データの版番号が不正です。");
    normalizeEntity(row.data);
  }
  await db.transaction(
    "rw",
    db.records,
    db.outbox,
    db.syncMeta,
    db.conflicts,
    async () => {
      validateReferences(
        pulled.records.map((row) => revive(row.data)),
        await db.records.toArray(),
      );
      for (const row of pulled.records) {
        const remote = revive(row.data);
        const revision = Number(
          (await db.syncMeta.get(`revision:${remote.id}`))?.value || 0,
        );
        if (row.revision <= revision) continue;
        const local = await db.records.get(remote.id);
        const dirty = await db.outbox.get(remote.id);
        if (local && dirty) {
          await db.conflicts.put({ id: remote.id, local, remote });
          await db.syncMeta.put({
            key: `conflict-revision:${remote.id}`,
            value: row.revision,
          });
        } else {
          await db.records.put(remote);
          await db.syncMeta.put({
            key: `revision:${remote.id}`,
            value: row.revision,
          });
        }
      }
      await db.syncMeta.put({ key: "cursor", value: pulled.cursor });
    },
  );
  const at = new Date().toISOString();
  await db.syncMeta.put({ key: "lastSync", value: at });
  status = {
    state: "idle",
    message: `同期済み・競合 ${await db.conflicts.count()} 件`,
    lastSync: at,
  };
}
export async function runSync() {
  if (active) return active;
  active = sync()
    .catch((error) => {
      status = {
        state: "error",
        message: error instanceof Error ? error.message : String(error),
      };
      throw error;
    })
    .finally(() => {
      active = undefined;
    });
  return active;
}
export async function resolveConflict(id: string, choice: "local" | "remote") {
  // Re-read all snapshots inside one transaction, so another tab cannot resolve twice.
  await db.transaction(
    "rw",
    db.records,
    db.outbox,
    db.syncMeta,
    db.conflicts,
    async () => {
      const conflict = await db.conflicts.get(id);
      if (!conflict) throw new Error("この競合は解決済みです。");
      const revision = Number(
        (await db.syncMeta.get(`conflict-revision:${id}`))?.value || 0,
      );
      if (!revision)
        throw new Error(
          "競合のサーバー版番号がありません。再同期してください。",
        );
      const current = await db.records.get(id);
      if (!current) throw new Error("端末内のデータが見つかりません。");
      if (
        current.version !== conflict.local.version ||
        current.updatedAt !== conflict.local.updatedAt
      ) {
        throw new Error(
          "確認後に端末内のデータが変わりました。再同期し、両方の内容を再確認してください。",
        );
      }
      await db.syncMeta.put({
        key: `conflict-archive:${id}:${crypto.randomUUID()}`,
        value: conflict,
      });
      if (choice === "remote") {
        await db.records.put(conflict.remote);
        await db.outbox.delete(id);
      } else {
        const next = {
          ...current,
          version: Math.max(current.version, conflict.remote.version) + 1,
          updatedAt: new Date().toISOString(),
        };
        await db.records.put(next);
        await db.outbox.put({ id, version: next.version });
      }
      await db.syncMeta.put({ key: `revision:${id}`, value: revision });
      await db.conflicts.delete(id);
    },
  );
}
export function installReconnectSync() {
  const onOnline = () => {
    if (getSyncConfig().enabled) void runSync().catch(() => {});
  };
  window.addEventListener("online", onOnline);
  return () => window.removeEventListener("online", onOnline);
}
