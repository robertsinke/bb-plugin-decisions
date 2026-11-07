import { useEffect, useRef, useState } from "react";
import { definePluginApp, useBbNavigate, useRpc, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.ts";
import { DEFAULT_WORDING, type NamedWording } from "./wording.ts";
import {
  callerLabel,
  costLine,
  formatDuration,
  formatUsd,
  readRoute,
  usageLine,
  type UsageDays,
  type UsagePoint,
  type UsageReport,
  type UsageView,
} from "./usage.ts";
import "./usage.css";

const RANGES: { days: UsageDays; label: string }[] = [
  { days: 1, label: "24 hours" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
];

const VIEWS: { view: UsageView; label: string }[] = [
  { view: "activity", label: "Activity" },
  { view: "cost", label: "Cost" },
  { view: "callers", label: "Callers" },
  { view: "confidence", label: "Confidence" },
];

interface Hot {
  value: string;
  caption: string;
}

function UsageMenu({ subPath }: PluginNavPanelProps) {
  const nav = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const route = readRoute(subPath);
  const [questions, setQuestions] = useState<NamedWording[]>([]);
  useEffect(() => {
    let stop = false;
    const load = () => {
      rpcRef.current.call("questions", null).then((next) => {
        if (!stop) setQuestions(next.questions);
      }).catch(() => undefined);
    };
    load();
    window.addEventListener("decisions-questions", load);
    return () => {
      stop = true;
      window.removeEventListener("decisions-questions", load);
    };
  }, []);
  function go(days: UsageDays, view: UsageView) {
    nav.toPluginPanel("usage", { subPath: `${days}/${view}` });
  }
  function openQuestion(id: string) {
    nav.toPluginPanel("usage", { subPath: `${route.days}/question/${id}` });
  }
  return (
    <nav className="du-menu" aria-label="Usage">
      {route.view === "question" ? null : (
        <>
          <p>Range</p>
          {RANGES.map((range) => (
            <button
              key={range.days}
              type="button"
              aria-current={route.days === range.days ? "page" : undefined}
              onClick={() => go(range.days, route.view)}
            >
              {range.label}
            </button>
          ))}
        </>
      )}
      <p>Chart</p>
      {VIEWS.map((item) => (
        <button
          key={item.view}
          type="button"
          aria-current={route.view === item.view ? "page" : undefined}
          onClick={() => go(route.days, item.view)}
        >
          {item.label}
        </button>
      ))}
      <p>Asks</p>
      {questions.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-current={route.view === "question" && route.questionId === item.id ? "page" : undefined}
          onClick={() => openQuestion(item.id)}
        >
          {item.name}
        </button>
      ))}
    </nav>
  );
}

