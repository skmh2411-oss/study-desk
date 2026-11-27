import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, getPreferences, setPreferences } from "./db";
import { decodeLearningBytes } from "./learningFormats";
import { type ImportPreview } from "./exchange";
import { SafeMarkdown } from "./Learning";
import { referenceInstructions, citationSiteStatus } from "./references";
import type { Entity } from "./models";
import {
  buildConversationPrompt,
  materialLabels,
  parseLearningInput,
  missingEvidenceCount,
  resolveLearningScope,
  previewLearningImport,
  applyLearningImport,
  type MaterialDraft,
  type MaterialKind,
  type TransferScope,
} from "./conversationTransfer";

export function ConversationTransfer({
  entities,
}: {
  entities: Entity[];
  onError: (e: unknown) => void;
}) {
  const [kinds, setKinds] = useState<MaterialKind[]>([
    "card",
    "question",
    "note",
  ]);
  const [count, setCount] = useState(20),
    [detail, setDetail] = useState("");
  const [prompt, setPrompt] = useState(""),
    [promptApproved, setPromptApproved] = useState(false);
  const [raw, setRaw] = useState(""),
    [fileName, setFileName] = useState("");
  const [asNote, setAsNote] = useState(false),
    [inputError, setInputError] = useState(""),
    [actionError, setActionError] = useState(""),
    [readStatus, setReadStatus] = useState(""),
    [missingApproved, setMissingApproved] = useState(false);
  const inputFeedback = useRef<HTMLDivElement>(null),
    actionFeedback = useRef<HTMLDivElement>(null),
    scopeTouched = useRef(false);
  const preferences = useLiveQuery(() => getPreferences(), []);
  useEffect(() => {
    if (!scopeTouched.current && preferences)
      setScope(resolveLearningScope(entities, preferences.lastLearningScope));
  }, [preferences, entities]);
  useEffect(() => {
    if (inputError || readStatus) {
      inputFeedback.current?.focus({ preventScroll: true });
      inputFeedback.current?.scrollIntoView({ block: "nearest" });
    }
  }, [inputError, readStatus]);
  const [drafts, setDrafts] = useState<MaterialDraft[]>([]),
    [preview, setPreview] = useState<ImportPreview | null>(null);
  const [preparedScope, setPreparedScope] = useState<TransferScope | null>(
      null,
    ),
    [preparedGeneration, setPreparedGeneration] = useState(-1);
  const [scope, setScope] = useState<TransferScope>({
    targetId: "",
    subjectId: "",
    unitId: "",
  });
  const [filter, setFilter] = useState("all"),
    [minImportance, setMinImportance] = useState(1);
  const [approved, setApproved] = useState(false),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (actionError || message) {
      actionFeedback.current?.focus({ preventScroll: true });
      actionFeedback.current?.scrollIntoView({ block: "nearest" });
    }
  }, [actionError, message]);
  const lock = useRef(false),
    generation = useRef(0),
    fileInput = useRef<HTMLInputElement>(null);
  const sites = useLiveQuery(() => db.referenceSites.toArray(), [], []);
  const invalidate = () => {
    generation.current++;
    setPreview(null);
    setPreparedScope(null);
    setApproved(false);
    setMessage("");
    setActionError("");
    setMissingApproved(false);
  };
  const resolvedScope = resolveLearningScope(entities, scope);
  const destinationSignature = JSON.stringify({ scope, resolvedScope });
  useEffect(() => {
    invalidate();
  }, [destinationSignature]);
  const currentPreview =
    !!preview &&
    !!preparedScope &&
    !inputError &&
    preparedGeneration === generation.current &&
    JSON.stringify(preparedScope) === JSON.stringify(scope) &&
    JSON.stringify(scope) === JSON.stringify(resolvedScope);
  const promptSignature = JSON.stringify({
    kinds,
    count,
    detail,
    rules: referenceInstructions(sites, scope.targetId),
  });
  const [generatedSignature, setGeneratedSignature] = useState("");
  const current = promptSignature === generatedSignature;
  const reportError = (e: unknown, area: "input" | "action" = "action") => {
    const text = e instanceof Error ? e.message : String(e);
    if (area === "input") {
      setInputError(text);
      setReadStatus("");
    } else setActionError(text);
  };
  const changeScope = (next: TransferScope) => {
    scopeTouched.current = true;
    setScope(next);
    invalidate();
    void setPreferences({ lastLearningScope: next }).catch((e) =>
      reportError(e),
    );
  };
  const work = async (
    fn: () => Promise<void>,
    area: "input" | "action" = "action",
  ) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    if (area === "input") invalidate();
    setActionError("");
    try {
      await fn();
    } catch (e) {
      reportError(e, area);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const update = (id: string, key: string, value: unknown) => {
    setDrafts((old) =>
      old.map((d) =>
        d.record.id === id
          ? { ...d, record: { ...d.record, [key]: value } }
          : d,
      ),
    );
    invalidate();
  };
  const shown = drafts.filter(
    (d) =>
      (filter === "all" || d.record.kind === filter) &&
      Number(d.record.importance) >= minImportance,
  );
  const selected = drafts.filter((d) => d.selected);
  const missing = missingEvidenceCount(drafts);
  const decode = (input: string, name: string) => {
    try {
      invalidate();
      setInputError("");
      const result = parseLearningInput(input, name, asNote);
      const next = result.drafts;
      if (
        drafts.length &&
        !confirm(
          "現在の取り込み候補を作り直しますか？保存済みデータは変更しません。",
        )
      )
        return;
      setRaw(input);
      setFileName(name);
      setDrafts(next);
      invalidate();
      setFilter("all");
      setMinImportance(1);
      setReadStatus(
        `${name || "貼り付けた内容"}：${result.formatLabel}として${next.length}件を読み込みました。下の候補を確認してください。まだ保存していません。`,
      );
    } catch (e) {
      reportError(e, "input");
    }
  };
  return (
    <section className="panel stack conversation-transfer">
      <h2>GPT会話から問題・ノートを取り込む</h2>
      <p>
        会話を自動取得しません。依頼文を学習したGPTのチャットへ貼り付け、返答をファイルまたはコピーで戻します。画像の解析が必要なら、GPTのチャットで必要な画像を自分で添付してください。
      </p>
      <details open>
        <summary>1．学習したGPTの会話に貼る依頼文</summary>
        <fieldset disabled={busy} className="stack">
          <div className="row">
            {(Object.keys(materialLabels) as MaterialKind[]).map((k) => (
              <label className="row" key={k}>
                <input
                  type="checkbox"
                  checked={kinds.includes(k)}
                  onChange={(e) => {
                    setKinds(
                      e.target.checked
                        ? [...kinds, k]
                        : kinds.filter((x) => x !== k),
                    );
                    setPromptApproved(false);
                  }}
                />
                {materialLabels[k]}
              </label>
            ))}
          </div>
          <label className="field">
            合計の作成上限
            <input
              type="number"
              min={1}
              max={100}
              value={count}
              onChange={(e) => {
                setCount(Number(e.target.value));
                setPromptApproved(false);
              }}
            />
          </label>
          <label className="field">
            取り上げる内容・追加条件
            <textarea
              rows={3}
              maxLength={10000}
              value={detail}
              placeholder="例：この会話の重要な数値と計算式を中心に。ノートは比較表で。"
              onChange={(e) => {
                setDetail(e.target.value);
                setPromptApproved(false);
              }}
            />
          </label>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              try {
                setPrompt(
                  buildConversationPrompt(
                    kinds,
                    count,
                    detail,
                    referenceInstructions(sites, scope.targetId),
                  ),
                );
                setGeneratedSignature(promptSignature);
                setPromptApproved(false);
              } catch (e) {
                reportError(e);
              }
            }}
          >
            会話用の依頼文を作成
          </button>
          {prompt && (
            <>
              <label className="field">
                GPTへ渡す依頼文
                <textarea rows={9} readOnly value={prompt} />
              </label>
              {!current && (
                <p role="alert">
                  条件が変わりました。依頼文を作成し直してください。
                </p>
              )}
              <label className="row">
                <input
                  type="checkbox"
                  checked={promptApproved && current}
                  disabled={!current}
                  onChange={(e) => setPromptApproved(e.target.checked)}
                />
                依頼文と参照サイトの情報を確認した
              </label>
              <button
                type="button"
                className="primary"
                disabled={!promptApproved || !current}
                onClick={() =>
                  void work(async () => {
                    await navigator.clipboard.writeText(prompt);
                    setMessage(
                      "コピーしました。学習したGPTの会話へ貼り付けてください。アプリの学習データは含めていません。",
                    );
                  })
                }
              >
                会話用の依頼文をコピー
              </button>
            </>
          )}
          <p className="muted">
            すでにある会話の末尾へ貼り付けます。別の新しいチャットでは元の会話を参照できない場合があります。共有する画像・会話内容は本人が選んでください。
          </p>
        </fieldset>
      </details>
      <fieldset disabled={busy} className="stack">
        <legend>2．GPTの返答を戻す</legend>
        <input
          hidden
          ref={fileInput}
          type="file"
          accept=".json,.flashcards,.csv,.tsv,.txt,.md,.markdown,.mdown,application/json,text/csv,text/tab-separated-values,text/plain,text/markdown"
          aria-label="学習素材ファイル"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            void work(async () => {
              setInputError("");
              setReadStatus(`${f.name}を読み込んでいます…`);
              setFileName(f.name);
              if (f.size > 5 * 1024 * 1024)
                throw new Error("ファイルは5MB以下にしてください。");
              const text = decodeLearningBytes(await f.arrayBuffer(), f.name);
              decode(text, f.name);
            }, "input");
          }}
        />
        <button
          type="button"
          className="primary"
          onClick={() => fileInput.current?.click()}
        >
          ファイルを選んで取り込む
        </button>
        <p className="muted">
          JSON（従来のカード用形式・front/backにも対応）・CSV・TSV・TXT・Markdownを自動判別します。ファイルは5MB・内容は50万文字・素材は100件まで。ファイルがなくても下へ貼り付けて取り込めます。
        </p>
        <label className="field">
          内容の扱い
          <select
            value={asNote ? "note" : "auto"}
            onChange={(e) => {
              setAsNote(e.target.value === "note");
              setDrafts([]);
              setInputError("");
              setReadStatus("");
              invalidate();
            }}
          >
            <option value="auto">自動判別（通常はこちら）</option>
            <option value="note">ノート1件として取り込む</option>
          </select>
        </label>
        <label className="field">
          GPTからの返答・学習素材
          <textarea
            rows={7}
            value={raw}
            maxLength={500000}
            onChange={(e) => {
              setRaw(e.target.value);
              setFileName("");
              setInputError("");
              setReadStatus("");
              setDrafts([]);
              invalidate();
            }}
          />
        </label>
        <button
          type="button"
          className="secondary"
          disabled={!raw.trim()}
          onClick={() => decode(raw, fileName)}
        >
          貼り付けた内容を読み込む
        </button>
        <div ref={inputFeedback} tabIndex={-1} className="transfer-feedback">
          {inputError && (
            <p role="alert" className="error">
              読み込めませんでした：{inputError}
            </p>
          )}
          {readStatus && (
            <p role="status" className="notice">
              {readStatus}
            </p>
          )}
        </div>
        <details>
          <summary>対応形式と簡単な入力例</summary>
          <p>
            カードJSONはcards配列・JSON配列のquestion/answerまたはfront/backに対応。CSVの見出しは「問題,解答」や「question,answer」。Excelの2列をコピーしたタブ区切りにも対応します。
          </p>
          <pre>{`Q: 確認するものは？\nA: 数値・単位・適用条件\n\nQ: 次の確認は？\nA: 原文との照合`}</pre>
          <p>
            Q:とA:の本文・解答は複数行で記述できます。一般文章は「ノート1件として取り込む」を選びます。Markdownファイルはノートになります。PDF・Word・画像の直接読み取りは対象外です。
          </p>
        </details>
        <p className="muted">
          保存先は前回の選択をこの端末に記憶します。未分類のまま保存して後から変更することもできます。
        </p>
        <div className="grid three">
          <label className="field">
            保存先の学習対象
            <select
              value={scope.targetId}
              onChange={(e) => {
                changeScope({
                  targetId: e.target.value,
                  subjectId: "",
                  unitId: "",
                });
              }}
            >
              <option value="">未分類</option>
              {entities
                .filter((e) => e.kind === "target" && !e.deletedAt)
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.title}
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            保存先の科目
            <select
              value={scope.subjectId}
              disabled={!scope.targetId}
              onChange={(e) => {
                changeScope({
                  ...scope,
                  subjectId: e.target.value,
                  unitId: "",
                });
              }}
            >
              <option value="">未分類</option>
              {entities
                .filter(
                  (e) =>
                    e.kind === "subject" &&
                    e.targetId === scope.targetId &&
                    !e.deletedAt,
                )
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.title}
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            保存先の単元
            <select
              value={scope.unitId}
              disabled={!scope.subjectId}
              onChange={(e) => {
                changeScope({ ...scope, unitId: e.target.value });
              }}
            >
              <option value="">未分類</option>
              {entities
                .filter(
                  (e) =>
                    e.kind === "unit" &&
                    e.subjectId === scope.subjectId &&
                    !e.deletedAt,
                )
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.title}
                  </option>
                ))}
            </select>
          </label>
        </div>
      </fieldset>
      {!!drafts.length && (
        <fieldset disabled={busy} className="stack">
          <legend>3．保存する素材を選ぶ・修正する</legend>
          <p role="status">
            候補 {drafts.length}件・選択 {selected.length}件（
            {(Object.keys(materialLabels) as MaterialKind[])
              .map(
                (k) =>
                  `${materialLabels[k]} ${selected.filter((d) => d.record.kind === k).length}件`,
              )
              .join(" / ")}
            ）
          </p>
          <div className="grid two">
            <label className="field">
              素材の種類で絞る
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="all">すべて</option>
                {Object.entries(materialLabels).map(([k, v]) => (
                  <option value={k} key={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              素材の重要度で絞る
              <select
                value={minImportance}
                onChange={(e) => setMinImportance(Number(e.target.value))}
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <option value={n} key={n}>
                    {n}以上
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="row">
            <button
              type="button"
              onClick={() => {
                const ids = new Set(shown.map((d) => d.record.id));
                setDrafts(
                  drafts.map((d) => ({ ...d, selected: ids.has(d.record.id) })),
                );
                invalidate();
              }}
            >
              表示中の素材だけを選択
            </button>
            <button
              type="button"
              onClick={() => {
                setDrafts(drafts.map((d) => ({ ...d, selected: false })));
                invalidate();
              }}
            >
              素材の選択をすべて解除
            </button>
          </div>
          {shown.map((d, index) => {
            const r = d.record;
            return (
              <details className="bulk-candidate" key={r.id}>
                <summary>
                  {materialLabels[r.kind as MaterialKind]}：
                  {String(r.title || r.question)}
                </summary>
                <label className="row">
                  <input
                    type="checkbox"
                    checked={d.selected}
                    onChange={(e) => {
                      setDrafts(
                        drafts.map((x) =>
                          x.record.id === r.id
                            ? { ...x, selected: e.target.checked }
                            : x,
                        ),
                      );
                      invalidate();
                    }}
                  />
                  この素材を保存する
                </label>
                <label className="field">
                  {r.kind === "note" ? "ノートの題名" : "問題"}
                  <textarea
                    rows={2}
                    value={String(r.title || r.question || "")}
                    onChange={(e) =>
                      update(
                        r.id,
                        r.kind === "note" ? "title" : "question",
                        e.target.value,
                      )
                    }
                  />
                </label>
                <label className="field">
                  {r.kind === "note" ? "ノート本文（Markdown）" : "解答"}
                  <textarea
                    rows={r.kind === "note" ? 8 : 3}
                    value={String(r.kind === "note" ? r.body : r.answer)}
                    onChange={(e) =>
                      update(
                        r.id,
                        r.kind === "note" ? "body" : "answer",
                        e.target.value,
                      )
                    }
                  />
                </label>
                {r.kind === "question" && (
                  <label className="field">
                    選択肢（1行に1つ）
                    <textarea
                      value={(r.choices as string[]).join("\n")}
                      onChange={(e) =>
                        update(r.id, "choices", e.target.value.split("\n"))
                      }
                    />
                  </label>
                )}
                {r.kind !== "note" && (
                  <>
                    <label className="field">
                      適用条件
                      <textarea
                        value={String(r.conditions || "")}
                        onChange={(e) =>
                          update(r.id, "conditions", e.target.value)
                        }
                      />
                    </label>
                    <label className="field">
                      単位
                      <input
                        value={String(r.answerUnit || "")}
                        onChange={(e) =>
                          update(r.id, "answerUnit", e.target.value)
                        }
                      />
                    </label>
                  </>
                )}
                <label className="field">
                  根拠の原文
                  <textarea
                    rows={3}
                    value={String(r.originalText || "")}
                    onChange={(e) =>
                      update(r.id, "originalText", e.target.value)
                    }
                  />
                </label>
                <label className="field">
                  出典名
                  <input
                    value={String(r.source || "")}
                    onChange={(e) => update(r.id, "source", e.target.value)}
                  />
                </label>
                <label className="field">
                  出典URL
                  <input
                    type="url"
                    value={String(r.sourceUrl || "")}
                    onChange={(e) => update(r.id, "sourceUrl", e.target.value)}
                  />
                </label>
                <p className="muted">
                  {citationSiteStatus(
                    String(r.sourceUrl || ""),
                    sites,
                    scope.targetId,
                  ) === "registered"
                    ? "登録参照サイト（内容は未確認）"
                    : r.sourceUrl
                      ? "登録外の参照先です。利用理由と内容を確認してください。"
                      : "URL未登録。会話内の回答だけでは出典確認済みになりません。"}
                </p>
                <label className="field">
                  重要度
                  <select
                    value={Number(r.importance)}
                    onChange={(e) =>
                      update(r.id, "importance", Number(e.target.value))
                    }
                  >
                    {[1, 2, 3, 4, 5].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                {r.kind === "note" && (
                  <SafeMarkdown>{String(r.body)}</SafeMarkdown>
                )}
              </details>
            );
          })}
          {missing > 0 && (
            <div className="notice stack">
              <p>
                {missing}
                件のカード・問題に根拠の原文がありません。問題と解答から原文を補作せず、出典未確認として扱います。内容を照合してから利用してください。
              </p>
              <label className="row">
                <input
                  type="checkbox"
                  checked={missingApproved}
                  onChange={(e) => {
                    setMissingApproved(e.target.checked);
                    setPreview(null);
                    setApproved(false);
                  }}
                />
                原文がない素材を出典未確認として取り込むことを確認した
              </label>
            </div>
          )}
          <button
            type="button"
            className="primary"
            disabled={
              !selected.length ||
              !!inputError ||
              (missing > 0 && !missingApproved)
            }
            onClick={() =>
              void work(async () => {
                const token = generation.current;
                if (JSON.stringify(scope) !== JSON.stringify(resolvedScope))
                  throw new Error(
                    "保存先が変更・削除されています。保存先を選び直してください。",
                  );
                const result = await previewLearningImport(
                  drafts,
                  scope,
                  missingApproved,
                );
                if (token === generation.current) {
                  setPreview(result);
                  setPreparedScope({ ...scope });
                  setPreparedGeneration(token);
                  setApproved(false);
                }
              })
            }
          >
            選んだ素材の保存前プレビュー
          </button>
        </fieldset>
      )}
      {preview && (
        <section
          className="stack notice"
          aria-label="GPT素材の保存前プレビュー"
        >
          <h3>4．確認して一括保存</h3>
          <p>
            追加 {preview.records.length}件・重複 {preview.duplicates}件・競合{" "}
            {preview.conflicts}件
          </p>
          <p>
            保存先：
            {entities.find((e) => e.id === preparedScope?.targetId)?.title ||
              "未分類"}{" "}
            /{" "}
            {entities.find((e) => e.id === preparedScope?.subjectId)?.title ||
              "未分類"}{" "}
            /{" "}
            {entities.find((e) => e.id === preparedScope?.unitId)?.title ||
              "未分類"}
          </p>
          {preview.warnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
          <ul>
            {preview.records.map((r) => (
              <li key={r.id}>
                {materialLabels[r.kind as MaterialKind]}：
                {String(r.title || r.question)}
              </li>
            ))}
          </ul>
          <label className="row">
            <input
              type="checkbox"
              checked={approved}
              disabled={busy}
              onChange={(e) => setApproved(e.target.checked)}
            />
            問題・解答・数値・条件・根拠・保存先を確認した
          </label>
          <button
            type="button"
            className="primary"
            disabled={
              !approved || busy || !currentPreview || !preview.records.length
            }
            onClick={() =>
              void work(async () => {
                if (!currentPreview || !approved)
                  throw new Error(
                    "入力内容・保存先が変わりました。保存前プレビューから確認し直してください。",
                  );
                const result = await applyLearningImport(
                  preview,
                  preparedScope!,
                );
                setPreview(null);
                setDrafts([]);
                setRaw("");
                setFileName("");
                setApproved(false);
                setMessage(
                  `${result.added}件を保存しました。${result.skipped}件は重複・競合のため追加していません。ノート・暗記・ホームの演習から利用できます。`,
                );
              })
            }
          >
            確認した素材を一括保存
          </button>
        </section>
      )}
      <div ref={actionFeedback} tabIndex={-1} className="transfer-feedback">
        {actionError && (
          <p className="error" role="alert">
            {actionError}
          </p>
        )}
        {message && (
          <p className="notice" role="status">
            {message}
          </p>
        )}
      </div>
    </section>
  );
}
