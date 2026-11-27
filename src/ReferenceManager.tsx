import { useMemo, useState, type FormEvent } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  db,
  saveReferenceSite,
  trashReferenceSite,
  restoreReferenceSite,
} from "./db";
import type { Entity, ReferenceSite } from "./models";
import {
  normalizeReferenceSite,
  citationSiteStatus,
  referenceInstructions,
} from "./references";

type Props = { entities: Entity[]; onError: (error: unknown) => void };
type Draft = {
  id?: string;
  version?: number;
  name: string;
  url: string;
  targetId: string;
  priority: number | "";
  asOf: string;
};
const emptyDraft = (): Draft => ({
  name: "",
  url: "",
  targetId: "",
  priority: 1,
  asOf: "",
});
const candidates = [
  { name: "e-Gov法令検索", url: "https://laws.e-gov.go.jp/", priority: 1 },
  {
    name: "金融庁 法令・指針等",
    url: "https://www.fsa.go.jp/common/law/",
    priority: 2,
  },
  {
    name: "日本証券業協会 自主規制規則",
    url: "https://www.jsda.or.jp/about/kisoku/",
    priority: 3,
  },
];
const statusLabels = {
  registered: "登録範囲内・内容は未確認",
  external: "登録外の参照先",
  missing: "参照先未確認",
};