function UsagePanel({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const { days, view } = readRoute(subPath);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hot, setHot] = useState<Hot | null>(null);
  useEffect(() => {
    let stop = false;
    const load = () => {
      rpcRef.current.call("usage", { days }).then((next) => {
        if (!stop) {
          setReport(next);
          setError(null);
        }
      }).catch((cause: unknown) => {
        if (!stop) setError(cause instanceof Error ? cause.message : "Usage could not load.");
      });
    };
    load();
    const timer = setInterval(load, 15_000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [days]);
  useEffect(() => setHot(null), [days, view]);
  if (view === "question") return <QuestionEditor subPath={subPath} />;

  const resting = report ? restingFigure(report, view) : null;
  const figure = hot?.value ?? resting?.value ?? "";
  const caption = hot?.caption ?? (report ? (view === "cost" ? costLine(report) : usageLine(report)) : "Asks to the decision API.");

  return (
    <main className="du">
      <p className="du-kicker">{resting?.kicker ?? "Usage"}</p>
      <p className="du-figure" aria-live="polite">{figure || "—"}</p>
      <p className="du-caption">{error ?? caption}</p>
      {report ? <p className="du-meta">{metaLine(report)}</p> : null}
      {report && view === "activity" ? <Activity points={report.points} days={days} onHot={setHot} /> : null}
      {report && view === "cost" ? <Cost points={report.points} days={days} onHot={setHot} /> : null}
      {report && view === "callers" ? <Callers report={report} onHot={setHot} /> : null}
      {report && view === "confidence" ? <Confidence counts={report.confidence} onHot={setHot} /> : null}
      {!report && !error ? <p className="du-caption">Loading usage…</p> : null}
    </main>
  );
}

function sameText(left: NamedWording, right: NamedWording): boolean {
  return left.name === right.name && left.question === right.question && left.yes === right.yes && left.no === right.no;
}

function QuestionEditor({ subPath }: PluginNavPanelProps) {
  const nav = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const route = readRoute(subPath);
  const navRef = useRef(nav);
  navRef.current = nav;
  const [saved, setSaved] = useState<NamedWording | null>(null);
  const [draft, setDraft] = useState<NamedWording | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  useEffect(() => {
    let stop = false;
    rpcRef.current.call("questions", null).then((next) => {
      if (stop) return;
      const chosen = next.questions.find((item) => item.id === route.questionId)
        ?? next.questions.find((item) => item.used)
        ?? next.questions[0];
      if (!chosen) return;
      if (chosen.id !== route.questionId) {
        navRef.current.toPluginPanel("usage", { subPath: `${route.days}/question/${chosen.id}` });
        return;
      }
      setSaved(chosen);
      setDraft(chosen);
      setError(null);
    }).catch((cause: unknown) => {
      if (!stop) setError(cause instanceof Error ? cause.message : "The question could not load.");
    });
    return () => {
      stop = true;
    };
  }, [route.days, route.questionId]);
  function edit(patch: Partial<NamedWording>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setNote("");
  }
  function publish(stored: NamedWording) {
    setSaved(stored);
    setDraft(stored);
    setNote("Saved");
    window.dispatchEvent(new Event("decisions-questions"));
  }
  async function save(next: NamedWording) {
    setError(null);
    const stored = await rpcRef.current.call("save_question", {
      id: next.id,
      name: next.name,
      question: next.question,
      yes: next.yes,
      no: next.no,
    });
    publish(stored);
  }
  async function useThis(next: NamedWording) {
    setError(null);
    const current = dirty ? await rpcRef.current.call("save_question", {
      id: next.id,
      name: next.name,
      question: next.question,
      yes: next.yes,
      no: next.no,
    }) : next;
    const stored = await rpcRef.current.call("use_question", { id: current.id });
    publish(stored);
  }
  const ready = draft !== null && saved !== null;
  const dirty = ready && !sameText(draft, saved);
  const blank = !draft?.name.trim() || !draft.question.trim() || !draft.yes.trim() || !draft.no.trim();
  const original = ready && draft.question === DEFAULT_WORDING.question && draft.yes === DEFAULT_WORDING.yes && draft.no === DEFAULT_WORDING.no
    && saved.question === DEFAULT_WORDING.question && saved.yes === DEFAULT_WORDING.yes && saved.no === DEFAULT_WORDING.no;
  return (
    <main className="du">
      <p className="du-kicker">{saved?.used ? "Inbox asks this" : "Ask"}</p>
      <form
        className="du-ask"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft && dirty && !blank) void save(draft).catch((cause: unknown) => {
            setError(cause instanceof Error ? cause.message : "The question could not be saved.");
          });
        }}
      >
        <label>
          <span>Name</span>
          <input
            className="du-lead"
            value={draft?.name ?? ""}
            disabled={!ready}
            onChange={(event) => edit({ name: event.target.value })}
          />
        </label>
        <label>
          <span>Sentence</span>
          <textarea
            rows={3}
            value={draft?.question ?? ""}
            disabled={!ready}
            onChange={(event) => edit({ question: event.target.value })}
          />
        </label>
        <p className="du-hint">{"{n}"} is the message number. A row with no thread uses the preview.</p>
        <label>
          <span>Counts as yes</span>
          <textarea rows={3} value={draft?.yes ?? ""} disabled={!ready} onChange={(event) => edit({ yes: event.target.value })} />
        </label>
        <label>
          <span>Counts as no</span>
          <textarea rows={4} value={draft?.no ?? ""} disabled={!ready} onChange={(event) => edit({ no: event.target.value })} />
        </label>
        <div className="du-actions">
          <button type="submit" disabled={!dirty || blank}>Save</button>
          <button
            type="button"
            className="du-quiet"
            disabled={!ready || draft.used}
            onClick={() => draft && void useThis(draft).catch((cause: unknown) => {
              setError(cause instanceof Error ? cause.message : "The inbox could not switch.");
            })}
          >
            {draft?.used ? "Used by the inbox" : "Use for the inbox"}
          </button>
          <button type="button" className="du-quiet" disabled={original || !ready} onClick={() => draft && void save({ ...draft, ...DEFAULT_WORDING }).catch((cause: unknown) => {
            setError(cause instanceof Error ? cause.message : "The question could not be saved.");
          })}>Reset</button>
          <span className="du-saved" aria-live="polite">{note}</span>
        </div>
        {error ? <p className="du-caption">{error}</p> : null}
      </form>
    </main>
  );
}

