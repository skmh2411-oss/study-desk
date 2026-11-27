import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, saveEntity } from "./db";
import { citationSiteStatus } from "./references";
import { today, type Entity, type Citation } from "./models";
export function SourceDetails({
  record,
  onError,
}: {
  record: Entity;
  onError: (e: unknown) => void;
}) {
  const sites = useLiveQuery(() => db.referenceSites.toArray(), [], []);
  const [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false);
  const [url, setUrl] = useState(""),
    [locator, setLocator] = useState(""),
    [asOf, setAsOf] = useState("");
  const [confirmed, setConfirmed] = useState(false),
    [version, setVersion] = useState(record.version);
  const citation = (record.citations as Citation[] | undefined)?.[0];
  const otherCitations =
    (record.citations as Citation[] | undefined)?.slice(1) || [];
  const sourceUrl = String(record.sourceUrl || citation?.url || "");
  const status = citationSiteStatus(sourceUrl, sites, record.targetId);
  return (
    <details className="source-details">
      <summary>単位・条件・出典を確認</summary>
      {!!record.answerUnit && <p>単位：{String(record.answerUnit)}</p>}
      {!!record.conditions && (
        <p>適用条件・起算点：{String(record.conditions)}</p>
      )}
      <p>
        {
          {
            extracted: "資料から抽出・内容は未確認",
            unverified: "根拠は未確認",
            verified: "本人が主な根拠の原文と照合済み",
          }[String(record.sourceStatus || "unverified") as "unverified"]
        }
      </p>
      <p className={status === "external" ? "notice" : "muted"}>
        {
          {
            registered:
              "登録範囲内の出典（登録だけでは内容確認済みになりません）",
            external: "登録外の参照先を使用",
            missing: "参照先未確認",
          }[status]
        }
      </p>
      {sourceUrl && (
        <a href={sourceUrl} target="_blank" rel="noopener noreferrer">
          根拠URLを開く
        </a>
      )}
      {citation && (
        <p className="muted">
          該当箇所：{citation.locator || "未登録"} / 適用基準日：
          {citation.asOf || "未登録"} / 照合日：{citation.checkedOn || "未登録"}
        </p>
      )}
      {otherCitations.map((c, i) => (
        <p key={i} className="muted">
          追加の参照先：
          <a href={c.url} target="_blank" rel="noopener noreferrer">
            {c.url}
          </a>{" "}
          ·{" "}
          {citationSiteStatus(c.url, sites, record.targetId) === "registered"
            ? "登録範囲内・内容は未確認"
            : "登録外の参照先を使用"}{" "}
          · {c.locator}
        </p>
      ))}
      {!!record.originalText && (
        <details>
          <summary>抽出元テキスト</summary>
          <pre className="bulk-original">{String(record.originalText)}</pre>
        </details>
      )}
      {!editing ? (
        <button
          type="button"
          onClick={() => {
            setUrl(sourceUrl);
            setLocator(citation?.locator || "");
            setAsOf(citation?.asOf || "");
            setConfirmed(false);
            setVersion(record.version);
            setEditing(true);
          }}
        >
          根拠情報を確認・編集
        </button>
      ) : (
        <fieldset disabled={busy} className="stack">
          <label className="field">
            根拠URL
            <input
              type="url"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setConfirmed(false);
              }}
            />
          </label>
          <label className="field">
            条・項・号／該当箇所
            <input
              value={locator}
              onChange={(e) => {
                setLocator(e.target.value);
                setConfirmed(false);
              }}
            />
          </label>
          <label className="field">
            適用基準日
            <input
              type="date"
              value={asOf}
              onChange={(e) => {
                setAsOf(e.target.value);
                setConfirmed(false);
              }}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />{" "}
            リンク先の原文と答え・単位・適用条件を照合しました
          </label>
          <button
            type="button"
            onClick={async () => {
              if (busy) return;
              try {
                if (confirmed && (!url.trim() || !locator.trim()))
                  throw new Error(
                    "確認済みにするには根拠URLと該当箇所を入力してください。",
                  );
                if (!confirm("このカード・問題の根拠情報を更新しますか？"))
                  return;
                setBusy(true);
                await saveEntity(
                  {
                    ...record,
                    sourceUrl: url,
                    sourceStatus: confirmed ? "verified" : "unverified",
                    citations: url
                      ? [
                          {
                            url,
                            locator,
                            asOf,
                            checkedOn: confirmed ? today() : "",
                          },
                          ...otherCitations,
                        ]
                      : otherCitations,
                  },
                  version,
                  { verifySource: confirmed },
                );
                setEditing(false);
              } catch (e) {
                onError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            照合結果を保存
          </button>
          <button type="button" onClick={() => setEditing(false)}>
            キャンセル
          </button>
        </fieldset>
      )}
    </details>
  );
}
