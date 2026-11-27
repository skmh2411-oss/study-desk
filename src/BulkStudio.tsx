import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./db";
import type { CardType, Entity } from "./models";
import type { ImportPreview } from "./exchange";
import { citationSiteStatus, referenceInstructions } from "./references";
import {
  extractCandidates,
  duplicateCandidateIds,
  prepareBulk,
  commitBulk,
  trashImportBatch,
  type BulkCandidate,
  type BulkSettings,
} from "./bulk";
const labels: Record<CardType, string> = {
  qa: "一問一答",
  formula: "計算式",
  number: "数値確認",
};
export function BulkStudio({
  entities,
  onError,
  initialKind = "card",
}: {
  entities: Entity[];
  onError: (e: unknown) => void;
  initialKind?: "card" | "question";
}) {
  const [settings, setSettings] = useState<BulkSettings>({
    kind: initialKind,
    targetId: "",
    subjectId: "",
    unitId: "",
    cardType: "auto",
    importance: 3,
    source: "",
    sourceUrl: "",
    asOf: "",
  });
  const [raw, setRaw] = useState("");
  const [rows, setRows] = useState<BulkCandidate[]>([]),
    [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [confirmed, setConfirmed] = useState(false),
    [minImportance, setMinImportance] = useState(1);
  const [filterType, setFilterType] = useState("all"),
    [find, setFind] = useState("");
  const sites = useLiveQuery(() => db.referenceSites.toArray(), [], []);
  const lock = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const invalidate = () => {
    setPreview(null);
    setConfirmed(false);
    setMessage("");
  };
  const changeSettings = (patch: Partial<BulkSettings>) => {
    setSettings({ ...settings, ...patch });
    invalidate();
  };
  const update = (id: string, patch: Partial<BulkCandidate>) => {
    setRows((old) => old.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    invalidate();
  };
  const action = async (fn: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setMessage("");
    try {
      await fn();
    } catch (e) {
      if (mounted.current) onError(e);
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const duplicates = duplicateCandidateIds(rows);
  const shown = rows.filter(
    (r) =>
      r.importance >= minImportance &&
      (filterType === "all" || r.cardType === filterType) &&
      `${r.question} ${r.answer}`.includes(find),
  );
  const chosen = rows.filter((r) => r.selected);
  const batches = Array.from(
    new Set(
      entities
        .filter((r) => r.batchId && !r.deletedAt)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((r) => String(r.batchId)),
    ),
  )
    .slice(0, 5)
    .map((id) => ({
      id,
      records: entities.filter((r) => r.batchId === id && !r.deletedAt),
    }));
  const outside = chosen.filter(
    (r) =>
      citationSiteStatus(r.sourceUrl, sites, settings.targetId) === "external",
  ).length;
  const generate = () => {
    try {
      if (
        rows.length &&
        !confirm(
          "現在の候補を新しい素材から作り直しますか？ 保存済みデータは変更しません。",
        )
      )
        return;
      const candidates = extractCandidates(raw, settings),
        dup = duplicateCandidateIds(candidates);
      setRows(
        candidates.map((r) => ({
          ...r,
          selected: r.selected && !dup.has(r.id),
        })),
      );
      invalidate();
    } catch (e) {
      onError(e);
    }
  };
  return (
    <div className="stack bulk-studio">
      <div>
        <p className="eyebrow">YOUR STUDY MATERIALS</p>
        <h1>
          {initialKind === "question"
            ? "科目別・重要問題を取り込む"
            : "整形済みカードを一括登録"}
        </h1>
        <p className="muted">
          問題と解答が整ったJSON・CSV・TSV・Q/Aだけを登録します。一般文章を機械的に分割して問題にする機能はありません。会話からの作成は「GPTに相談」の新しい取り込み画面を使ってください。
        </p>
      </div>
      <fieldset disabled={busy} className="panel stack">
        <h2>素材と保存先</h2>
        <div className="grid three">
          <label className="field">
            保存する種類
            <select
              value={settings.kind}
              onChange={(e) => {
                if (
                  rows.length &&
                  !confirm("種類を変更して候補を作り直しますか？")
                )
                  return;
                changeSettings({
                  kind: e.target.value as BulkSettings["kind"],
                });
                setRows([]);
              }}
            >
              <option value="card">暗記カード</option>
              <option value="question">演習問題</option>
            </select>
          </label>
          <label className="field">
            学習対象
            <select
              value={settings.targetId}
              onChange={(e) =>
                changeSettings({
                  targetId: e.target.value,
                  subjectId: "",
                  unitId: "",
                })
              }
            >
              <option value="">未分類</option>
              {entities
                .filter((e) => e.kind === "target")
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.title}
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            科目
            <select
              value={settings.subjectId}
              onChange={(e) =>
                changeSettings({ subjectId: e.target.value, unitId: "" })
              }
            >
              <option value="">未分類</option>
              {entities
                .filter(
                  (e) =>
                    e.kind === "subject" && e.targetId === settings.targetId,
                )
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.title}
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            単元
            <select
              value={settings.unitId}
              onChange={(e) => changeSettings({ unitId: e.target.value })}
            >
              <option value="">未分類</option>
              {entities
                .filter(
                  (e) =>
                    e.kind === "unit" &&
                    !!settings.subjectId &&
                    e.subjectId === settings.subjectId,
                )
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.title}
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            カードの種類
            <select
              value={settings.cardType}
              onChange={(e) =>
                changeSettings({
                  cardType: e.target.value as BulkSettings["cardType"],
                })
              }
            >
              <option value="auto">素材から分類（確認が必要）</option>
              {Object.entries(labels).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            共通の重要度
            <select
              value={settings.importance}
              onChange={(e) => changeSettings({ importance: +e.target.value })}
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                  {n >= 4 ? "・重要" : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="grid three">
          <label className="field">
            出典名
            <input
              value={settings.source}
              onChange={(e) => changeSettings({ source: e.target.value })}
            />
          </label>
          <label className="field">
            出典URL（任意）
            <input
              type="url"
              value={settings.sourceUrl}
              onChange={(e) => changeSettings({ sourceUrl: e.target.value })}
            />
          </label>
          <label className="field">
            資料の適用基準日（任意）
            <input
              type="date"
              value={settings.asOf}
              onChange={(e) => changeSettings({ asOf: e.target.value })}
            />
          </label>
        </div>
        <label className="field">
          整形済みのテキスト・CSV・JSONファイル
          <input
            type="file"
            accept=".txt,.csv,.tsv,.json,text/plain,text/csv,application/json"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              if (f.size > 5 * 1024 * 1024) {
                onError(new Error("5MB以下のファイルを選んでください。"));
                return;
              }
              void action(async () => {
                const value = await f.text();
                if (mounted.current) {
                  setRaw(value);
                  invalidate();
                }
              });
            }}
          />
        </label>
        <label className="field">
          素材のテキスト
          <textarea
            rows={8}
            maxLength={500000}
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value);
              invalidate();
            }}
            placeholder={
              "Q: 用語の意味は？\nA: 答え\n\n割合 = 部分 ÷ 全体 × 100\n項目：30日以内（条件を含める）"
            }
          />
        </label>
        <p className="muted">
          Q:とA:で区切った問題・解答、タブ区切り、CSV・JSONに対応します。改行された問題本文・解答・例外はまとめて保持します。一般文章や数値一覧はGPTで問題・解答に整えてください。
        </p>
        <details>
          <summary>CSV・JSONの形式</summary>
          <pre className="bulk-example">
            {
              'question,answer,importance,sourceUrl,sourceQuestionId,conditions\n"問題","答え",4,"https://example.com/q/1","1","適用条件"\n\n{"cards":[{"question":"問題","answer":"答え"}]}\n演習問題は {"questions":[{"question":"問題","choices":["○","×"],"answer":"○"}]}'
            }
          </pre>
        </details>
        <button
          className="primary"
          type="button"
          disabled={!raw.trim()}
          onClick={generate}
        >
          素材から候補を作る
        </button>
      </fieldset>
      {busy && <p role="status">処理しています…</p>}
      {!!rows.length && (
        <fieldset disabled={busy} className="panel stack">
          <h2>候補を選んで修正する</h2>
          <p>
            全{rows.length}件・選択{chosen.length}件・登録外の出典{outside}件
          </p>
          <div className="grid three">
            <label className="field">
              候補を検索
              <input value={find} onChange={(e) => setFind(e.target.value)} />
            </label>
            <label className="field">
              重要度で絞る
              <select
                value={minImportance}
                onChange={(e) => setMinImportance(+e.target.value)}
              >
                <option value={1}>すべて</option>
                <option value={4}>重要（4・5）のみ</option>
                <option value={5}>最重要（5）のみ</option>
              </select>
            </label>
            <label className="field">
              種類で絞る
              <select
                value={filterType}
                onChange={(e) => setFilterType(e.target.value)}
              >
                <option value="all">すべて</option>
                {Object.entries(labels).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="row">
            <button
              type="button"
              onClick={() => {
                setRows(
                  rows.map((r) =>
                    shown.some((s) => s.id === r.id) &&
                    r.question &&
                    r.answer &&
                    !duplicates.has(r.id)
                      ? { ...r, selected: true }
                      : { ...r, selected: false },
                  ),
                );
                invalidate();
              }}
            >
              表示中だけを選択
            </button>
            <button
              type="button"
              onClick={() => {
                setRows(rows.map((r) => ({ ...r, selected: false })));
                invalidate();
              }}
            >
              選択をすべて解除
            </button>
            <button
              type="button"
              onClick={() => {
                setRows(
                  rows.map((r) =>
                    r.selected
                      ? {
                          ...r,
                          importance: settings.importance,
                          source: settings.source,
                          sourceUrl: settings.sourceUrl,
                          ...(settings.cardType !== "auto"
                            ? { cardType: settings.cardType }
                            : {}),
                        }
                      : r,
                  ),
                );
                invalidate();
              }}
            >
              選択候補に共通設定を反映
            </button>
          </div>
          {shown.map((r, i) => (
            <article className="bulk-candidate stack" key={r.id}>
              <div className="row">
                <label>
                  <input
                    type="checkbox"
                    checked={r.selected}
                    onChange={(e) =>
                      update(r.id, { selected: e.target.checked })
                    }
                  />{" "}
                  候補 {i + 1}
                </label>
                <span className="badge">{labels[r.cardType]}</span>
              </div>
              {duplicates.has(r.id) && (
                <p className="notice">
                  同じ内容の候補があります。保存時にも重複を除外します。
                </p>
              )}
              {r.warnings
                .filter(
                  (w) => !(w.includes("空です") && r.question && r.answer),
                )
                .map((w) => (
                  <small className="muted" key={w}>
                    {w}
                  </small>
                ))}
              <label className="field">
                問題
                <textarea
                  rows={2}
                  value={r.question}
                  onChange={(e) => update(r.id, { question: e.target.value })}
                />
              </label>
              <label className="field">
                答え
                <textarea
                  rows={2}
                  value={r.answer}
                  onChange={(e) => update(r.id, { answer: e.target.value })}
                />
              </label>
              {settings.kind === "question" && (
                <label className="field">
                  選択肢（1行に1つ）
                  <textarea
                    rows={3}
                    value={r.choices.join("\n")}
                    onChange={(e) =>
                      update(r.id, { choices: e.target.value.split("\n") })
                    }
                  />
                </label>
              )}
              <div className="grid three">
                <label className="field">
                  カード種別
                  <select
                    value={r.cardType}
                    onChange={(e) =>
                      update(r.id, { cardType: e.target.value as CardType })
                    }
                  >
                    {Object.entries(labels).map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  単位
                  <input
                    value={r.answerUnit}
                    onChange={(e) =>
                      update(r.id, { answerUnit: e.target.value })
                    }
                  />
                </label>
                <label className="field">
                  重要度
                  <select
                    value={r.importance}
                    onChange={(e) =>
                      update(r.id, { importance: +e.target.value })
                    }
                  >
                    {[1, 2, 3, 4, 5].map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="field">
                適用条件・起算点
                <input
                  value={r.conditions}
                  onChange={(e) => update(r.id, { conditions: e.target.value })}
                />
              </label>
              <label className="field">
                根拠・出典URL
                <input
                  value={r.sourceUrl}
                  onChange={(e) => update(r.id, { sourceUrl: e.target.value })}
                />
              </label>
              <p className="muted">
                {
                  {
                    registered: "登録範囲内・内容は未確認",
                    external: "登録外の参照先を使用",
                    missing: "参照先未確認",
                  }[citationSiteStatus(r.sourceUrl, sites, settings.targetId)]
                }
              </p>
              <details>
                <summary>元の資料と出典を見る</summary>
                <pre className="bulk-original">{r.originalText}</pre>
                <p>
                  {r.source || "出典名未登録"}
                  {r.sourceQuestionId ? ` · 問題ID ${r.sourceQuestionId}` : ""}
                </p>
              </details>
            </article>
          ))}
          {!shown.length && <p>表示条件に該当する候補はありません。</p>}
          <p className="muted">
            絞り込みは表示だけに適用されます。保存対象はチェックが付いた
            {chosen.length}件です。
          </p>
          <button
            type="button"
            className="primary"
            disabled={!chosen.length}
            onClick={() =>
              void action(async () => {
                invalidate();
                const p = await prepareBulk(rows, settings);
                if (mounted.current) setPreview(p);
              })
            }
          >
            選択した候補を検証する
          </button>
        </fieldset>
      )}
      {preview && (
        <section className="panel stack" aria-label="一括保存の最終確認">
          <h2>保存前の最終確認</h2>
          <p>
            追加 {preview.records.length}件・重複 {preview.duplicates}件・競合{" "}
            {preview.conflicts}件
          </p>
          {preview.warnings.map((w, i) => (
            <p key={i} className="notice">
              {w}
            </p>
          ))}
          <p>
            保存先：
            {entities.find((e) => e.id === settings.targetId)?.title ||
              "未分類"}{" "}
            /{" "}
            {entities.find((e) => e.id === settings.subjectId)?.title ||
              "未分類"}
          </p>
          {!!outside && (
            <p className="notice">
              登録外の参照先を使用する候補が{outside}
              件あります。上の各候補にURLを表示しています。
            </p>
          )}
          <p className="muted">
            保存状態は「資料から抽出」です。法令・条件の正しさを確認済みとは扱いません。
          </p>
          <label>
            <input
              type="checkbox"
              disabled={busy}
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />{" "}
            問題・答え・単位・条件・出典・保存先を確認しました
          </label>
          <button
            type="button"
            className="primary"
            disabled={!confirmed || busy || !preview.records.length}
            onClick={() =>
              void action(async () => {
                const result = await commitBulk(preview);
                if (!mounted.current) return;
                setRows([]);
                setPreview(null);
                setConfirmed(false);
                setMessage(
                  `${result.added}件を追加しました。重複・競合 ${result.skipped}件は追加していません。`,
                );
              })
            }
          >
            確認した内容を一括保存
          </button>
        </section>
      )}
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      <details className="panel">
        <summary>GPTに渡す参照条件</summary>
        <pre className="bulk-original">
          {referenceInstructions(sites, settings.targetId)}
        </pre>
      </details>
      {!!batches.length && (
        <details className="panel">
          <summary>直近の取り込み履歴・取り消し</summary>
          <div className="stack">
            {batches.map((batch) => (
              <div key={batch.id} className="row">
                <span>
                  {new Date(batch.records[0].createdAt).toLocaleString("ja-JP")}{" "}
                  · {batch.records.length}件
                </span>
                <button
                  disabled={busy}
                  onClick={() => {
                    if (
                      confirm(
                        `この取り込みで追加した${batch.records.length}件をゴミ箱へ移動しますか？ 編集内容・復習履歴は保持され、設定のゴミ箱から戻せます。`,
                      )
                    )
                      void action(async () => {
                        await trashImportBatch(batch.records);
                        setMessage("取り込み分をゴミ箱へ移動しました。");
                      });
                  }}
                >
                  この取り込みを取り消す
                </button>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