function restingFigure(report: UsageReport, view: UsageView): { kicker: string; value: string } {
  if (view === "cost") return { kicker: "Cost", value: report.pricedAsks === 0 ? "—" : formatUsd(report.costUsd) };
  if (view === "callers") return { kicker: "Callers", value: String(report.callers.length) };
  if (view === "confidence") {
    return { kicker: "Mean yes/no", value: report.meanNoul === null ? "—" : report.meanNoul.toFixed(2) };
  }
  return { kicker: "Asks", value: report.asks.toLocaleString() };
}

function metaLine(report: UsageReport): string {
  const kept = report.confidence.reduce((sum, count) => sum + count, 0);
  const tokens = report.tokensIn + report.tokensOut;
  return [
    `${report.questions.toLocaleString()} questions`,
    report.medianMs === null ? null : `${formatDuration(report.medianMs)} typical`,
    kept > 0 && kept !== report.noul ? `${kept.toLocaleString()} scores kept` : null,
    report.pricedAsks > 0 ? formatUsd(report.costUsd) : null,
    tokens > 0 ? `${tokens.toLocaleString()} input tokens` : null,
    report.failed > 0 ? `${report.failed} failed` : null,
  ].filter((part) => part !== null).join(" · ");
}

function Activity({ points, days, onHot }: { points: UsagePoint[]; days: UsageDays; onHot: (hot: Hot | null) => void }) {
  const bars = points.map((point) => ({
    key: String(point.start),
    value: point.asks,
    hot: {
      value: String(point.asks),
      caption: `${when(point.start, days)} · ${point.asks} asks · ${point.questions} questions`,
    },
  }));
  return (
    <>
      <Bars label="Asks over time" bars={bars} onHot={onHot} />
      <div className="du-axis">
        <span>{points[0] ? when(points[0].start, days) : ""}</span>
        <span>{points.length > 1 ? when(points[points.length - 1].start, days) : ""}</span>
      </div>
    </>
  );
}

function Cost({ points, days, onHot }: { points: UsagePoint[]; days: UsageDays; onHot: (hot: Hot | null) => void }) {
  const bars = points.map((point) => ({
    key: String(point.start),
    value: point.costUsd,
    hot: {
      value: point.costUsd > 0 ? formatUsd(point.costUsd) : "—",
      caption: `${when(point.start, days)} · ${point.costUsd > 0 ? formatUsd(point.costUsd) : "no token count"} · ${point.tokensIn.toLocaleString()} input tokens`,
    },
  }));
  return (
    <>
      <Bars label="Cost over time" bars={bars} onHot={onHot} />
      <div className="du-axis">
        <span>{points[0] ? when(points[0].start, days) : ""}</span>
        <span>{points.length > 1 ? when(points[points.length - 1].start, days) : ""}</span>
      </div>
    </>
  );
}