export function ReferenceManager({ entities, onError }: Props) {
  const sites = useLiveQuery(() => db.referenceSites.toArray(), [], []);
  const targets = entities.filter(
    (entity) => entity.kind === "target" && !entity.deletedAt,
  );
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("");
  const [showTrash, setShowTrash] = useState(false);
  const [checkUrl, setCheckUrl] = useState("");
  const [checkTarget, setCheckTarget] = useState("");
  const activeSites = useMemo(
    () =>
      sites
        .filter((site) => !site.deletedAt)
        .sort(
          (a, b) =>
            a.priority - b.priority || a.name.localeCompare(b.name, "ja"),
        ),
    [sites],
  );
  const trash = sites.filter((site) => !!site.deletedAt);
  const targetName = (id: string) =>
    !id
      ? "すべての学習対象"
      : targets.find((target) => target.id === id)?.title ||
        "保存済みの学習対象（現在非表示）";
  const error = (cause: unknown) => {
    setStatus(
      cause instanceof Error ? cause.message : "参照先を保存できませんでした。",
    );
    onError(cause);
  };
  const update = (changes: Partial<Draft>) => {
    setDraft((value) => ({ ...value, ...changes }));
    setDirty(true);
    setStatus("");
  };

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const normalized = normalizeReferenceSite({
        ...draft,
        name: draft.name.trim(),
        url: draft.url.trim(),
      });
      if (
        draft.id &&
        !window.confirm(
          `「${normalized.name}」の変更を保存しますか？現在表示している版を更新します。`,
        )
      )
        return;
      await saveReferenceSite(
        draft.id
          ? { ...normalized, id: draft.id, version: draft.version }
          : normalized,
        draft.version,
      );
      setDraft(emptyDraft());
      setDirty(false);
      setStatus("参照先を保存しました。登録は内容の確認・検証を意味しません。");
    } catch (cause) {
      error(cause);
    } finally {
      setBusy(false);
    }
  }

  async function addCandidate(candidate: (typeof candidates)[number]) {
    if (busy) return;
    setBusy(true);
    try {
      const normalized = normalizeReferenceSite({
        ...candidate,
        targetId: "",
        asOf: "",
      });
      const duplicate = sites.find(
        (site) =>
          site.url === normalized.url && site.targetId === normalized.targetId,
      );
      if (duplicate) {
        setStatus(
          duplicate.deletedAt
            ? "この候補はゴミ箱にあります。ゴミ箱から復元してください。"
            : "この候補はすでに登録されています。",
        );
        return;
      }
      await saveReferenceSite(normalized);
      setStatus(
        `「${normalized.name}」を全学習対象の参照先として追加しました。適用基準日は必要に応じて編集してください。`,
      );
    } catch (cause) {
      error(cause);
    } finally {
      setBusy(false);
    }
  }

  async function move(site: ReferenceSite, restore: boolean) {
    if (
      busy ||
      !window.confirm(
        restore
          ? `「${site.name}」を復元しますか？`
          : `「${site.name}」をゴミ箱に移動しますか？登録内容は後から復元できます。`,
      )
    )
      return;
    setBusy(true);
    try {
      if (restore) await restoreReferenceSite(site.id, site.version);
      else await trashReferenceSite(site.id, site.version);
      if (draft.id === site.id) {
        setDraft(emptyDraft());
        setDirty(false);
      }
      setDirty(false);
      setStatus(
        restore ? "参照先を復元しました。" : "参照先をゴミ箱に移動しました。",
      );
    } catch (cause) {
      error(cause);
    } finally {
      setBusy(false);
    }
  }

  const checkedStatus = citationSiteStatus(checkUrl, sites, checkTarget);
  return (
    <section className="panel stack" aria-labelledby="reference-sites-title">
      <div className="row">
        <div>
          <h3 id="reference-sites-title">参照サイト</h3>
          <p className="muted">
            法令・制度・数値の確認に使うサイトを整理します。
          </p>
        </div>
        <span className="badge">{activeSites.length}件</span>
      </div>
      <p className="muted">
        登録は内容の検証済みを意味しません。サイトの自動巡回は行いません。登録した範囲でも、条文・資料の該当箇所と適用時点を確認してください。登録外の出典は「登録外」、参照先がない場合は「参照先未確認」として区別します。
      </p>
      <form className="stack" onSubmit={save}>
        <h4>{draft.id ? "参照先を編集" : "参照先を追加"}</h4>
        <fieldset className="stack" disabled={busy}>
          <div className="grid">
            <label className="field">
              <span>サイト名</span>
              <input
                required
                maxLength={200}
                value={draft.name}
                onChange={(event) => update({ name: event.target.value })}
                placeholder="例：e-Gov法令検索"
              />
            </label>
            <label className="field">
              <span>URL（https / http）</span>
              <input
                type="url"
                required
                maxLength={2048}
                value={draft.url}
                onChange={(event) => update({ url: event.target.value })}
                placeholder="https://laws.e-gov.go.jp/"
                autoCapitalize="none"
                autoCorrect="off"
              />
            </label>
          </div>
          <div className="grid">
            <label className="field">
              <span>対象の学習対象</span>
              <select
                value={draft.targetId}
                onChange={(event) => update({ targetId: event.target.value })}
              >
                <option value="">すべての学習対象</option>
                {targets.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.title}
                  </option>
                ))}
                {draft.targetId &&
                  !targets.some((target) => target.id === draft.targetId) && (
                    <option value={draft.targetId}>
                      保存済みの学習対象（現在非表示）
                    </option>
                  )}
              </select>
            </label>
            <label className="field">
              <span>優先順位（1が最優先）</span>
              <input
                type="number"
                min={1}
                max={99}
                step={1}
                required
                value={draft.priority}
                onChange={(event) =>
                  update({
                    priority:
                      event.target.value === ""
                        ? ""
                        : event.target.valueAsNumber,
                  })
                }
              />
            </label>
            <label className="field">
              <span>適用基準日（任意）</span>
              <input
                type="date"
                value={draft.asOf}
                onChange={(event) => update({ asOf: event.target.value })}
              />
            </label>
          </div>
          <p className="muted">
            URLのホスト名と指定パス配下を登録範囲とします。適用基準日は、試験や資料で基準にする法令・制度の時点です。
          </p>
          <div className="row">
            <button className="primary" type="submit">
              {busy
                ? "保存中…"
                : draft.id
                  ? "変更を確認して保存"
                  : "参照先を保存"}
            </button>
            {draft.id && (
              <button
                type="button"
                onClick={() => {
                  if (dirty && !window.confirm("未保存の入力を破棄しますか？"))
                    return;
                  setDraft(emptyDraft());
                  setDirty(false);
                  setStatus("");
                }}
              >
                編集をやめる
              </button>
            )}
          </div>
        </fieldset>
      </form>
      <p className="muted" role="status" aria-live="polite">
        {status}
      </p>
      <div className="stack">
        <h4>登録した参照先</h4>
        {activeSites.length === 0 && (
          <p className="muted">
            まだ登録されていません。参照したい範囲を追加してください。
          </p>
        )}
        {activeSites.map((site) => (
          <article className="panel stack" key={site.id}>
            <div className="row">
              <strong>{site.name}</strong>
              <span className="badge">優先 {site.priority}</span>
            </div>
            <a href={site.url} target="_blank" rel="noopener noreferrer">
              {site.url}
            </a>
            <p className="muted">
              {targetName(site.targetId)} · 適用基準日：{site.asOf || "未指定"}
            </p>
            <p className="muted">登録済み・内容は未確認</p>
            <div className="row">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (
                    dirty &&
                    !window.confirm(
                      "編集中の入力を破棄して、この参照先を開きますか？",
                    )
                  )
                    return;
                  setDirty(false);
                  setDraft({
                    id: site.id,
                    version: site.version,
                    name: site.name,
                    url: site.url,
                    targetId: site.targetId,
                    priority: site.priority,
                    asOf: site.asOf,
                  });
                  setStatus(
                    "変更を保存する前に確認します。別画面で更新された版は上書きしません。",
                  );
                }}
              >
                編集
              </button>
              <button
                className="danger"
                type="button"
                disabled={busy}
                onClick={() => move(site, false)}
              >
                ゴミ箱へ
              </button>
            </div>
          </article>
        ))}
      </div>
      <details>
        <summary>一次情報の参照先候補</summary>
        <div className="stack">
          <p className="muted">
            必要な候補だけ追加できます。追加先は全学習対象です。自動で登録・取得はしません。
          </p>
          {candidates.map((candidate) => (
            <div className="panel stack" key={candidate.url}>
              <strong>{candidate.name}</strong>
              <a href={candidate.url} target="_blank" rel="noopener noreferrer">
                {candidate.url}
              </a>
              <button
                type="button"
                disabled={busy}
                aria-label={`${candidate.name}の候補を追加`}
                onClick={() => addCandidate(candidate)}
              >
                候補を追加
              </button>
            </div>
          ))}
        </div>
      </details>
      <details>
        <summary>URLの登録範囲を確認</summary>
        <div className="stack">
          <label className="field">
            <span>確認するURL</span>
            <input
              type="url"
              value={checkUrl}
              onChange={(event) => setCheckUrl(event.target.value)}
              placeholder="資料のURLを貼り付ける"
              autoCapitalize="none"
              autoCorrect="off"
            />
          </label>
          <label className="field">
            <span>学習対象</span>
            <select
              value={checkTarget}
              onChange={(event) => setCheckTarget(event.target.value)}
            >
              <option value="">すべての学習対象</option>
              {targets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.title}
                </option>
              ))}
            </select>
          </label>
          <p className="badge" role="status">
            {statusLabels[checkedStatus]}
          </p>
          <p className="muted">
            URLの登録範囲だけを確認します。ページには接続せず、情報の正確性や閲覧可否は判定しません。
          </p>
        </div>
      </details>
      <details>
        <summary>ChatGPTに渡す参照条件</summary>
        <pre className="editor">
          {referenceInstructions(sites, checkTarget)}
        </pre>
      </details>
      <details
        open={showTrash}
        onToggle={(event) => setShowTrash(event.currentTarget.open)}
      >
        <summary>参照サイトのゴミ箱（{trash.length}件）</summary>
        <div className="stack">
          {trash.length === 0 && <p className="muted">ゴミ箱は空です。</p>}
          {trash.map((site) => (
            <div className="panel stack" key={site.id}>
              <strong>{site.name}</strong>
              <p className="muted">
                {site.url} · {targetName(site.targetId)}
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => move(site, true)}
              >
                確認して復元
              </button>
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}
