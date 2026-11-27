import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  BookOpen,
  Home,
  Timer,
  CalendarDays,
  Layers,
  Settings,
  Plus,
  Play,
  Pause,
  Square,
  BarChart3,
  Check,
  GraduationCap,
  ArrowUpRight,
  ShieldCheck,
  ChevronRight,
  Trash2,
  Pencil,
  Download,
  WifiOff,
} from "lucide-react";
import {
  db,
  saveEntity,
  trashEntity,
  getPreferences,
  setPreferences,
} from "./db";
import {
  startTimer,
  pauseTimer,
  resumeTimer,
  finishTimer,
  elapsedMs,
  splitByDay,
} from "./timer";
import { generatePlan, applyPlan, type PlanPreview } from "./planner";
import { NotesView, CardsView, PracticeView } from "./Learning";
import { SettingsView } from "./Settings";
import { installReconnectSync } from "./sync";
import {
  defaultPreferences,
  today,
  localDate,
  type Entity,
  type Target,
  type Subject,
  type Unit,
  type Session,
  type Task,
  type Preferences,
  type TimerState,
  type Flashcard,
} from "./models";
import { sessionsToCSV } from "./exchange";
const fmt = (m: number) => {
  const n = Math.round(m);
  return n >= 60 ? `${Math.floor(n / 60)}時間${n % 60}分` : `${n}分`;
};
const titleOf = (es: Entity[], id?: string) =>
  es.find((e) => e.id === id)?.title || "未分類";
const run = (fn: () => Promise<unknown>, err: (e: unknown) => void) =>
  void fn().catch(err);