function Confidence({ counts, onHot }: { counts: number[]; onHot: (hot: Hot | null) => void }) {
  const bars = counts.map((value, index) => ({
    key: String(index),
    value,
    hot: { value: String(value), caption: `${band(index)} · ${value} yes/no scores` },
  }));
  return <Bars label="How sure the yes/no scores were" bars={bars} onHot={onHot} />;
}

function Callers({ report, onHot }: { report: UsageReport; onHot: (hot: Hot | null) => void }) {
  if (report.callers.length === 0) return <p className="du-caption">No callers in this window.</p>;
  const most = Math.max(...report.callers.map((row) => row.asks));
  return (
    <ul className="du-callers">
      {report.callers.map((row, index) => (
        <li key={row.caller}>
          <button
            type="button"
            onMouseEnter={() => onHot({ value: String(row.asks), caption: `${callerLabel(row.caller)} · ${row.questions} questions` })}
            onMouseLeave={() => onHot(null)}
            onFocus={() => onHot({ value: String(row.asks), caption: `${callerLabel(row.caller)} · ${row.questions} questions` })}
            onBlur={() => onHot(null)}
          >
            <span>{callerLabel(row.caller)}</span>
            <span className="du-track"><span style={{ width: `${(row.asks / most) * 100}%`, animationDelay: `${index * 40}ms` }} /></span>
            <span className="du-count">{row.asks}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Bars({ label, bars, onHot }: { label: string; bars: { key: string; value: number; hot: Hot }[]; onHot: (hot: Hot | null) => void }) {
  const [hot, setHot] = useState<number | null>(null);
  const max = Math.max(1, ...bars.map((bar) => bar.value));
  const width = 1000;
  const height = 280;
  const gap = bars.length > 1 ? 6 : 0;
  const barWidth = bars.length === 0 ? width : (width - gap * (bars.length - 1)) / bars.length;
  function choose(index: number | null) {
    setHot(index);
    onHot(index === null ? null : bars[index]?.hot ?? null);
  }
  function move(key: string) {
    if (key !== "ArrowRight" && key !== "ArrowLeft") return;
    const next = Math.max(0, Math.min(bars.length - 1, (hot ?? 0) + (key === "ArrowRight" ? 1 : -1)));
    choose(next);
  }
  return (
    <div className="du-chart" tabIndex={0} onKeyDown={(event) => move(event.key)} aria-label={label}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
        <line className="du-base" x1={0} y1={height - 0.5} x2={width} y2={height - 0.5} />
        {bars.map((bar, index) => {
          const barHeight = bar.value === 0 ? 0 : Math.max(4, (bar.value / max) * (height - 12));
          const x = index * (barWidth + gap);
          return (
            <g key={bar.key} className={hot === index ? "is-hot" : ""}>
              <rect className="du-hit" x={x} y={0} width={barWidth} height={height} onMouseEnter={() => choose(index)} onMouseLeave={() => choose(null)}>
                <title>{bar.hot.caption}</title>
              </rect>
              {barHeight > 0 ? (
                <rect className="du-bar" x={x} y={height - barHeight} width={barWidth} height={barHeight} style={{ animationDelay: `${Math.min(index, 28) * 16}ms` }} pointerEvents="none" />
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function when(start: number, days: UsageDays): string {
  const date = new Date(start);
  if (days === 1) return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function band(index: number): string {
  const low = (index / 10).toFixed(1);
  const high = index === 9 ? "1.0" : ((index + 1) / 10).toFixed(1);
  return `${low}–${high}`;
}

function useUsageBadge() {
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const [asks, setAsks] = useState<number | null>(null);
  useEffect(() => {
    let stop = false;
    const load = () => {
      rpcRef.current.call("usage", { days: 1 }).then((report) => {
        if (!stop) setAsks(report.asks);
      }).catch(() => {
        if (!stop) setAsks(null);
      });
    };
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, []);
  if (!asks) return null;
  return { count: asks, label: `${asks} decision asks in the last day` };
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "usage",
    title: "Decisions",
    icon: "ChartColumn",
    path: "usage",
    component: UsagePanel,
    experimental_sidebar: UsageMenu,
    experimental_useBadge: useUsageBadge,
  });
});
