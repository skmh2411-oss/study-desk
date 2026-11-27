import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./db";
import { referenceInstructions } from "./references";
import type { Entity, Kind } from "./models";
import {
  DEFAULT_SHARING_SELECTION,
  sharingCandidates,
  sharedRecords,
  sharingSignature,
  buildStudyPrompt,
  sharingKinds,
  sharingKindLabels,
  type SharingSelection,
} from "./promptSharing";
const requests = [
  "学習計画の作成・改善",
  "学習状況の分析",
  "要点まとめの作成",
  "暗記カードの作成",
  "練習問題の作成",
  "誤答の解説",
];
export function ChatGPTPanel({
  entities,
  onError,
}: {
  entities: Entity[];
  onError: (e: unknown) => void;
}) {
  const referenceSites = useLiveQuery(
    () => db.referenceSites.toArray(),
    [],
    [],
  );
  const [selection, setSelection] = useState<SharingSelection>(() => ({
    ...DEFAULT_SHARING_SELECTION,
    kinds: [...sharingKinds],
    ids: [],
  }));
  const [request, setRequest] = useState(requests[0]),
    [detail, setDetail] = useState(""),
    [query, setQuery] = useState("");
  const [prompt, setPrompt] = useState(""),
    [generatedSignature, setGeneratedSignature] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const active = entities.filter((e) => !e.deletedAt),
    candidates = sharingCandidates(entities, selection),
    records = sharedRecords(entities, selection);
  const rules = referenceInstructions(referenceSites, selection.targetId);
  const signature =
      sharingSignature(entities, selection, request, detail) + rules,
    current = signature === generatedSignature;
  const itemLabel = (e: Entity) => {
    if (e.kind === "session") {
      const parent = active.find((p) => p.id === e.targetId)?.title || "未分類";
      const segments = e.segments as { start: number }[];
      const date = segments?.[0]
        ? new Date(segments[0].start).toLocaleDateString("ja-JP")
        : "";
      return `${parent} · ${date} · ${Math.round(Number(e.minutes))}分`;
    }
    return String(e.title || e.question || e.date || e.id);
  };
  const displayed = candidates.filter((e) =>
    `${itemLabel(e)} ${sharingKindLabels[e.kind]}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const change = (patch: Partial<SharingSelection>, reset = false) => {
    setSelection({ ...selection, ...patch, ...(reset ? { ids: [] } : {}) });
    setConfirmed(false);
    setMessage("");
  };
  const generate = () => {
    setPrompt(
      buildStudyPrompt(request, detail, records) +
        "\n\n【参照サイトの条件】\n" +
        rules,
    );
    setGeneratedSignature(signature);
    setConfirmed(false);
    setMessage(
      "選択した内容を確認してからコピーしてください。自動送信は行いません。",
    );
  };
  const copy = async () => {
    if (busy || !current || !confirmed || !prompt) return;
    setBusy(true);
    try {
      await navigator.clipboard.writeText(prompt);
      setMessage(
        "コピーしました。共有する内容だけになっていることを確認し、ChatGPTへ貼り付けてください。",
      );
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel stack">
      <h3>ChatGPTに相談する</h3>
      <p className="muted">
        相談する項目だけを選びます。最初は0件です。APIや自動送信は使わず、コピーしてChatGPTに貼り付けます。会話からの問題・ノート作成は上の専用画面を使ってください。この相談の返答は従来のバックアップ形式です。
      </p>
      <details>
        <summary>登録した参照サイトと利用条件</summary>
        <pre className="bulk-original">{rules}</pre>
        <p className="muted">
          登録外を参照した場合はサイト名・URL・理由を明示するよう依頼します。GPTの実際の参照行動をアプリが監視・保証するものではありません。
        </p>
      </details>
      <label className="field">
        依頼
        <select
          value={request}
          onChange={(e) => {
            setRequest(e.target.value);
            setConfirmed(false);
          }}
        >
          {requests.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      </label>
      <label className="field">
        追加条件・取り上げる内容
        <textarea
          rows={4}
          value={detail}
          onChange={(e) => {
            setDetail(e.target.value);
            setConfirmed(false);
          }}
        />
      </label>
      <div className="grid three">
        <label className="field">
          共有対象を絞る：学習対象
          <select
            value={selection.targetId}
            onChange={(e) =>
              change(
                { targetId: e.target.value, subjectId: "", unitId: "" },
                true,
              )
            }
          >
            <option value="">すべての対象</option>
            {active
              .filter((e) => e.kind === "target")
              .map((e) => (
                <option key={e.id} value={e.id}>
                  {e.title}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          共有対象を絞る：科目
          <select
            value={selection.subjectId}
            disabled={!selection.targetId}
            onChange={(e) =>
              change({ subjectId: e.target.value, unitId: "" }, true)
            }
          >
            <option value="">すべての科目</option>
            {active
              .filter(
                (e) =>
                  e.kind === "subject" && e.targetId === selection.targetId,
              )
              .map((e) => (
                <option key={e.id} value={e.id}>
                  {e.title}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          共有対象を絞る：単元
          <select
            value={selection.unitId}
            disabled={!selection.subjectId}
            onChange={(e) => change({ unitId: e.target.value }, true)}
          >
            <option value="">すべての単元</option>
            {active
              .filter(
                (e) => e.kind === "unit" && e.subjectId === selection.subjectId,
              )
              .map((e) => (
                <option key={e.id} value={e.id}>
                  {e.title}
                </option>
              ))}
          </select>
        </label>
      </div>
      <fieldset className="stack">
        <legend>表示するデータの種類</legend>
        <div className="sharing-types">
          {sharingKinds.map((kind) => (
            <label className="row" key={kind}>
              <input
                type="checkbox"
                checked={selection.kinds.includes(kind)}
                onChange={(e) =>
                  change(
                    {
                      kinds: e.target.checked
                        ? [...selection.kinds, kind]
                        : selection.kinds.filter((k) => k !== kind),
                    },
                    true,
                  )
                }
              />
              {sharingKindLabels[kind]}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="field">
        項目を検索
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            change({ ids: [] });
          }}
          placeholder="タイトル・問題・日付"
        />
      </label>
      <div className="row">
        <strong>共有する項目：{records.length}件</strong>
        <button
          className="secondary"
          disabled={!displayed.length}
          onClick={() =>
            change({
              ids: [
                ...new Set([...selection.ids, ...displayed.map((e) => e.id)]),
              ],
            })
          }
        >
          表示中の{displayed.length}件を選択
        </button>
        <button
          className="secondary"
          disabled={!selection.ids.length}
          onClick={() => change({ ids: [] })}
        >
          選択をすべて解除
        </button>
      </div>
      <div className="sharing-list">
        {displayed.length ? (
          displayed.map((e) => (
            <label className="sharing-item" key={e.id}>
              <input
                type="checkbox"
                checked={selection.ids.includes(e.id)}
                onChange={(ev) =>
                  change({
                    ids: ev.target.checked
                      ? [...selection.ids, e.id]
                      : selection.ids.filter((id) => id !== e.id),
                  })
                }
              />
              <span>
                <strong>{itemLabel(e)}</strong>
                <small className="muted">
                  {sharingKindLabels[e.kind]}
                  {e.kind === "session"
                    ? ` · ${Math.round(Number(e.minutes))}分`
                    : ""}
                </small>
              </span>
            </label>
          ))
        ) : (
          <p className="muted">
            該当する項目はありません。データを選ばずに依頼文だけ作成することもできます。
          </p>
        )}
      </div>
      <label className="row">
        <input
          type="checkbox"
          checked={selection.includePrivateNotes}
          onChange={(e) => change({ includePrivateNotes: e.target.checked })}
        />
        学習記録のメモ・誤答原因も含める
      </label>
      <p className="muted">
        選択したノートの本文、カード・問題の解答と解説、所属IDは含まれます。正確な計測開始・終了時刻、復習の全履歴、ログイン情報は含めません。絞り込み条件を変えると選択は解除されます。
      </p>
      <details>
        <summary>今回共有するデータを確認（{records.length}件）</summary>
        <pre data-testid="sharing-preview">
          {JSON.stringify(records, null, 2)}
        </pre>
      </details>
      <button className="secondary" onClick={generate}>
        選択した内容で依頼文を作成
      </button>
      {prompt && (
        <>
          <label className="field">
            送信前の確認
            <textarea
              rows={12}
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                setConfirmed(false);
              }}
            />
          </label>
          {!current && (
            <p role="alert" className="notice">
              選択条件または学習データが変わりました。依頼文を作成し直してください。
            </p>
          )}
          <label className="row">
            <input
              type="checkbox"
              checked={confirmed && current}
              disabled={!current}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            依頼文に含まれる内容を確認した
          </label>
          <button
            className="primary"
            disabled={!current || !confirmed || !prompt || busy}
            onClick={() => void copy()}
          >
            依頼文をコピー
          </button>
        </>
      )}
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
    </section>
  );
}