function Button({
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props}>{children}</button>;
}
export function Scope({
  entities,
  value,
  onChange,
  required = false,
}: {
  entities: Entity[];
  value: { targetId?: string; subjectId?: string; unitId?: string };
  onChange: (v: {
    targetId: string;
    subjectId: string;
    unitId: string;
  }) => void;
  required?: boolean;
}) {
  return (
    <div className="scope grid three">
      <label className="field">
        学習対象
        <select
          required={required}
          value={value.targetId || ""}
          onChange={(e) =>
            onChange({ targetId: e.target.value, subjectId: "", unitId: "" })
          }
        >
          <option value="">選択してください</option>
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
          value={value.subjectId || ""}
          onChange={(e) =>
            onChange({
              targetId: value.targetId || "",
              subjectId: e.target.value,
              unitId: "",
            })
          }
        >
          <option value="">指定なし</option>
          {entities
            .filter(
              (e) => e.kind === "subject" && e.targetId === value.targetId,
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
          value={value.unitId || ""}
          onChange={(e) =>
            onChange({
              targetId: value.targetId || "",
              subjectId: value.subjectId || "",
              unitId: e.target.value,
            })
          }
        >
          <option value="">指定なし</option>
          {entities
            .filter(
              (e) =>
                e.kind === "unit" &&
                e.subjectId === value.subjectId &&
                value.subjectId,
            )
            .map((e) => (
              <option key={e.id} value={e.id}>
                {e.title}
              </option>
            ))}
        </select>
      </label>
    </div>
  );
}
export default function App() {
  const entities = useLiveQuery(() => db.records.toArray(), []) || [];
  const active = entities.filter((e) => !e.deletedAt);
  const prefs = useLiveQuery(() => getPreferences(), []) || defaultPreferences;
  const timer = useLiveQuery(() => db.timers.get("active"), []);
  const [page, setPage] = useState("ホーム"),
    [settings, setSettings] = useState(false),
    [error, setError] = useState(""),
    [online, setOnline] = useState(navigator.onLine);
  const onError = (e: unknown) =>
    setError(e instanceof Error ? e.message : String(e));
  useEffect(() => {
    document.documentElement.dataset.theme = prefs.theme;
  }, [prefs.theme]);
  useEffect(() => {
    const f = () => setOnline(navigator.onLine);
    addEventListener("online", f);
    addEventListener("offline", f);
    const stop = installReconnectSync();
    return () => {
      removeEventListener("online", f);
      removeEventListener("offline", f);
      if (typeof stop === "function") stop();
    };
  }, []);
  const menu = [
    ["ホーム", Home],
    ["計測", Timer],
    ["計画", CalendarDays],
    ["ノート", BookOpen],
    ["暗記", Layers],
  ] as const;
  return (
    <div className="app">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage("ホーム");
          }}
        >
          <span className="brand-icon">
            <BookOpen size={22} />
          </span>
          <span>
            Study Desk<small>自分のための学習室</small>
          </span>
        </a>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {menu.map(([name, Icon]) => (
            <button
              key={name}
              className={
                page === name && !settings ? "nav-item selected" : "nav-item"
              }
              onClick={() => {
                setPage(name);
                setSettings(false);
              }}
            >
              <Icon size={20} />
              {name}
              {name === "計測" && timer && <span className="running-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <ShieldCheck size={18} />
          <span>
            学びは、あなたの手元に。<small>端末内に保存 · オフライン対応</small>
          </span>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span className="breadcrumb">
            マイワークスペース <ChevronRight size={14} />{" "}
            {settings ? "設定" : page}
          </span>
          <div className="row">
            <span className="local-label">
              {online ? (
                <>
                  <span className="dot" />
                  端末内で保存
                </>
              ) : (
                <>
                  <WifiOff size={14} />
                  オフライン
                </>
              )}
            </span>
            <button
              className="icon-button"
              aria-label="設定"
              onClick={() => setSettings(!settings)}
            >
              <Settings size={20} />
            </button>
            <span className="avatar">K</span>
          </div>
        </header>
        <main>
          {error && (
            <div className="error" role="alert">
              {error}
              <button onClick={() => setError("")}>閉じる</button>
            </div>
          )}
          {settings ? (
            <SettingsView
              entities={entities}
              onError={onError}
              onClose={() => setSettings(false)}
            />
          ) : page === "ホーム" ? (
            <Dashboard
              entities={active}
              onPage={setPage}
              prefs={prefs}
              onError={onError}
            />
          ) : page === "計測" ? (
            <TimerView
              entities={active}
              timer={timer}
              prefs={prefs}
              onError={onError}
            />
          ) : page === "計画" ? (
            <PlanView entities={active} prefs={prefs} onError={onError} />
          ) : page === "ノート" ? (
            <NotesView entities={active} onError={onError} />
          ) : (
            <CardsView entities={active} onError={onError} />
          )}
        </main>
        <footer className="footer">
          <BookOpen size={14} /> Study Desk{" "}
          <span>小さな積み重ねを、大きな力に。</span>
        </footer>
      </div>
      <nav className="mobile-nav">
        {menu.map(([name, Icon]) => (
          <button
            key={name}
            className={page === name && !settings ? "selected" : ""}
            onClick={() => {
              setPage(name);
              setSettings(false);
            }}
          >
            <Icon size={21} />
            <span>{name}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
function Dashboard({
  entities,
  prefs,
  onPage,
  onError,
}: {
  entities: Entity[];
  prefs: Preferences;
  onPage: (s: string) => void;
  onError: (e: unknown) => void;
}) {
  const [tab, setTab] = useState("概要"),
    [period, setPeriod] = useState(7);
  const sessions = entities.filter((e) => e.kind === "session") as Session[];
  const days: Record<string, number> = {};
  for (const s of sessions)
    for (const [d, m] of Object.entries(splitByDay(s.segments)))
      days[d] = (days[d] || 0) + m;
  const now = new Date(),
    week = new Date(now);
  week.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const weekStart = localDate(week),
    monthStart = today().slice(0, 7);
  const total = sessions.reduce((n, s) => n + s.minutes, 0),
    weekTotal = Object.entries(days)
      .filter(([d]) => d >= weekStart)
      .reduce((n, [, m]) => n + m, 0),
    monthTotal = Object.entries(days)
      .filter(([d]) => d.startsWith(monthStart))
      .reduce((n, [, m]) => n + m, 0);
  const targets = entities.filter((e) => e.kind === "target") as Target[],
    tasks = entities.filter(
      (e) => e.kind === "task" && e.date === today(),
    ) as Task[],
    due = entities.filter(
      (e) =>
        e.kind === "card" &&
        new Date((e as Flashcard).fsrs.due).getTime() <= Date.now(),
    ).length;
  const chart = Array.from({ length: period }, (_, i) => {
    const d = new Date(now);
    d.setDate(d.getDate() - (period - 1 - i));
    return {
      date: localDate(d),
      minutes: days[localDate(d)] || 0,
      label: `${d.getMonth() + 1}/${d.getDate()}`,
    };
  });
  const max = Math.max(60, ...chart.map((d) => d.minutes));
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR LEARNING, AT A GLANCE</p>
          <h1>今日も、一歩ずつ。</h1>
          <p className="muted">
            {new Intl.DateTimeFormat("ja-JP", {
              month: "long",
              day: "numeric",
              weekday: "long",
            }).format(now)}{" "}
            <span className="heading-divider">|</span>{" "}
            自分のペースで、学びを積み重ねよう。
          </p>
        </div>
        <button className="primary" onClick={() => onPage("計測")}>
          <Play size={17} fill="currentColor" />
          学習をはじめる
        </button>
      </div>
      <div className="tabs">
        <button
          className={tab === "概要" ? "active" : ""}
          onClick={() => setTab("概要")}
        >
          概要
        </button>
        <button
          className={tab === "分析・演習" ? "active" : ""}
          onClick={() => setTab("分析・演習")}
        >
          <BarChart3 size={16} />
          分析・演習
        </button>
      </div>
      {tab === "分析・演習" ? (
        <PracticeView entities={entities} onError={onError} />
      ) : (
        <>
          <div className="metrics">
            {[
              ["今日の学習", days[today()] || 0, "今日の積み重ね", Timer],
              ["今週の学習", weekTotal, "月曜日からの合計", CalendarDays],
              ["今月の学習", monthTotal, "今月の積み重ね", BarChart3],
              ["累計学習時間", total, "すべての学習記録", GraduationCap],
            ].map(([label, value, caption, Icon]) => {
              const I = Icon as typeof Timer;
              return (
                <section className="metric" key={String(label)}>
                  <div className="metric-label">
                    {String(label)}
                    <I size={18} />
                  </div>
                  <strong>
                    {Math.floor(Math.round(Number(value)) / 60)}
                    <small>時間</small>
                    {Math.round(Number(value)) % 60}
                    <small>分</small>
                  </strong>
                  <span className="muted">{String(caption)}</span>
                </section>
              );
            })}
          </div>
          <div className="dashboard-grid">
            <section className="panel chart-panel">
              <div className="section-heading">
                <div>
                  <h2>学習のリズム</h2>
                  <p className="muted">毎日の学習時間の推移</p>
                </div>
                <select
                  aria-label="グラフ表示期間"
                  value={period}
                  onChange={(e) => setPeriod(+e.target.value)}
                >
                  <option value={7}>過去7日間</option>
                  <option value={30}>過去30日間</option>
                </select>
              </div>
              <div
                className="chart"
                role="img"
                aria-label={chart
                  .map((d) => `${d.date} ${fmt(d.minutes)}`)
                  .join("、")}
              >
                <div className="chart-labels">
                  <span>{Math.ceil(max / 60)}h</span>
                  <span>{Number((max / 120).toFixed(1))}h</span>
                  <span>0</span>
                </div>
                <div className="plot">
                  <div className="gridline top" />
                  <div className="gridline middle" />
                  <div className="gridline bottom" />
                  <div className="bars">
                    {chart.map((d) => (
                      <div className="bar-col" key={d.date}>
                        <div
                          className={
                            "bar " + (d.date === today() ? "current" : "")
                          }
                          style={{
                            height: `${Math.max(1, (d.minutes / max) * 100)}%`,
                          }}
                          title={`${d.date} ${fmt(d.minutes)}`}
                        />
                        <span>
                          {period === 7 ||
                          d.date.endsWith("01") ||
                          d.date === today()
                            ? d.label
                            : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="chart-legend">
                <span className="square" /> 学習時間
                <span className="muted">
                  記録を重ねると、学習の傾向が見えてきます
                </span>
              </div>
            </section>
            <section className="panel target-panel">
              <div className="section-heading">
                <h2>学習中の目標</h2>
                <button
                  className="icon-button"
                  aria-label="学習対象を追加"
                  onClick={() => onPage("計画")}
                >
                  <Plus size={19} />
                </button>
              </div>
              {targets.length ? (
                targets.map((t) => {
                  const studied = sessions
                      .filter((s) => s.targetId === t.id)
                      .reduce((n, s) => n + s.minutes, 0),
                    rate = t.goalMinutes
                      ? Math.min(100, (studied / t.goalMinutes) * 100)
                      : 0;
                  const remaining = t.examDate
                    ? Math.ceil(
                        (new Date(t.examDate + "T00:00:00").getTime() -
                          new Date(today() + "T00:00:00").getTime()) /
                          86400000,
                      )
                    : null;
                  return (
                    <div className="target-card" key={t.id}>
                      <div className="row spread">
                        <span className="target-symbol">
                          <GraduationCap size={20} />
                        </span>
                        <span className="badge">
                          {remaining === null
                            ? "日程未設定"
                            : remaining < 0
                              ? "試験日経過"
                              : `あと ${remaining} 日`}
                        </span>
                      </div>
                      <h3>{t.title}</h3>
                      <div className="row spread muted">
                        <span>{t.examDate || "自分のペースで学習"}</span>
                        <span>{Math.round(rate)}%</span>
                      </div>
                      <progress value={rate} max="100" />
                      <small className="muted">
                        {fmt(studied)} / 目標 {fmt(t.goalMinutes)}
                      </small>
                    </div>
                  );
                })
              ) : (
                <div className="empty compact">
                  <GraduationCap size={34} />
                  <h3>最初の目標を決めよう</h3>
                  <p>
                    資格、大学の試験、英語など。
                    <br />
                    学びたいことを登録できます。
                  </p>
                  <button className="secondary" onClick={() => onPage("計画")}>
                    <Plus size={16} />
                    学習対象を登録
                  </button>
                </div>
              )}
            </section>
            <section className="panel">
              <div className="section-heading">
                <div>
                  <h2>
                    今日の学習タスク{" "}
                    <span className="count">{tasks.length}</span>
                  </h2>
                  <p className="muted">今日取り組むことを、ひとつずつ。</p>
                </div>
                <button className="text-button" onClick={() => onPage("計画")}>
                  計画を見る
                  <ChevronRight size={16} />
                </button>
              </div>
              {tasks.length ? (
                tasks.map((t) => (
                  <label className="task-row" key={t.id}>
                    <input
                      type="checkbox"
                      checked={t.completed}
                      onChange={() => {
                        if (confirm("タスクの完了状態を変更しますか？"))
                          run(
                            () =>
                              saveEntity(
                                { ...t, completed: !t.completed },
                                t.version,
                              ),
                            onError,
                          );
                      }}
                    />
                    <span className={t.completed ? "completed" : ""}>
                      {titleOf(entities, t.subjectId)}
                      <small className="muted">
                        {t.review ? "復習" : "学習"} ·{" "}
                        {titleOf(entities, t.targetId)}
                      </small>
                    </span>
                    <span className="badge">{fmt(t.minutes)}</span>
                  </label>
                ))
              ) : (
                <div className="empty horizontal">
                  <CalendarDays size={30} />
                  <div>
                    <h3>今日は、まだタスクがありません</h3>
                    <p>
                      試験日と学習可能時間から、無理のない計画を作成できます。
                    </p>
                  </div>
                  <button className="secondary" onClick={() => onPage("計画")}>
                    計画を作る
                  </button>
                </div>
              )}
            </section>
            <section className="review-banner">
              <span className="review-icon">
                <Layers size={26} />
              </span>
              <div>
                <span className="eyebrow">SPACED REPETITION</span>
                <h2>復習で、記憶を確かに。</h2>
                <p>
                  今日の復習カード <strong>{due}</strong> 枚
                </p>
              </div>
              <button onClick={() => onPage("暗記")} className="secondary">
                復習する
                <ChevronRight size={16} />
              </button>
            </section>
          </div>
          <section className="panel distribution">
            <div className="section-heading">
              <h2>科目別の学習時間</h2>
              <span className="muted">時間と習熟度は別の指標です</span>
            </div>
            {sessions.length ? (
              Array.from(new Set(sessions.map((s) => s.subjectId))).map(
                (id) => {
                  const m = sessions
                    .filter((s) => s.subjectId === id)
                    .reduce((n, s) => n + s.minutes, 0);
                  return (
                    <div className="distribution-row" key={id}>
                      <span>{titleOf(entities, id)}</span>
                      <progress value={m} max={total || 1} />
                      <strong>{fmt(m)}</strong>
                    </div>
                  );
                },
              )
            ) : (
              <p className="muted">
                学習を記録すると、ここに科目ごとの配分が表示されます。
              </p>
            )}
          </section>
        </>
      )}
    </>
  );
}
function TimerView({
  entities,
  timer,
  prefs,
  onError,
}: {
  entities: Entity[];
  timer?: TimerState;
  prefs: Preferences;
  onError: (e: unknown) => void;
}) {
  const [config, setConfig] = useState<Partial<TimerState>>({
    targetId: "",
    subjectId: "",
    unitId: "",
    method: "テキスト",
    mode: "stopwatch",
    durationMinutes: 25,
    focusMinutes: 25,
    breakMinutes: 5,
    ...prefs.lastTimer,
  });
  const manualForm = useRef<HTMLFormElement>(null);
  const manualLock = useRef(false);
  const [manualSaving, setManualSaving] = useState(false);
  const [tick, setTick] = useState(Date.now()),
    [editing, setEditing] = useState<Session | null>(null),
    [manual, setManual] = useState(false),
    [date, setDate] = useState(today() + "T12:00"),
    [minutes, setMinutes] = useState(30),
    [memo, setMemo] = useState(""),
    [filter, setFilter] = useState("");
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (manual) {
      manualForm.current?.focus({ preventScroll: true });
      manualForm.current?.scrollIntoView({ block: "start" });
    }
  }, [manual, editing]);
  const elapsed = timer ? elapsedMs(timer, tick) / 1000 : 0,
    limit =
      (timer?.mode === "pomodoro"
        ? timer.phase === "break"
          ? timer.breakMinutes
          : timer.focusMinutes
        : timer?.durationMinutes || 25) * 60,
    display =
      timer?.mode === "stopwatch" ? elapsed : Math.max(0, limit - elapsed),
    seconds = Math.floor(
      timer
        ? display
        : config.mode === "stopwatch"
          ? 0
          : (config.durationMinutes || 25) * 60,
    );
  const finish = async () => {
    if (!timer) return;
    const long = elapsed > 4 * 3600;
    if (
      !confirm(
        long
          ? "4時間以上の計測です。停止忘れがないか確認してください。この時間を保存しますか？"
          : "計測を終了して保存しますか？",
      )
    )
      return;
    await finishTimer(timer.token);
  };
  const submitManual = async (e: React.FormEvent) => {
    e.preventDefault();
    if (manualLock.current) return;
    manualLock.current = true;
    setManualSaving(true);
    try {
      if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440)
        throw new Error("学習時間は1〜1440分で入力してください");
      if (editing && !confirm("この学習記録の内容を更新しますか？")) return;
      const start = new Date(date).getTime();
      if (!Number.isFinite(start)) throw new Error("日時を確認してください");
      const originalStart = editing?.segments[0]?.start;
      const sameTime =
        editing &&
        Math.floor(start / 60000) ===
          Math.floor((originalStart || 0) / 60000) &&
        minutes === editing.minutes;
      if (
        editing &&
        !sameTime &&
        !confirm(
          "開始日時・時間の変更により、一時停止を含む区間を連続した学習時間に置き換えます。反映しますか？",
        )
      )
        return;
      await saveEntity(
        {
          ...editing,
          kind: "session",
          targetId: config.targetId || "",
          subjectId: config.subjectId || "",
          unitId: config.unitId || "",
          method: config.method || "テキスト",
          segments: sameTime
            ? editing.segments
            : [{ start, end: start + minutes * 60000 }],
          minutes,
          memo,
        },
        editing?.version,
      );
      setManual(false);
      setEditing(null);
    } finally {
      manualLock.current = false;
      setManualSaving(false);
    }
  };
  const sessions = (entities.filter((e) => e.kind === "session") as Session[])
    .filter((s) => !filter || s.targetId === filter)
    .sort((a, b) => (b.segments[0]?.start || 0) - (a.segments[0]?.start || 0));
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">MAKE TIME FOR YOURSELF</p>
          <h1>学習を記録する</h1>
          <p className="muted">集中した時間を、確かな積み重ねに。</p>
        </div>
        <button
          className="secondary"
          type="button"
          aria-expanded={manual}
          aria-controls="manual-entry"
          disabled={manualSaving}
          onClick={() => {
            setManual(!manual);
            setEditing(null);
            setDate(today() + "T12:00");
            setMinutes(30);
            setMemo("");
          }}
        >
          <Plus size={17} />
          手動で記録
        </button>
      </div>
      {manual && (
        <form
          className="panel stack"
          id="manual-entry"
          style={{ scrollMarginTop: 96 }}
          aria-labelledby="manual-entry-title"
          ref={manualForm}
          tabIndex={-1}
          onSubmit={(e) => run(() => submitManual(e), onError)}
        >
          <h2 id="manual-entry-title">
            {editing ? "学習記録の編集" : "学習時間を追加"}
          </h2>
          <Scope
            entities={entities}
            value={config}
            required
            onChange={(v) => setConfig({ ...config, ...v })}
          />
          <div className="grid">
            <label className="field">
              開始日時
              <input
                type="datetime-local"
                required
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </label>
            <label className="field">
              学習時間（分）
              <input
                type="number"
                required
                min="0"
                step="any"
                max="1440"
                value={minutes}
                onChange={(e) => setMinutes(+e.target.value)}
              />
            </label>
          </div>
          <label className="field">
            メモ
            <input value={memo} onChange={(e) => setMemo(e.target.value)} />
          </label>
          <div className="row">
            <button className="primary" disabled={manualSaving}>
              {manualSaving ? "保存中…" : "保存"}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={manualSaving}
              onClick={() => {
                setManual(false);
                setEditing(null);
              }}
            >
              キャンセル
            </button>
          </div>
        </form>
      )}
      <section className="panel timer-panel">
        <div className="tabs">
          {(["stopwatch", "countdown", "pomodoro"] as const).map((m, i) => (
            <button
              key={m}
              disabled={!!timer}
              className={config.mode === m ? "active" : ""}
              onClick={() => setConfig({ ...config, mode: m })}
            >
              {["ストップウォッチ", "カウントダウン", "ポモドーロ"][i]}
            </button>
          ))}
        </div>
        <div className="timer-display" aria-live="off">
          {String(Math.floor(seconds / 3600)).padStart(2, "0")}
          <span>:</span>
          {String(Math.floor(seconds / 60) % 60).padStart(2, "0")}
          <span>:</span>
          {String(seconds % 60).padStart(2, "0")}
        </div>
        <p className="muted">
          {timer
            ? timer.phase === "break"
              ? "休憩中（学習記録に含めません）"
              : timer.runningSince
                ? "集中しています"
                : "一時停止中"
            : "今日の学びを、ここから。"}
        </p>
        {timer && timer.mode !== "stopwatch" && elapsed >= limit && (
          <div className="notice">
            設定時間になりました。終了して保存すると、次のセットを開始できます。
          </div>
        )}
        <fieldset disabled={!!timer}>
          <Scope
            entities={entities}
            value={config}
            onChange={(v) => setConfig({ ...config, ...v })}
          />
          <div className="grid three">
            <label className="field">
              学習方法
              <select
                value={config.method}
                onChange={(e) =>
                  setConfig({ ...config, method: e.target.value })
                }
              >
                {["テキスト", "問題演習", "復習", "講義", "その他"].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            {config.mode !== "stopwatch" && (
              <label className="field">
                {config.mode === "pomodoro" ? "集中" : "設定"}時間（分）
                <input
                  type="number"
                  min="1"
                  max="720"
                  value={
                    config.mode === "pomodoro"
                      ? config.focusMinutes
                      : config.durationMinutes
                  }
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      [config.mode === "pomodoro"
                        ? "focusMinutes"
                        : "durationMinutes"]: +e.target.value,
                    })
                  }
                />
              </label>
            )}
            {config.mode === "pomodoro" && (
              <label className="field">
                休憩（分）
                <input
                  type="number"
                  min="1"
                  max="120"
                  value={config.breakMinutes}
                  onChange={(e) =>
                    setConfig({ ...config, breakMinutes: +e.target.value })
                  }
                />
              </label>
            )}
          </div>
        </fieldset>
        <div className="timer-controls">
          {!timer ? (
            <button
              className="primary"
              onClick={() =>
                run(async () => {
                  if (!config.targetId)
                    throw new Error("学習対象を選んでください");
                  if (
                    config.mode !== "stopwatch" &&
                    (!config.durationMinutes ||
                      config.durationMinutes < 1 ||
                      !config.focusMinutes ||
                      config.focusMinutes < 1 ||
                      !config.breakMinutes ||
                      config.breakMinutes < 1)
                  )
                    throw new Error("時間は1分以上で入力してください");
                  await setPreferences({ lastTimer: config });
                  await startTimer(config);
                }, onError)
              }
            >
              <Play size={19} />
              計測を開始
            </button>
          ) : (
            <>
              <button
                className="secondary"
                onClick={() =>
                  run(
                    () =>
                      timer.runningSince
                        ? pauseTimer(timer.token)
                        : resumeTimer(timer.token),
                    onError,
                  )
                }
              >
                {timer.runningSince ? <Pause size={18} /> : <Play size={18} />}
                {timer.runningSince ? "一時停止" : "再開"}
              </button>
              <button className="primary" onClick={() => run(finish, onError)}>
                <Square size={17} />
                終了・保存
              </button>
            </>
          )}
          {!timer && config.mode === "pomodoro" && (
            <button
              className="secondary"
              onClick={() =>
                run(() => startTimer({ ...config, phase: "break" }), onError)
              }
            >
              休憩を計る
            </button>
          )}
        </div>
        <small className="muted">
          計測状態は自動保存されます。画面を閉じても、再起動時に復元します。
        </small>
      </section>
      <section className="panel">
        <div className="section-heading">
          <h2>
            これまでの学習 <span className="count">{sessions.length}</span>
          </h2>
          <div className="row">
            <select
              aria-label="学習記録の絞り込み"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="">すべての対象</option>
              {entities
                .filter((e) => e.kind === "target")
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.title}
                  </option>
                ))}
            </select>
            <button
              className="icon-button"
              aria-label="CSV出力"
              onClick={() => {
                const a = document.createElement("a");
                a.href = URL.createObjectURL(
                  new Blob([sessionsToCSV(sessions)], { type: "text/csv" }),
                );
                a.download = "study-records.csv";
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 1000);
              }}
            >
              <Download size={18} />
            </button>
          </div>
        </div>
        {sessions.length ? (
          sessions.map((s) => (
            <article className="record-row" key={s.id}>
              <div>
                <strong>
                  {titleOf(entities, s.targetId)} ·{" "}
                  {titleOf(entities, s.subjectId)}
                </strong>
                <small className="muted">
                  {new Date(s.segments[0]?.start || s.createdAt).toLocaleString(
                    "ja-JP",
                  )}{" "}
                  · {s.method}
                </small>
                {s.memo && <p>{s.memo}</p>}
              </div>
              <strong>{fmt(s.minutes)}</strong>
              <button
                className="icon-button"
                aria-label="記録を編集"
                onClick={() => {
                  setEditing(s);
                  setManual(true);
                  setMinutes(s.minutes);
                  setMemo(s.memo);
                  setConfig({
                    ...config,
                    targetId: s.targetId,
                    subjectId: s.subjectId,
                    unitId: s.unitId,
                    method: s.method,
                  });
                  const d = new Date(s.segments[0].start);
                  setDate(
                    localDate(d) +
                      "T" +
                      String(d.getHours()).padStart(2, "0") +
                      ":" +
                      String(d.getMinutes()).padStart(2, "0"),
                  );
                }}
              >
                <Pencil size={17} />
              </button>
              <button
                className="icon-button"
                aria-label="記録をゴミ箱へ"
                onClick={() => {
                  if (confirm("この学習記録をゴミ箱に移しますか？"))
                    run(() => trashEntity(s.id), onError);
                }}
              >
                <Trash2 size={17} />
              </button>
            </article>
          ))
        ) : (
          <div className="empty">
            <Timer size={30} />
            <p>最初の学習を記録してみましょう。</p>
          </div>
        )}
      </section>
    </>
  );
}
function PlanView({
  entities,
  prefs,
  onError,
}: {
  entities: Entity[];
  prefs: Preferences;
  onError: (e: unknown) => void;
}) {
  const targets = entities.filter((e) => e.kind === "target") as Target[];
  const [tab, setTab] = useState("学習計画"),
    [selected, setSelected] = useState(""),
    [edit, setEdit] = useState<Entity | null>(null),
    [kind, setKind] = useState<"target" | "subject" | "unit">("target"),
    [form, setForm] = useState<Record<string, any>>({
      title: "",
      examDate: "",
      goalMinutes: 600,
      passCriteria: "",
      importance: 3,
      mastery: 0,
      requiredMinutes: 300,
      status: "未着手",
      subjectId: "",
    }),
    [showForm, setShowForm] = useState(false),
    [preview, setPreview] = useState<PlanPreview | null>(null),
    [planPrefs, setPlanPrefs] = useState<Preferences>(prefs);
  useEffect(() => setPlanPrefs(prefs), [prefs]);
  const target = targets.find((t) => t.id === (selected || targets[0]?.id));
  const subjects = entities.filter(
    (e) => e.kind === "subject" && e.targetId === target?.id,
  ) as Subject[];
  const tasks = (
    entities.filter(
      (e) => e.kind === "task" && e.targetId === target?.id,
    ) as Task[]
  ).sort((a, b) => a.date.localeCompare(b.date));
  const open = (k: typeof kind, e?: Entity) => {
    setKind(k);
    setEdit(e || null);
    setForm(
      e
        ? { ...e }
        : {
            title: "",
            examDate: "",
            goalMinutes: 600,
            passCriteria: "",
            importance: 3,
            mastery: 0,
            requiredMinutes: 300,
            status: "未着手",
            subjectId: subjects[0]?.id || "",
          },
    );
    setShowForm(true);
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) throw new Error("名前を入力してください");
    if (edit && !confirm("この学習対象の設定を更新しますか？")) return;
    if (kind !== "target" && !target)
      throw new Error("学習対象を先に登録してください");
    const result = await saveEntity(
      {
        ...edit,
        ...form,
        kind,
        title: form.title.trim(),
        ...(kind === "target" ? {} : { targetId: target?.id }),
      },
      edit?.version,
    );
    if (kind === "target") setSelected(result.id);
    setShowForm(false);
  };
  const calculate = async () => {
    if (!target) throw new Error("学習対象を登録してください");
    if (!target.examDate) throw new Error("試験日を設定してください");
    if (!subjects.length)
      throw new Error("必要学習時間を設定した科目を登録してください");
    const proposal = generatePlan({
      target,
      subjects,
      sessions: entities.filter((e) => e.kind === "session") as Session[],
      tasks: entities.filter((e) => e.kind === "task") as Task[],
      preferences: planPrefs,
      cards: entities.filter((e) => e.kind === "card") as Flashcard[],
    });
    await setPreferences(planPrefs);
    setPreview(proposal);
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">A CLEAR PATH FORWARD</p>
          <h1>目標から、今日の一歩へ。</h1>
          <p className="muted">
            使える時間と理解度から、毎日の計画を作成します。
          </p>
        </div>
        <button className="primary" onClick={() => open("target")}>
          <Plus size={18} />
          学習対象を追加
        </button>
      </div>
      <div className="tabs">
        {["学習計画", "対象・科目・単元"].map((t) => (
          <button
            key={t}
            className={tab === t ? "active" : ""}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {targets.length > 0 && (
        <label className="field target-select">
          学習対象
          <select
            disabled={showForm}
            value={target?.id || ""}
            onChange={(e) => {
              setSelected(e.target.value);
              setPreview(null);
            }}
          >
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </label>
      )}
      {showForm && (
        <form
          className="panel stack"
          onSubmit={(e) => run(() => save(e), onError)}
        >
          <div className="section-heading">
            <h2>
              {edit ? "編集" : "登録"}：
              {kind === "target"
                ? "学習対象"
                : kind === "subject"
                  ? "科目"
                  : "単元"}
            </h2>
            <button
              type="button"
              className="text-button"
              onClick={() => setShowForm(false)}
            >
              閉じる
            </button>
          </div>
          <label className="field">
            名前
            <input
              autoFocus
              required
              maxLength={200}
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </label>
          {kind === "target" ? (
            <div className="grid three">
              <label className="field">
                試験日（任意）
                <input
                  type="date"
                  value={form.examDate}
                  onChange={(e) =>
                    setForm({ ...form, examDate: e.target.value })
                  }
                />
              </label>
              <label className="field">
                目標学習時間（時間）
                <input
                  type="number"
                  inputMode="decimal"
                  step={
                    edit && Number(edit.goalMinutes) % 60 !== 0 ? "any" : "1"
                  }
                  min="0"
                  max="876000"
                  required
                  value={form.goalMinutes / 60}
                  onChange={(e) =>
                    setForm({ ...form, goalMinutes: +e.target.value * 60 })
                  }
                />
              </label>
              <label className="field">
                合格基準（任意）
                <input
                  value={form.passCriteria}
                  onChange={(e) =>
                    setForm({ ...form, passCriteria: e.target.value })
                  }
                />
              </label>
            </div>
          ) : (
            <>
              {kind === "unit" && (
                <label className="field">
                  科目
                  <select
                    required
                    disabled={!!edit}
                    value={form.subjectId}
                    onChange={(e) =>
                      setForm({ ...form, subjectId: e.target.value })
                    }
                  >
                    <option value="">選択</option>
                    {subjects.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className="grid three">
                <label className="field">
                  重要度（1〜5）
                  <input
                    type="number"
                    min="1"
                    max="5"
                    required
                    value={form.importance}
                    onChange={(e) =>
                      setForm({ ...form, importance: +e.target.value })
                    }
                  />
                </label>
                <label className="field">
                  習熟度（%）
                  <input
                    type="number"
                    min="0"
                    max="100"
                    required
                    value={form.mastery}
                    onChange={(e) =>
                      setForm({ ...form, mastery: +e.target.value })
                    }
                  />
                </label>
                <label className="field">
                  学習状況
                  <select
                    value={form.status}
                    onChange={(e) =>
                      setForm({ ...form, status: e.target.value })
                    }
                  >
                    {["未着手", "学習中", "復習中", "完了"].map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </label>
              </div>
              {kind === "subject" && (
                <label className="field">
                  必要学習時間（時間）
                  <input
                    type="number"
                    inputMode="decimal"
                    step={
                      edit && Number(edit.requiredMinutes) % 60 !== 0
                        ? "any"
                        : "1"
                    }
                    min="0"
                    max="876000"
                    required
                    value={form.requiredMinutes / 60}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        requiredMinutes: +e.target.value * 60,
                      })
                    }
                  />
                </label>
              )}
            </>
          )}
          <div>
            <button className="primary">保存</button>
          </div>
        </form>
      )}
      {!target ? (
        <section className="panel empty">
          <GraduationCap size={40} />
          <h2>学びたいことを登録しましょう</h2>
          <p>試験日が未定でも、記録と復習はすぐに始められます。</p>
          <button className="primary" onClick={() => open("target")}>
            最初の学習対象を登録
          </button>
        </section>
      ) : tab === "対象・科目・単元" ? (
        <section className="panel">
          <div className="section-heading">
            <div>
              <h2>{target.title}</h2>
              <p className="muted">
                目標 {fmt(target.goalMinutes)} ·{" "}
                {target.examDate || "日程未設定"} ·{" "}
                {target.passCriteria || "合格基準未設定"}
              </p>
            </div>
            <div className="row">
              <button
                className="secondary"
                onClick={() => open("target", target)}
              >
                編集
              </button>
              <button
                className="icon-button"
                aria-label="学習対象をゴミ箱へ"
                onClick={() => {
                  if (
                    confirm(
                      "この対象をゴミ箱に移しますか？関連する学習記録は保持します。",
                    )
                  )
                    run(() => trashEntity(target.id), onError);
                }}
              >
                <Trash2 size={17} />
              </button>
            </div>
          </div>
          <div className="row">
            <button className="secondary" onClick={() => open("subject")}>
              <Plus size={16} />
              科目
            </button>
            <button
              className="secondary"
              disabled={!subjects.length}
              onClick={() => open("unit")}
            >
              <Plus size={16} />
              単元
            </button>
          </div>
          {subjects.length ? (
            subjects.map((s) => (
              <div key={s.id} className="subject-block">
                <div className="row spread">
                  <div>
                    <h3>{s.title}</h3>
                    <span className="muted">
                      重要度 {s.importance} · 習熟度 {s.mastery}% · 必要{" "}
                      {fmt(s.requiredMinutes)} · {s.status}
                    </span>
                  </div>
                  <div className="row">
                    <button
                      className="icon-button"
                      aria-label={`${s.title}を編集`}
                      onClick={() => open("subject", s)}
                    >
                      <Pencil size={17} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`${s.title}をゴミ箱へ`}
                      onClick={() => {
                        if (
                          confirm(
                            "この科目をゴミ箱に移しますか？記録は保持します。",
                          )
                        )
                          run(() => trashEntity(s.id), onError);
                      }}
                    >
                      <Trash2 size={17} />
                    </button>
                  </div>
                </div>
                {entities
                  .filter((e) => e.kind === "unit" && e.subjectId === s.id)
                  .map((u) => (
                    <div className="unit-row" key={u.id}>
                      <span>
                        {u.title}{" "}
                        <small className="muted">
                          習熟度 {Number(u.mastery)}% · {String(u.status)}
                        </small>
                      </span>
                      <div className="row">
                        <button
                          className="icon-button"
                          aria-label={`${u.title}を編集`}
                          onClick={() => open("unit", u)}
                        >
                          <Pencil size={16} />
                        </button>
                        <button
                          className="icon-button"
                          aria-label={`${u.title}をゴミ箱へ`}
                          onClick={() => {
                            if (confirm("単元をゴミ箱に移しますか？"))
                              run(() => trashEntity(u.id), onError);
                          }}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
            ))
          ) : (
            <div className="empty">
              <p>
                科目ごとに必要時間と習熟度を設定すると、計画を作成できます。
              </p>
            </div>
          )}
        </section>
      ) : (
        <>
          <section className="panel stack">
            <div className="section-heading">
              <h2>学習できる時間</h2>
              <button
                className="text-button"
                onClick={() => {
                  setTab("対象・科目・単元");
                }}
              >
                科目・試験日を設定
                <ChevronRight size={16} />
              </button>
            </div>
            <p className="muted">
              曜日ごとの時間（分）を入力してください。複数の学習対象のタスクも考慮します。
            </p>
            <div className="weekday-grid">
              {["月", "火", "水", "木", "金", "土", "日"].map((d, i) => (
                <label className="field" key={d}>
                  {d}
                  <input
                    type="number"
                    min="0"
                    max="1440"
                    value={planPrefs.weekdayMinutes[i]}
                    onChange={(e) =>
                      setPlanPrefs({
                        ...planPrefs,
                        weekdayMinutes: planPrefs.weekdayMinutes.map((m, j) =>
                          i === j ? +e.target.value : m,
                        ),
                      })
                    }
                  />
                </label>
              ))}
            </div>
            <div className="grid three">
              <label className="field">
                復習の割合（%）
                <input
                  type="number"
                  min="0"
                  max="80"
                  value={Math.round(planPrefs.reviewRatio * 100)}
                  onChange={(e) =>
                    setPlanPrefs({
                      ...planPrefs,
                      reviewRatio: +e.target.value / 100,
                    })
                  }
                />
              </label>
              <label className="field">
                試験直前の予備日
                <input
                  type="number"
                  min="0"
                  max="30"
                  value={planPrefs.bufferDays}
                  onChange={(e) =>
                    setPlanPrefs({ ...planPrefs, bufferDays: +e.target.value })
                  }
                />
              </label>
              <label className="field">
                学習できない日（改行区切り）
                <textarea
                  placeholder="2026-12-01"
                  value={planPrefs.unavailableDates.join("\n")}
                  onChange={(e) =>
                    setPlanPrefs({
                      ...planPrefs,
                      unavailableDates: e.target.value
                        .split(/\n|,/)
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </label>
            </div>
            <div>
              <button
                className="primary"
                onClick={() => run(calculate, onError)}
              >
                計画案をプレビュー
              </button>
            </div>
            <small className="muted">
              完了済み・過去のタスクを保持し、未完了分を再配分します。
            </small>
          </section>
          {preview && (
            <section className="panel stack">
              <h2>新しい計画案</h2>
              <div className="grid three">
                <div className="stat">
                  必要時間<strong>{fmt(preview.requiredMinutes)}</strong>
                </div>
                <div className="stat">
                  利用可能<strong>{fmt(preview.availableMinutes)}</strong>
                </div>
                <div className="stat">
                  不足時間<strong>{fmt(preview.shortageMinutes)}</strong>
                </div>
              </div>
              {preview.shortageMinutes > 0 && (
                <div className="notice">
                  現在の条件では {fmt(preview.shortageMinutes)}{" "}
                  不足します。学習時間・必要時間を調整できます。
                </div>
              )}
              <div className="scroll-list">
                {preview.tasks.map((t) => (
                  <div className="record-row" key={t.id}>
                    <span>{t.date}</span>
                    <span>
                      {titleOf(entities, t.subjectId)} ·{" "}
                      {t.review ? "復習" : "学習"}
                    </span>
                    <strong>{fmt(t.minutes)}</strong>
                  </div>
                ))}
              </div>
              <p className="muted">
                将来の未完了タスク {preview.replaceTaskIds.length}{" "}
                件をゴミ箱に移し、新しいタスクを追加します。
              </p>
              <div className="row">
                <button
                  className="primary"
                  onClick={() => {
                    if (
                      confirm(
                        "プレビューした計画に反映しますか？完了済み・過去のタスクは保持します。",
                      )
                    )
                      run(async () => {
                        await applyPlan(preview);
                        setPreview(null);
                      }, onError);
                  }}
                >
                  この計画を承認・反映
                </button>
                <button className="secondary" onClick={() => setPreview(null)}>
                  取り消す
                </button>
              </div>
            </section>
          )}
          <section className="panel">
            <div className="section-heading">
              <h2>学習タスク</h2>
              <span className="muted">
                {tasks.filter((t) => t.completed).length} / {tasks.length} 完了
              </span>
            </div>
            {tasks.length ? (
              tasks.map((t) => (
                <label className="task-row" key={t.id}>
                  <input
                    type="checkbox"
                    checked={t.completed}
                    onChange={() => {
                      if (confirm("タスクの完了状態を変更しますか？"))
                        run(
                          () =>
                            saveEntity(
                              { ...t, completed: !t.completed },
                              t.version,
                            ),
                          onError,
                        );
                    }}
                  />
                  <span className={t.completed ? "completed" : ""}>
                    {t.date} · {titleOf(entities, t.subjectId)}
                    <small className="muted">
                      {t.review ? "復習" : "学習"}
                    </small>
                  </span>
                  <strong>{fmt(t.minutes)}</strong>
                </label>
              ))
            ) : (
              <div className="empty">
                <CalendarDays size={30} />
                <p>上の条件を設定して、計画案を作成してください。</p>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}
