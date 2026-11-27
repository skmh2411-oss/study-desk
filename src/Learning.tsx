import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import {
  BookOpen,
  Plus,
  Search,
  Star,
  Check,
  RotateCcw,
  Brain,
  ChevronLeft,
} from "lucide-react";
import { db, saveEntity, trashEntity } from "./db";
import {
  type Entity,
  type Note,
  type Flashcard,
  type Question,
  type Attempt,
  today,
} from "./models";
import {
  createEmptyCard,
  reviewCard,
  reviewQueue,
  type ReviewMode,
  asCards,
} from "./review";
type Props = { entities: Entity[]; onError: (e: unknown) => void };
const active = (entities: Entity[], kind: string) =>
  entities.filter((e) => e.kind === kind && !e.deletedAt);
const tags = (s: string) =>
  s
    .split(/[,、]/)
    .map((x) => x.trim())
    .filter(Boolean);
const confirmEdit = () =>
  window.confirm(
    "この内容の編集と保存を開始します。既存の内容への変更を許可しますか？",
  );
export function SafeMarkdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        skipHtml
        components={{
          img: ({ alt }) => (
            <span className="muted">
              [画像：{alt || "外部画像は自動読み込みしません"}]
            </span>
          ),
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}
function Field({ title, children }: { title: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{title}</span>
      {children}
    </label>
  );
}
function Classification({
  entities,
  value,
  onChange,
}: {
  entities: Entity[];
  value: { targetId?: string; subjectId?: string; unitId?: string };
  onChange: (v: {
    targetId: string;
    subjectId: string;
    unitId: string;
  }) => void;
}) {
  return (
    <div className="grid">
      <Field title="学習対象">
        <select
          value={value.targetId || ""}
          onChange={(e) =>
            onChange({ targetId: e.target.value, subjectId: "", unitId: "" })
          }
        >
          <option value="">未分類</option>
          {active(entities, "target").map((e) => (
            <option key={e.id} value={e.id}>
              {e.title}
            </option>
          ))}
        </select>
      </Field>
      <Field title="科目">
        <select
          value={value.subjectId || ""}
          onChange={(e) =>
            onChange({
              targetId: value.targetId || "",
              subjectId: e.target.value,
              unitId: "",
            })
          }
        >
          <option value="">未分類</option>
          {active(entities, "subject")
            .filter((e) => e.targetId === value.targetId)
            .map((e) => (
              <option key={e.id} value={e.id}>
                {e.title}
              </option>
            ))}
        </select>
      </Field>
      <Field title="単元">
        <select
          value={value.unitId || ""}
          onChange={(e) =>
            onChange({
              targetId: value.targetId || "",
              subjectId: value.subjectId || "",
              unitId: e.target.value,
            })
          }
        >
          <option value="">未分類</option>
          {active(entities, "unit")
            .filter((e) => e.subjectId === value.subjectId && !!value.subjectId)
            .map((e) => (
              <option key={e.id} value={e.id}>
                {e.title}
              </option>
            ))}
        </select>
      </Field>
    </div>
  );
}
const recoveryPrefix = "study-desk-note-recovery:";
function recoverableNotes(): { key: string; draft: Partial<Note> }[] {
  try {
    return Object.keys(localStorage)
      .filter((k) => k.startsWith(recoveryPrefix))
      .flatMap((key) => {
        try {
          const draft = JSON.parse(
            localStorage.getItem(key) || "null",
          ) as Partial<Note>;
          return draft?.kind === "note" &&
            typeof draft.title === "string" &&
            typeof draft.body === "string"
            ? [{ key, draft }]
            : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}
const blankNote = (): Partial<Note> => ({
  kind: "note",
  id: crypto.randomUUID(),
  title: "無題のノート",
  body: "",
  targetId: "",
  subjectId: "",
  unitId: "",
  tags: [],
  bookmark: false,
  importance: 3,
  source: "",
  verifiedOn: today(),
});
export function NotesView({ entities, onError }: Props) {
  const [query, setQuery] = useState(""),
    [selected, setSelected] = useState<string | null>(null),
    [draft, setDraft] = useState<Partial<Note> | null>(null),
    [status, setStatus] = useState(""),
    [template, setTemplate] = useState("free");
  const queue = useRef(Promise.resolve()),
    version = useRef<number | undefined>(undefined),
    failed = useRef(false),
    draftId = useRef(""),
    pending = useRef(0),
    generation = useRef(0);
  const [recoveries, setRecoveries] = useState(recoverableNotes);
  const notes = active(entities, "note") as Note[];
  const selectedNote = notes.find((n) => n.id === selected);
  const viewing = draft || selectedNote;
  const persist = (next: Partial<Note>) => {
    setDraft(next);
    setStatus("保存中…");
    const capture = { ...next },
      g = ++generation.current;
    pending.current++;
    try {
      localStorage.setItem(recoveryPrefix + next.id, JSON.stringify(capture));
    } catch (e) {
      onError(
        new Error(
          "下書きの退避に失敗しました。保存完了まで画面を閉じないでください。",
        ),
      );
    }
    queue.current = queue.current.then(async () => {
      if (failed.current) {
        pending.current--;
        return;
      }
      try {
        const saved = await saveEntity(
          {
            ...capture,
            title: capture.title?.trim() || "無題のノート",
            kind: "note",
            version: version.current,
          } as any,
          version.current,
        );
        version.current = saved.version;
        if (g === generation.current) {
          try {
            localStorage.removeItem(recoveryPrefix + capture.id);
          } catch {}
          setStatus("保存済み");
        }
      } catch (e) {
        failed.current = true;
        setStatus(
          "保存に失敗しました。本文をコピーして保管し、下書きの復元候補も確認してください。",
        );
        onError(e);
      } finally {
        pending.current--;
      }
    });
  };
  const create = async () => {
    await queue.current;
    const next = blankNote();
    version.current = undefined;
    failed.current = false;
    draftId.current = next.id!;
    setSelected(next.id!);
    persist(next);
  };
  const open = async (id: string) => {
    await queue.current;
    if (
      failed.current &&
      !window.confirm("未保存の変更があります。画面を切り替えますか？")
    )
      return;
    setDraft(null);
    setSelected(id);
    setStatus("");
  };
  const edit = () => {
    if (selectedNote && confirmEdit()) {
      version.current = selectedNote.version;
      draftId.current = selectedNote.id;
      failed.current = false;
      setDraft({ ...selectedNote });
      setStatus("編集時に自動保存");
    }
  };
  const update = (v: Partial<Note>) => {
    if (draft) persist({ ...draft, ...v });
  };
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (failed.current || pending.current > 0) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, []);
  async function makeCard(n: Partial<Note>) {
    if (!n.body?.trim()) {
      setStatus("カードを作成するには、ノートの本文を入力してください。");
      return;
    }
    try {
      await queue.current;
      await saveEntity({
        kind: "card",
        question: n.title?.trim() || "ノートの要点は？",
        answer: n.body,
        explanation: "",
        targetId: n.targetId || "",
        subjectId: n.subjectId || "",
        unitId: n.unitId || "",
        tags: n.tags || [],
        importance: n.importance || 3,
        source: n.source || "",
        noteId: n.id,
        fsrs: createEmptyCard(),
        history: [],
      } as any);
      setStatus("ノートに紐づくカードを作成しました");
    } catch (e) {
      onError(e);
    }
  }
  const applyTemplate = (type: string) => {
    setTemplate(type);
    const text: Record<string, string> = {
      summary: "# 要点\n\n## 覚えること\n\n## 具体例\n",
      comparison: "| 項目 | A | B |\n|---|---|---|\n| 適用条件 | | |\n",
      formula:
        "## 計算公式\n\n$$ 結果 = 数値 \\times 係数 $$\n\n### 使用条件\n",
      exception:
        "## 原則\n\n## 例外\n\n## 適用条件\n\n## 法的根拠・出典\n\n## ひっかけ事項\n",
      free: "",
    };
    if (!draft?.body || window.confirm("テンプレートで本文を置き換えますか？"))
      update({ body: text[type] });
  };
  return (
    <div className="stack">
      {recoveries.length > 0 && (
        <div className="panel stack">
          <h3>未保存の下書きがあります</h3>
          <p className="muted">
            既存ノートを変更せず、別のノートとして復元できます。
          </p>
          {recoveries.map((r) => (
            <div className="row" key={r.key}>
              <span>{r.draft.title}</span>
              <button
                onClick={async () => {
                  if (
                    !window.confirm(
                      "下書きを別の新規ノートとして復元しますか？",
                    )
                  )
                    return;
                  await queue.current;
                  const copy = {
                    ...r.draft,
                    id: crypto.randomUUID(),
                    title: (r.draft.title || "ノート") + "（復元）",
                    version: undefined,
                    createdAt: undefined,
                    updatedAt: undefined,
                    deletedAt: undefined,
                  };
                  version.current = undefined;
                  failed.current = false;
                  draftId.current = copy.id;
                  setSelected(copy.id);
                  persist(copy);
                  await queue.current;
                  if (!failed.current) {
                    localStorage.removeItem(r.key);
                    setRecoveries((list) =>
                      list.filter((x) => x.key !== r.key),
                    );
                  }
                }}
              >
                復元する
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="row">
        <div>
          <p className="eyebrow">YOUR KNOWLEDGE</p>
          <h2>ノート</h2>
        </div>
        <button className="primary" onClick={create}>
          <Plus size={18} />
          新規ノート
        </button>
      </div>
      <div className="panel">
        <label className="search">
          <Search size={18} />
          <input
            aria-label="ノートを検索"
            placeholder="タイトル・本文・タグを検索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      <div className="learning-layout">
        <div className="stack">
          {notes
            .filter((n) =>
              (n.title + n.body + n.tags.join(" "))
                .toLowerCase()
                .includes(query.toLowerCase()),
            )
            .sort(
              (a, b) =>
                Number(b.bookmark) - Number(a.bookmark) ||
                b.updatedAt.localeCompare(a.updatedAt),
            )
            .map((n) => (
              <button
                key={n.id}
                className={`panel note-list ${selected === n.id ? "selected" : ""}`}
                onClick={() => open(n.id)}
              >
                <span className="row">
                  <strong>{n.title}</strong>
                  {n.bookmark && <Star size={16} />}
                </span>
                <span className="muted">
                  {n.body.replace(/[#*|]/g, "").slice(0, 76) ||
                    "内容を記録しましょう"}
                </span>
                <small>
                  {n.tags.join(" · ")}　{n.updatedAt.slice(0, 10)}
                </small>
              </button>
            ))}
          {!notes.length && (
            <div className="panel empty">
              <BookOpen />
              <h3>学びを、自分の言葉で。</h3>
              <p>要点、原則と例外、公式をここにまとめましょう。</p>
            </div>
          )}
        </div>
        <div className="panel stack">
          {viewing ? (
            <>
              <div className="row">
                <span className="badge">
                  {draft ? "自動保存モード" : "ノート"}
                </span>
                <div className="row">
                  {!draft && <button onClick={edit}>編集する</button>}
                  <button onClick={() => makeCard(viewing)}>
                    カードにする
                  </button>
                  <button
                    className="danger"
                    onClick={async () => {
                      if (
                        window.confirm("このノートをゴミ箱に移動しますか？")
                      ) {
                        await queue.current;
                        try {
                          await trashEntity(viewing.id!);
                          setSelected(null);
                          setDraft(null);
                        } catch (e) {
                          onError(e);
                        }
                      }
                    }}
                  >
                    ゴミ箱
                  </button>
                </div>
              </div>
              {draft ? (
                <>
                  <Field title="タイトル">
                    <input
                      value={draft.title || ""}
                      onChange={(e) => update({ title: e.target.value })}
                    />
                  </Field>
                  <Classification
                    entities={entities}
                    value={draft}
                    onChange={update}
                  />
                  <div className="grid">
                    <Field title="種類">
                      <select
                        value={template}
                        onChange={(e) => applyTemplate(e.target.value)}
                      >
                        <option value="free">自由ノート</option>
                        <option value="summary">要点まとめ</option>
                        <option value="comparison">比較表</option>
                        <option value="formula">計算公式</option>
                        <option value="exception">原則・例外・ひっかけ</option>
                      </select>
                    </Field>
                    <Field title="タグ（カンマ区切り）">
                      <input
                        key={draft.id || "new-note-tags"}
                        defaultValue={(draft.tags || []).join(",")}
                        onBlur={(e) => update({ tags: tags(e.target.value) })}
                      />
                    </Field>
                    <Field title="重要度">
                      <select
                        value={draft.importance}
                        onChange={(e) =>
                          update({ importance: +e.target.value })
                        }
                      >
                        {[1, 2, 3, 4, 5].map((v) => (
                          <option key={v}>{v}</option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <Field title="本文 · Markdown / 数式対応">
                    <textarea
                      className="editor"
                      value={draft.body || ""}
                      onChange={(e) => update({ body: e.target.value })}
                    />
                  </Field>
                  <div className="grid">
                    <Field title="出典">
                      <input
                        value={draft.source || ""}
                        onChange={(e) => update({ source: e.target.value })}
                      />
                    </Field>
                    <Field title="確認日">
                      <input
                        type="date"
                        value={draft.verifiedOn || ""}
                        onChange={(e) => update({ verifiedOn: e.target.value })}
                      />
                    </Field>
                  </div>
                  <label className="row">
                    <input
                      type="checkbox"
                      checked={!!draft.bookmark}
                      onChange={(e) => update({ bookmark: e.target.checked })}
                    />
                    ブックマーク
                  </label>
                  <p className="muted" role="status">
                    {status}
                  </p>
                  <h3>プレビュー</h3>
                  <SafeMarkdown>
                    {draft.body || "本文を入力するとここに表示します。"}
                  </SafeMarkdown>
                </>
              ) : (
                <>
                  <h2>{selectedNote?.title}</h2>
                  <SafeMarkdown>{selectedNote?.body || ""}</SafeMarkdown>
                  <p className="muted">
                    出典：{selectedNote?.source || "未登録"} / 確認日：
                    {selectedNote?.verifiedOn || "未登録"}
                  </p>
                </>
              )}
              <div className="row">
                {asCards(entities)
                  .filter((c) => c.noteId === viewing.id)
                  .map((c) => (
                    <span className="badge" key={c.id}>
                      関連カード：{c.question.slice(0, 30)}
                    </span>
                  ))}
              </div>
              {!draft && status && <p role="status">{status}</p>}
            </>
          ) : (
            <div className="empty">
              <BookOpen />
              <p>ノートを選択して読み返す</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
const blankCard = (): Partial<Flashcard> => ({
  kind: "card",
  question: "",
  answer: "",
  explanation: "",
  targetId: "",
  subjectId: "",
  unitId: "",
  tags: [],
  importance: 3,
  source: "",
  fsrs: createEmptyCard(),
  history: [],
});
const modeLabels: Record<ReviewMode, string> = {
  due: "今日の復習",
  weak: "苦手カード",
  new: "未学習カード",
  subject: "科目別",
  important: "重要カード",
  random: "ランダム",
  cram: "試験直前",
};
export function CardsView({ entities, onError }: Props) {
  const cards = asCards(entities),
    prefs = useLiveQuery(() => db.settings.get("preferences"));
  const [mode, setMode] = useState<ReviewMode>("due"),
    [subject, setSubject] = useState(""),
    [draft, setDraft] = useState<Partial<Flashcard> | null>(null),
    [query, setQuery] = useState(""),
    [ids, setIds] = useState<string[] | null>(null),
    [index, setIndex] = useState(0),
    [reveal, setReveal] = useState(false),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState("");
  const lock = useRef(false);
  const available = reviewQueue(
    cards,
    mode,
    prefs?.dailyNewLimit ?? 20,
    subject,
  );
  const current = cards.find((c) => c.id === ids?.[index]);
  const save = async () => {
    if (!draft?.question?.trim() || !draft.answer?.trim()) {
      setStatus("問題と解答を入力してください");
      return;
    }
    try {
      await saveEntity(draft as any, draft.version);
      setDraft(null);
      setStatus("カードを保存しました");
    } catch (e) {
      onError(e);
    }
  };
  const grade = async (r: number) => {
    if (lock.current || !current) return;
    lock.current = true;
    setBusy(true);
    try {
      await reviewCard(current.id, current.version, r);
      setIndex((i) => i + 1);
      setReveal(false);
    } catch (e) {
      onError(e);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  if (ids)
    return (
      <div className="stack">
        <div className="row">
          <button onClick={() => setIds(null)}>
            <ChevronLeft size={18} />
            カード一覧
          </button>
          <span className="muted">
            {Math.min(index + 1, ids.length)} / {ids.length}枚
          </span>
        </div>
        {current ? (
          <div className="panel review-card stack">
            <span className="badge">{modeLabels[mode]}</span>
            <h2>{current.question}</h2>
            {reveal ? (
              <>
                <SafeMarkdown>{current.answer}</SafeMarkdown>
                {current.explanation && (
                  <div className="callout">
                    <SafeMarkdown>{current.explanation}</SafeMarkdown>
                  </div>
                )}
                <p className="muted">出典：{current.source || "未登録"}</p>
                <div className="rating-grid">
                  {["忘れた", "難しい", "普通", "簡単"].map((s, i) => (
                    <button
                      key={s}
                      disabled={busy}
                      onClick={() => grade(i + 1)}
                      className={i === 2 ? "primary" : ""}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <button className="primary" onClick={() => setReveal(true)}>
                解答を見る
              </button>
            )}
            <small className="muted">
              復習回数 {current.history.length} · 誤答 {current.fsrs.lapses}回
            </small>
          </div>
        ) : (
          <div className="panel empty">
            <Check size={36} />
            <h2>今回の復習が終わりました</h2>
            <p>続ける場合は、もう一度復習を始めてください。</p>
            <button className="primary" onClick={() => setIds(null)}>
              一覧に戻る
            </button>
          </div>
        )}
      </div>
    );
  return (
    <div className="stack">
      <div className="row">
        <div>
          <p className="eyebrow">SPACED REPETITION</p>
          <h2>覚える、思い出す。</h2>
        </div>
        <button
          className="primary"
          onClick={() => {
            setDraft(blankCard());
            setStatus("");
          }}
        >
          <Plus size={18} />
          カード作成
        </button>
      </div>
      <div className="panel stack">
        <div className="row">
          <div>
            <h3>今日の積み重ね</h3>
            <p className="muted">FSRSで、忘れかける頃にもう一度。</p>
          </div>
          <Brain size={30} />
        </div>
        <div className="grid">
          <Field title="出題モード">
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as ReviewMode)}
            >
              {Object.entries(modeLabels).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          {mode === "subject" && (
            <Field title="科目">
              <select
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              >
                <option value="">科目を選択</option>
                {active(entities, "subject").map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        <div className="row">
          <span>
            <strong>{available.length}</strong>枚のカード · 新規は1日{" "}
            {prefs?.dailyNewLimit ?? 20}枚まで
          </span>
          <button
            className="primary"
            disabled={!available.length}
            onClick={() => {
              setIds(available.map((c) => c.id));
              setIndex(0);
              setReveal(false);
            }}
          >
            復習を始める
          </button>
        </div>
      </div>
      {draft && (
        <div className="panel stack">
          <div className="row">
            <h3>{draft.id ? "カード編集" : "新しいカード"}</h3>
            <button onClick={() => setDraft(null)}>閉じる</button>
          </div>
          <Classification
            entities={entities}
            value={draft}
            onChange={(v) => setDraft({ ...draft, ...v })}
          />
          <Field title="問題">
            <textarea
              value={draft.question || ""}
              onChange={(e) => setDraft({ ...draft, question: e.target.value })}
            />
          </Field>
          <Field title="解答 · Markdown対応">
            <textarea
              value={draft.answer || ""}
              onChange={(e) => setDraft({ ...draft, answer: e.target.value })}
            />
          </Field>
          <Field title="補足解説">
            <textarea
              value={draft.explanation || ""}
              onChange={(e) =>
                setDraft({ ...draft, explanation: e.target.value })
              }
            />
          </Field>
          <div className="grid">
            <Field title="タグ">
              <input
                key={draft.id || "new-card-tags"}
                defaultValue={(draft.tags || []).join(",")}
                onBlur={(e) =>
                  setDraft({ ...draft, tags: tags(e.target.value) })
                }
              />
            </Field>
            <Field title="重要度">
              <select
                value={draft.importance}
                onChange={(e) =>
                  setDraft({ ...draft, importance: +e.target.value })
                }
              >
                {[1, 2, 3, 4, 5].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </Field>
            <Field title="出典">
              <input
                value={draft.source || ""}
                onChange={(e) => setDraft({ ...draft, source: e.target.value })}
              />
            </Field>
          </div>
          <button className="primary" onClick={save}>
            カードを保存
          </button>
        </div>
      )}
      <p role="status" className="muted">
        {status}
      </p>
      <label className="search">
        <Search size={18} />
        <input
          aria-label="カードを検索"
          placeholder="問題・解答・タグを検索"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="stack">
        {cards
          .filter((c) =>
            (c.question + c.answer + c.tags.join(" "))
              .toLowerCase()
              .includes(query.toLowerCase()),
          )
          .map((c) => (
            <div className="panel stack" key={c.id}>
              <div className="row">
                <strong>{c.question}</strong>
                <span className="badge">重要度 {c.importance}</span>
              </div>
              <p className="muted">
                次回 {new Date(c.fsrs.due).toLocaleString("ja-JP")} · 復習{" "}
                {c.history.length}回
              </p>
              <details>
                <summary>復習履歴（{c.history.length}回）</summary>
                {c.history
                  .slice()
                  .reverse()
                  .slice(0, 30)
                  .map((h, i) => (
                    <p key={i} className="muted">
                      {new Date(h.at).toLocaleString("ja-JP")} ·{" "}
                      {["", "忘れた", "難しい", "普通", "簡単"][h.rating]}
                    </p>
                  ))}
                {c.history.length > 30 && (
                  <small>
                    直近30回を表示。全履歴はバックアップに保存されます。
                  </small>
                )}
              </details>
              <div className="row">
                <button
                  onClick={() => {
                    if (confirmEdit()) {
                      setDraft({ ...c });
                      setStatus("");
                    }
                  }}
                >
                  編集
                </button>
                <button
                  className="danger"
                  onClick={async () => {
                    if (window.confirm("カードをゴミ箱に移動しますか？"))
                      try {
                        await trashEntity(c.id);
                      } catch (e) {
                        onError(e);
                      }
                  }}
                >
                  ゴミ箱
                </button>
              </div>
            </div>
          ))}
        {!cards.length && (
          <div className="panel empty">
            <Brain />
            <h3>最初の1枚から始めましょう</h3>
            <p>手動作成のほか、設定のChatGPT連携から一括取り込みできます。</p>
          </div>
        )}
      </div>
    </div>
  );
}
const blankQuestion = (): Partial<Question> => ({
  kind: "question",
  question: "",
  answer: "○",
  explanation: "",
  source: "",
  choices: ["○", "×"],
  cause: "知識不足",
  wrongCount: 0,
  targetId: "",
  subjectId: "",
  unitId: "",
});
export function PracticeView({ entities, onError }: Props) {
  const questions = active(entities, "question") as Question[],
    attempts = active(entities, "attempt") as Attempt[];
  const [draft, setDraft] = useState<Partial<Question> | null>(null),
    [record, setRecord] = useState({
      targetId: "",
      subjectId: "",
      unitId: "",
      total: 10,
      correct: 0,
      cause: "知識不足",
    }),
    [status, setStatus] = useState(""),
    [quiz, setQuiz] = useState<string[] | null>(null),
    [qi, setQi] = useState(0),
    [response, setResponse] = useState<string | null>(null);
  const lock = useRef(false);
  const total = attempts.reduce((s, a) => s + a.total, 0),
    correct = attempts.reduce((s, a) => s + a.correct, 0),
    current = questions.find((q) => q.id === quiz?.[qi]);
  const addRecord = async () => {
    if (
      !Number.isInteger(record.total) ||
      !Number.isInteger(record.correct) ||
      record.total < 1 ||
      record.correct < 0 ||
      record.correct > record.total
    ) {
      setStatus("問題数は1以上、正解数は0〜問題数の整数で入力してください");
      return;
    }
    try {
      await saveEntity({ kind: "attempt", ...record, date: today() } as any);
      setStatus("演習結果を保存しました");
    } catch (e) {
      onError(e);
    }
  };
  const saveQuestion = async () => {
    if (
      !draft?.question?.trim() ||
      !draft.answer?.trim() ||
      (draft.choices || []).filter((c) => c.trim()).length < 2 ||
      new Set(draft.choices).size !== draft.choices?.length ||
      !(draft.choices || []).includes(draft.answer)
    ) {
      setStatus(
        "問題・解答・2つ以上の選択肢を入力し、解答を選択肢と一致させてください",
      );
      return;
    }
    try {
      await saveEntity(
        { ...draft, choices: draft.choices?.filter((c) => c.trim()) } as any,
        draft.version,
      );
      setDraft(null);
      setStatus("問題を保存しました");
    } catch (e) {
      onError(e);
    }
  };
  const answer = async (choice: string) => {
    if (!current || response !== null || lock.current) return;
    lock.current = true;
    try {
      await db.transaction("rw", [db.records, db.outbox], async () => {
        const q = (await db.records.get(current.id)) as Question;
        if (q.version !== current.version || q.deletedAt)
          throw new Error("問題が更新されました。再度開いてください。");
        await saveEntity({
          kind: "attempt",
          questionId: q.id,
          targetId: q.targetId || "",
          subjectId: q.subjectId || "",
          unitId: q.unitId || "",
          total: 1,
          correct: Number(choice === q.answer),
          cause: choice === q.answer ? "" : q.cause,
          date: today(),
        } as any);
        if (choice !== q.answer)
          await saveEntity({ ...q, wrongCount: q.wrongCount + 1 }, q.version);
      });
      setResponse(choice);
    } catch (e) {
      onError(e);
    } finally {
      lock.current = false;
    }
  };
  const toCard = async (q: Question) => {
    try {
      const existing = asCards(entities).find(
        (c) => c.question === q.question && c.answer === q.answer,
      );
      if (existing) {
        setStatus("同じ問題・解答のカードが既にあります");
        return;
      }
      await saveEntity({
        ...blankCard(),
        question: q.question,
        answer: q.answer,
        explanation: q.explanation,
        source: q.source,
        targetId: q.targetId || "",
        subjectId: q.subjectId || "",
        unitId: q.unitId || "",
        tags: ["誤答問題"],
      } as any);
      setStatus("暗記カードに変換しました");
    } catch (e) {
      onError(e);
    }
  };
  if (quiz)
    return (
      <div className="stack">
        <div className="row">
          <button onClick={() => setQuiz(null)}>演習一覧に戻る</button>
          <span>
            {Math.min(qi + 1, quiz.length)} / {quiz.length}問
          </span>
        </div>
        {current ? (
          <div className="panel stack">
            <h2>{current.question}</h2>
            {current.choices.map((c, i) => (
              <button
                key={`${i}-${c}`}
                disabled={response !== null}
                onClick={() => answer(c)}
              >
                {c}
              </button>
            ))}
            {response !== null && (
              <>
                <h3>
                  {response === current.answer
                    ? "正解です"
                    : "もう一度確認しましょう"}
                </h3>
                <p>正解：{current.answer}</p>
                <SafeMarkdown>{current.explanation}</SafeMarkdown>
                <button
                  className="primary"
                  onClick={() => {
                    setQi((i) => i + 1);
                    setResponse(null);
                  }}
                >
                  {qi + 1 === quiz.length ? "小テストを完了" : "次の問題"}
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="panel empty">
            <Check />
            <h2>小テスト完了</h2>
            <button className="primary" onClick={() => setQuiz(null)}>
              結果を見る
            </button>
          </div>
        )}
      </div>
    );
  return (
    <div className="stack">
      <div className="row">
        <div>
          <p className="eyebrow">PRACTICE & INSIGHTS</p>
          <h2>弱点と向き合う</h2>
        </div>
        <button className="primary" onClick={() => setDraft(blankQuestion())}>
          <Plus size={18} />
          問題を登録
        </button>
      </div>
      <div className="grid">
        <div className="panel stat">
          <span>解いた問題</span>
          <strong>
            {total}
            <small>問</small>
          </strong>
        </div>
        <div className="panel stat">
          <span>正答率</span>
          <strong>
            {total ? Math.round((correct / total) * 100) : "—"}
            <small>%</small>
          </strong>
        </div>
      </div>
      <div className="panel stack">
        <h3>科目別の正答率</h3>
        {active(entities, "subject").map((s) => {
          const list = attempts.filter((a) => a.subjectId === s.id),
            n = list.reduce((v, a) => v + a.total, 0),
            c = list.reduce((v, a) => v + a.correct, 0);
          return (
            <div className="row" key={s.id}>
              <span>{s.title}</span>
              <strong>
                {n ? Math.round((c / n) * 100) + "%" : "未記録"}{" "}
                <small className="muted">{n}問</small>
              </strong>
            </div>
          );
        })}
        <p className="muted">
          演習の正答率と暗記カードの復習状態は別々に記録されます。学習時間から合格率は推定しません。
        </p>
      </div>
      <div className="panel stack">
        <h3>参考書・問題集の演習記録</h3>
        <Classification
          entities={entities}
          value={record}
          onChange={(v) => setRecord({ ...record, ...v })}
        />
        <div className="grid">
          <Field title="問題数">
            <input
              type="number"
              min="1"
              value={record.total}
              onChange={(e) => setRecord({ ...record, total: +e.target.value })}
            />
          </Field>
          <Field title="正解数">
            <input
              type="number"
              min="0"
              max={record.total}
              value={record.correct}
              onChange={(e) =>
                setRecord({ ...record, correct: +e.target.value })
              }
            />
          </Field>
          <Field title="主な誤答原因">
            <select
              value={record.cause}
              onChange={(e) => setRecord({ ...record, cause: e.target.value })}
            >
              {[
                "知識不足",
                "読み違い",
                "計算ミス",
                "原則と例外の混同",
                "時間不足",
                "その他",
              ].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
        </div>
        <button className="primary" onClick={addRecord}>
          演習結果を記録
        </button>
      </div>
      {draft && (
        <div className="panel stack">
          <div className="row">
            <h3>{draft.id ? "問題編集" : "問題を登録"}</h3>
            <button onClick={() => setDraft(null)}>閉じる</button>
          </div>
          <Classification
            entities={entities}
            value={draft}
            onChange={(v) => setDraft({ ...draft, ...v })}
          />
          <Field title="問題文">
            <textarea
              value={draft.question || ""}
              onChange={(e) => setDraft({ ...draft, question: e.target.value })}
            />
          </Field>
          <Field title="選択肢（1行に1つ。○×問題は○と×）">
            <textarea
              value={draft.choices?.join("\n") || ""}
              onChange={(e) =>
                setDraft({ ...draft, choices: e.target.value.split("\n") })
              }
            />
          </Field>
          <Field title="正解（選択肢と同じ表記）">
            <input
              value={draft.answer || ""}
              onChange={(e) => setDraft({ ...draft, answer: e.target.value })}
            />
          </Field>
          <Field title="解説">
            <textarea
              value={draft.explanation || ""}
              onChange={(e) =>
                setDraft({ ...draft, explanation: e.target.value })
              }
            />
          </Field>
          <Field title="出典">
            <input
              value={draft.source || ""}
              onChange={(e) => setDraft({ ...draft, source: e.target.value })}
            />
          </Field>
          <Field title="誤答原因">
            <select
              value={draft.cause}
              onChange={(e) => setDraft({ ...draft, cause: e.target.value })}
            >
              {[
                "知識不足",
                "読み違い",
                "計算ミス",
                "原則と例外の混同",
                "時間不足",
                "その他",
              ].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <button className="primary" onClick={saveQuestion}>
            問題を保存
          </button>
        </div>
      )}
      <div className="row">
        <h3>問題一覧</h3>
        <button
          disabled={!questions.length}
          onClick={() => {
            setQuiz(questions.map((q) => q.id));
            setQi(0);
            setResponse(null);
          }}
        >
          小テストを始める
        </button>
      </div>
      <p role="status">{status}</p>
      {questions.map((q) => (
        <div className="panel stack" key={q.id}>
          <div className="row">
            <strong>{q.question}</strong>
            <span className="badge">誤答 {q.wrongCount}回</span>
          </div>
          <p className="muted">
            {q.cause} · {q.source || "出典未登録"}
          </p>
          <div className="row">
            <button onClick={() => toCard(q)}>カードに変換</button>
            <button
              onClick={() => {
                if (confirmEdit()) setDraft({ ...q });
              }}
            >
              編集
            </button>
            <button
              className="danger"
              onClick={async () => {
                if (window.confirm("この問題をゴミ箱に移動しますか？"))
                  try {
                    await trashEntity(q.id);
                  } catch (e) {
                    onError(e);
                  }
              }}
            >
              ゴミ箱
            </button>
          </div>
        </div>
      ))}
      {!questions.length && (
        <div className="panel empty">
          <RotateCcw />
          <p>間違えた問題を保存すると、ここで小テストを作れます。</p>
        </div>
      )}
    </div>
  );
}
