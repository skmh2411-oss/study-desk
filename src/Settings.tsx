import { useEffect, useState } from "react";
import { ChatGPTPanel } from "./ChatGPTPanel";
import { allowedSyncOrigin } from "./security";
import { useLiveQuery } from "dexie-react-hooks";
import { db, getPreferences, setPreferences, restoreEntity } from "./db";
import {
  createBackup,
  previewImport,
  applyImport,
  sessionsToCSV,
} from "./exchange";
import type { Entity, Preferences, Session } from "./models";
import { defaultPreferences } from "./models";
import {
  getSyncConfig,
  saveSyncConfig,
  getSyncStatus,
  signInSync,
  signUpSync,
  signOutSync,
  runSync,
  resolveConflict,
  type SyncConfig,
} from "./sync";

type Props = {
  entities: Entity[];
  onError: (e: unknown) => void;
  onClose: () => void;
};
export function downloadFile(
  name: string,
  content: string,
  type = "application/json",
) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function SettingsView({ entities, onError, onClose }: Props) {
  const [section, setSection] = useState("設定");
  const [prefs, setPrefs] = useState<Preferences>(defaultPreferences);
  const [raw, setRaw] = useState("");
  const [preview, setPreview] = useState<Awaited<
    ReturnType<typeof previewImport>
  > | null>(null);
  const [message, setMessage] = useState("");
  const [config, setConfig] = useState<SyncConfig>(getSyncConfig);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [, refresh] = useState(0);
  const conflicts = useLiveQuery(() => db.conflicts.toArray(), []) || [];
  const archives =
    useLiveQuery(
      () =>
        db.syncMeta
          .filter((x) => x.key.startsWith("conflict-archive:"))
          .toArray(),
      [],
    ) || [];
  const trash = entities.filter((x) => x.deletedAt);
  useEffect(() => {
    getPreferences().then(setPrefs).catch(onError);
  }, [onError]);
  async function action(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      await fn();
      refresh((x) => x + 1);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  function editPrefs(p: Partial<Preferences>) {
    const next = { ...prefs, ...p };
    setPrefs(next);
    void setPreferences(p).catch(onError);
  }
  return (
    <div className="stack settings-view">
      <div className="row">
        <h2>設定とデータ</h2>
        <button className="button secondary" onClick={onClose}>
          閉じる
        </button>
      </div>
      <div className="tabs">
        {["設定", "バックアップ", "ChatGPT", "同期", "ゴミ箱"].map((s) => (
          <button
            key={s}
            className={`button ${section === s ? "primary" : "secondary"}`}
            onClick={() => setSection(s)}
          >
            {s}
          </button>
        ))}
      </div>
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      {section === "設定" && (
        <section className="panel stack">
          <h3>使いやすさ</h3>
          <label className="field">
            表示テーマ
            <select
              value={prefs.theme}
              onChange={(e) =>
                editPrefs({ theme: e.target.value as Preferences["theme"] })
              }
            >
              <option value="system">端末に合わせる</option>
              <option value="light">ライト</option>
              <option value="dark">ダーク</option>
            </select>
          </label>
          <label className="field">
            新規カード / 日
            <input
              type="number"
              min="0"
              max="1000"
              value={prefs.dailyNewLimit}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isInteger(v) && v >= 0 && v <= 1000)
                  editPrefs({ dailyNewLimit: v });
              }}
            />
          </label>
          <p className="muted">
            データはこのブラウザ内に保存されます。Safariの「履歴とWebサイトデータを消去」は学習データも消すため、定期的にバックアップしてください。
          </p>
          <button
            className="button secondary"
            onClick={() =>
              void action(async () => {
                const storage = navigator.storage;
                if (storage?.persist) {
                  const ok = await storage.persist();
                  setMessage(
                    ok
                      ? "永続ストレージが許可されました。"
                      : "永続ストレージの許可はブラウザが判断します。バックアップを併用してください。",
                  );
                } else
                  setMessage(
                    "このブラウザでは永続ストレージの申請は利用できません。",
                  );
              })
            }
          >
            端末内データの保持を申請
          </button>
          <p className="muted">
            iPhone：SafariでHTTPSの公開URLを開き、「共有」→「ホーム画面に追加」。初回読み込み後はオフラインでも使用できます。終了中のアラームはありません。Windows：Edge
            / Chromeのアプリをインストールを利用できます。
          </p>
        </section>
      )}
      {section === "バックアップ" && (
        <section className="panel stack">
          <h3>バックアップと取り込み</h3>
          <p className="muted">
            JSONは全データ、CSVは学習記録です。ファイルには学習内容が含まれます。
          </p>
          <div className="row">
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                void action(async () =>
                  downloadFile(
                    `study-desk-${new Date().toISOString().slice(0, 10)}.json`,
                    await createBackup(),
                  ),
                )
              }
            >
              JSONを保存
            </button>
            <button
              className="button secondary"
              onClick={() =>
                downloadFile(
                  "study-records.csv",
                  sessionsToCSV(
                    entities.filter(
                      (e) => e.kind === "session" && !e.deletedAt,
                    ) as Session[],
                  ),
                  "text/csv;charset=utf-8",
                )
              }
            >
              学習記録CSV
            </button>
          </div>
          <label className="field">
            JSONファイル
            <input
              type="file"
              accept=".json,application/json"
              onChange={(e) => {
                const f = e.target.files?.[0];
                setPreview(null);
                if (f) {
                  if (f.size > 20 * 1024 * 1024) {
                    onError(new Error("20MB以下のJSONを選択してください。"));
                    return;
                  }
                  void f.text().then(setRaw).catch(onError);
                }
              }}
            />
          </label>
          <label className="field">
            またはJSONを貼り付け
            <textarea
              rows={8}
              value={raw}
              onChange={(e) => {
                setRaw(e.target.value);
                setPreview(null);
              }}
            />
          </label>
          <button
            className="button secondary"
            disabled={!raw || busy}
            onClick={() =>
              void action(async () => {
                setPreview(await previewImport(raw));
              })
            }
          >
            内容を検証・プレビュー
          </button>
          {preview && (
            <div className="stack">
              <p>
                候補 {preview.records.length} 件 / 重複 {preview.duplicates} 件
                / 競合 {preview.conflicts} 件
              </p>
              {preview.warnings.map((w, i) => (
                <p className="muted" key={i}>
                  {w}
                </p>
              ))}
              <ul>
                {preview.records.slice(0, 12).map((r, i) => (
                  <li key={i}>
                    {r.kind} ·{" "}
                    {String(r.title || r.question || r.date || r.id).slice(
                      0,
                      80,
                    )}
                  </li>
                ))}
              </ul>
              <p className="muted">
                既存の同一IDは上書きしません。設定が含まれる場合は、既存設定を保持します。
              </p>
              <button
                className="button primary"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    const result = await applyImport(preview);
                    setMessage(
                      `追加 ${result.added} 件 / スキップ ${result.skipped} 件`,
                    );
                    setPreview(null);
                    setRaw("");
                  })
                }
              >
                確認したデータを追加
              </button>
            </div>
          )}
        </section>
      )}
      {section === "ChatGPT" && (
        <ChatGPTPanel entities={entities} onError={onError} />
      )}
      {section === "同期" && (
        <section className="panel stack">
          <h3>iPhone・PC間の同期（任意）</h3>
          <p className="notice">
            {allowedSyncOrigin()
              ? `この版で許可された同期先：${allowedSyncOrigin()}`
              : "この版は端末内保存専用です。同期を利用する場合は、同梱のdocs/SYNC.mdに従って本人のProject URLを指定し、再ビルドしてください。"}
          </p>
          <p className="muted">
            未設定のまま、すべての基本機能を利用できます。設定後に同期を実行すると、学習データをあなたのSupabaseプロジェクトへ送信します。設定用SQLと手順はソース同梱のdocs/SYNC.mdを参照してください。
          </p>
          <p role="status">{getSyncStatus().message}</p>
          <label className="field">
            Supabase Project URL
            <input
              type="url"
              value={config.url}
              onChange={(e) => setConfig({ ...config, url: e.target.value })}
              placeholder="https://your-project.supabase.co"
              autoComplete="off"
            />
          </label>
          <label className="field">
            公開用anon / publishable key
            <input
              value={config.key}
              onChange={(e) => setConfig({ ...config, key: e.target.value })}
              autoComplete="off"
            />
          </label>
          <label className="row">
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(e) =>
                setConfig({ ...config, enabled: e.target.checked })
              }
            />
            再接続時の自動同期を許可する
          </label>
          <button
            className="button secondary"
            onClick={() =>
              void action(async () => {
                saveSyncConfig(config);
                setMessage(
                  "接続設定を保存しました。認証後、「今すぐ同期」で送受信します。",
                );
              })
            }
          >
            接続設定を保存
          </button>
          <label className="field">
            メールアドレス
            <input
              type="email"
              value={email}
              autoComplete="username"
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="field">
            パスワード
            <input
              type="password"
              value={password}
              minLength={8}
              autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <div className="row">
            <button
              className="button secondary"
              disabled={busy || !email || password.length < 8}
              onClick={() =>
                void action(async () => {
                  await signInSync(email, password);
                  setPassword("");
                })
              }
            >
              ログイン
            </button>
            <button
              className="button secondary"
              disabled={busy || !email || password.length < 8}
              onClick={() =>
                void action(async () => {
                  await signUpSync(email, password);
                  setPassword("");
                })
              }
            >
              新規登録
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => void action(runSync)}
            >
              今すぐ同期
            </button>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => void action(signOutSync)}
            >
              ログアウト
            </button>
          </div>
          <p className="muted">
            計測中のタイマーは端末固有です。端末を切り替える前に終了・保存してください。設定は端末ごとに保存されます。
          </p>
          {conflicts.map((c) => (
            <article key={c.id} className="panel stack">
              <h4>
                変更の競合 · {String(c.local.title || c.local.question || c.id)}
              </h4>
              <details>
                <summary>両方の内容を確認</summary>
                <pre>
                  {JSON.stringify(
                    { 端末: c.local, クラウド: c.remote },
                    null,
                    2,
                  )}
                </pre>
              </details>
              <p className="muted">
                選択しなかった版も履歴として保持します。学習時間の二重計上を防ぐため複製登録はしません。
              </p>
              <div className="row">
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => {
                    if (
                      confirm(
                        "端末内の版を採用しますか？両方の版は履歴に保存します。",
                      )
                    )
                      void action(() => resolveConflict(c.id, "local"));
                  }}
                >
                  端末の版を採用
                </button>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => {
                    if (
                      confirm(
                        "クラウドの版を採用しますか？両方の版は履歴に保存します。",
                      )
                    )
                      void action(() => resolveConflict(c.id, "remote"));
                  }}
                >
                  クラウドの版を採用
                </button>
              </div>
            </article>
          ))}
          {archives.length > 0 && (
            <button
              className="button secondary"
              onClick={() =>
                downloadFile(
                  "study-conflict-history.json",
                  JSON.stringify(archives, null, 2),
                )
              }
            >
              解決済み競合履歴を保存（{archives.length}件）
            </button>
          )}
        </section>
      )}
      {section === "ゴミ箱" && (
        <section className="panel stack">
          <h3>ゴミ箱</h3>
          <p className="muted">
            削除したデータはここから復元できます。完全削除は行いません。
          </p>
          {trash.length === 0 ? (
            <p className="empty">ゴミ箱は空です。</p>
          ) : (
            trash.map((e) => (
              <div className="row" key={e.id}>
                <span>
                  {e.kind} ·{" "}
                  {String(e.title || e.question || e.date || e.id).slice(0, 60)}
                </span>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void action(() => restoreEntity(e.id))}
                >
                  復元
                </button>
              </div>
            ))
          )}
        </section>
      )}
    </div>
  );
}
