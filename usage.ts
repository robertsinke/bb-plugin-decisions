/** Counts of decision asks. Question text and the API key are never stored. */

export interface UsageSql {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: Array<string | number | null>): unknown;
    all(...params: Array<string | number | null>): unknown[];
    get(...params: Array<string | number | null>): unknown;
  };
}

export const USAGE_MIGRATIONS = [
  `CREATE TABLE decision_usage (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    caller TEXT NOT NULL,
    model TEXT NOT NULL,
    questions INTEGER NOT NULL,
    noul INTEGER NOT NULL,
    choice INTEGER NOT NULL,
    score INTEGER NOT NULL,
    noul_sum REAL NOT NULL,
    hist TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    ms INTEGER NOT NULL,
    ok INTEGER NOT NULL
  )`,
  `CREATE INDEX decision_usage_at ON decision_usage(at)`,
  `CREATE TABLE decision_usage_import (id TEXT PRIMARY KEY)`,
  `CREATE TABLE decision_wording (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    question TEXT NOT NULL,
    yes TEXT NOT NULL,
    no TEXT NOT NULL,
    used INTEGER NOT NULL,
    sort INTEGER NOT NULL
  )`,
];

const INSERT = `INSERT INTO decision_usage (
  at, caller, model, questions, noul, choice, score, noul_sum, hist, input_tokens, output_tokens, ms, ok
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const WINDOW = `SELECT at, caller, questions, noul, choice, score, noul_sum, hist, input_tokens, output_tokens, ms, ok
  FROM decision_usage WHERE at >= ? AND at < ?`;

export type UsageDays = 1 | 7 | 30;
export type UsageView = "activity" | "cost" | "callers" | "confidence" | "question";

/** Jev list price: $42 per billion input tokens. Output tokens are free. docs.typesafe.ai/models */
export const USD_PER_INPUT_TOKEN = 42 / 1_000_000_000;

export function inputCostUsd(inputTokens: number): number {
  return inputTokens * USD_PER_INPUT_TOKEN;
}

export interface UsageEvent {
  at: number;
  caller: string;
  model: string;
  questions: Record<string, { type: string }>;
  answers: Record<string, unknown> | null;
  inputTokens: number | null;
  outputTokens: number | null;
  ms: number;
  ok: boolean;
}

export interface UsagePoint {
  start: number;
  asks: number;
  questions: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface UsageCaller {
  caller: string;
  asks: number;
  questions: number;
}

export interface UsageReport {
  days: UsageDays;
  from: number;
  to: number;
  asks: number;
  questions: number;
  failed: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  pricedAsks: number;
  unpricedAsks: number;
  noul: number;
  choice: number;
  score: number;
  meanNoul: number | null;
  medianMs: number | null;
  points: UsagePoint[];
  callers: UsageCaller[];
  confidence: number[];
}

interface UsageRow {
  at: number;
  caller: string;
  questions: number;
  noul: number;
  choice: number;
  score: number;
  noul_sum: number;
  hist: string;
  input_tokens: number | null;
  output_tokens: number | null;
  ms: number;
  ok: number;
}

export function recordUsage(db: UsageSql, event: UsageEvent): void {
  const kinds = { noul: 0, choice: 0, score: 0 };
  let noulSum = 0;
  const hist = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const [key, question] of Object.entries(event.questions)) {
    if (question.type === "noul") kinds.noul += 1;
    else if (question.type === "choice") kinds.choice += 1;
    else if (question.type === "score") kinds.score += 1;
    if (question.type !== "noul" || !event.ok) continue;
    const score = noulValue(event.answers?.[key]);
    if (score === null) continue;
    noulSum += score;
    hist[Math.min(9, Math.floor(score * 10))] += 1;
  }
  const questions = Object.keys(event.questions).length;
  db.prepare(INSERT).run(
    event.at,
    clip(event.caller, "client"),
    clip(event.model, "unknown"),
    questions,
    kinds.noul,
    kinds.choice,
    kinds.score,
    noulSum,
    hist.join(","),
    event.inputTokens,
    event.outputTokens,
    event.ms,
    event.ok ? 1 : 0,
  );
}

export function usageReport(
  db: UsageSql,
  options: { now: number; days: UsageDays; timeZoneOffsetMinutes: number },
): UsageReport {
  const span = options.days * 86_400_000;
  const from = options.now - span;
  const to = options.now;
  const rows = db.prepare(WINDOW).all(from, to) as UsageRow[];
  const step = options.days === 1 ? 3_600_000 : 86_400_000;
  const offset = -options.timeZoneOffsetMinutes * 60_000;
  const points = new Map<number, UsagePoint>();
  const callers = new Map<string, UsageCaller>();
  const confidence = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const waits: number[] = [];
  const report: UsageReport = {
    days: options.days,
    from,
    to,
    asks: 0,
    questions: 0,
    failed: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    pricedAsks: 0,
    unpricedAsks: 0,
    noul: 0,
    choice: 0,
    score: 0,
    meanNoul: null,
    medianMs: null,
    points: [],
    callers: [],
    confidence,
  };
  let noulSum = 0;
  for (const row of rows) {
    report.asks += 1;
    report.questions += row.questions;
    report.noul += row.noul;
    report.choice += row.choice;
    report.score += row.score;
    const cost = typeof row.input_tokens === "number" ? inputCostUsd(row.input_tokens) : null;
    if (cost === null) {
      if (row.ok) report.unpricedAsks += 1;
    } else {
      report.pricedAsks += 1;
      report.tokensIn += row.input_tokens ?? 0;
      report.costUsd += cost;
    }
    report.tokensOut += row.output_tokens ?? 0;
    noulSum += row.noul_sum;
    // shortcut: a backfilled ask has no measured wait, stored as 0. A live ask is slower than that.
    if (row.ok && row.ms > 0) waits.push(row.ms);
    else if (!row.ok) report.failed += 1;
    addHist(confidence, row.hist);
    const start = bucketStart(row.at, step, offset);
    const point = points.get(start) ?? { start, asks: 0, questions: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 };
    point.asks += 1;
    point.questions += row.questions;
    if (cost !== null) {
      point.tokensIn += row.input_tokens ?? 0;
      point.costUsd += cost;
    }
    point.tokensOut += row.output_tokens ?? 0;
    points.set(start, point);
    const caller = callers.get(row.caller) ?? { caller: row.caller, asks: 0, questions: 0 };
    caller.asks += 1;
    caller.questions += row.questions;
    callers.set(row.caller, caller);
  }
  const first = bucketStart(from, step, offset);
  const last = bucketStart(Math.max(from, to - 1), step, offset);
  for (let start = first; start <= last; start += step) {
    report.points.push(points.get(start) ?? { start, asks: 0, questions: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 });
  }
  report.callers = [...callers.values()].sort((a, b) => b.asks - a.asks || a.caller.localeCompare(b.caller));
  const scored = confidence.reduce((sum, count) => sum + count, 0);
  report.meanNoul = scored > 0 ? noulSum / scored : null;
  report.medianMs = median(waits);
  return report;
}

/** One sentence for the open chart. The numbers stay in the report. */
export function usageLine(report: UsageReport): string {
  if (report.asks === 0) return "No asks in this window yet.";
  const top = report.callers[0];
  if (top && report.callers.length > 1 && top.asks / report.asks >= 0.6) {
    return `${callerLabel(top.caller)} sent ${top.asks} of ${report.asks} asks.`;
  }
  const scored = report.confidence.reduce((sum, count) => sum + count, 0);
  if (report.meanNoul !== null && scored >= 5) {
    return `Yes/no answers average ${report.meanNoul.toFixed(2)} across ${scored}.`;
  }
  if (report.medianMs !== null) return `A typical ask took ${formatDuration(report.medianMs)}.`;
  return `${report.questions} questions across ${report.asks} asks.`;
}

export function callerLabel(caller: string): string {
  if (caller === "tool") return "Threads";
  if (caller === "client") return "Direct calls";
  return caller;
}

export function formatUsd(amount: number): string {
  if (!(amount > 0)) return "$0";
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  if (amount >= 0.01) return `$${amount.toFixed(3)}`;
  const digits = Math.min(6, Math.max(2, Math.ceil(-Math.log10(amount)) + 1));
  return `$${amount.toFixed(digits)}`;
}

/** What the cost chart says when nothing is hovered. */
export function costLine(report: UsageReport): string {
  if (report.pricedAsks === 0) {
    return "Earlier asks did not keep input tokens, so their cost is not shown. Jev is $0.042 per million input tokens. Output is free.";
  }
  if (report.unpricedAsks > 0) {
    const priced = report.pricedAsks === 1 ? "ask" : "asks";
    const earlier = report.unpricedAsks === 1 ? "ask had" : "asks had";
    return `${formatUsd(report.costUsd)} from ${report.pricedAsks} ${priced}. ${report.unpricedAsks} earlier ${earlier} no token count.`;
  }
  return `${formatUsd(report.costUsd)} at $0.042 per million input tokens. Output is free.`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

export function readRoute(subPath: string): { days: UsageDays; view: UsageView; questionId: string | null } {
  const [day, view, questionId] = decodeRoute(subPath).split("/");
  return {
    days: day === "1" || day === "30" ? Number(day) as UsageDays : 7,
    view: view === "cost" || view === "callers" || view === "confidence" || view === "question" ? view : "activity",
    questionId: view === "question" && questionId ? questionId : null,
  };
}

function decodeRoute(subPath: string): string {
  try {
    return decodeURIComponent(subPath);
  } catch {
    return subPath;
  }
}

function clip(value: string, fallback: string): string {
  const clean = value.replace(/[^\w.@:-]+/g, "").slice(0, 64);
  return clean || fallback;
}

function noulValue(answer: unknown): number | null {
  const value = typeof answer === "number"
    ? answer
    : typeof answer === "object" && answer !== null && "noul" in answer
      ? (answer as { noul: unknown }).noul
      : null;
  return typeof value === "number" && value >= 0 && value <= 1 ? value : null;
}

function addHist(into: number[], hist: string): void {
  const parts = hist.split(",");
  if (parts.length !== 10) return;
  for (let i = 0; i < 10; i += 1) {
    const n = Number(parts[i]);
    if (Number.isInteger(n) && n >= 0) into[i] += n;
  }
}

function bucketStart(at: number, step: number, offsetMs: number): number {
  return Math.floor((at + offsetMs) / step) * step - offsetMs;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
