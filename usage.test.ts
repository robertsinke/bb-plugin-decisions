import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  USAGE_MIGRATIONS,
  callerLabel,
  costLine,
  formatUsd,
  inputCostUsd,
  readRoute,
  recordUsage,
  usageLine,
  usageReport,
  type UsageSql,
} from "./usage.ts";

function db(): UsageSql {
  const sqlite = new DatabaseSync(":memory:");
  for (const statement of USAGE_MIGRATIONS) sqlite.exec(statement);
  return sqlite;
}

const hour = 3_600_000;

test("a yes/no answer lands in a confidence bucket and a failed ask does not", () => {
  const store = db();
  recordUsage(store, {
    at: 1_700_000_000_000,
    caller: "unified-inbox",
    model: "jev-latest",
    questions: {
      line_1: { type: "noul" },
      line_2: { type: "choice" },
    },
    answers: { line_1: { type: "noul", noul: 1 }, line_2: { picked: "a" } },
    inputTokens: 20,
    outputTokens: 4,
    ms: 800,
    ok: true,
  });
  recordUsage(store, {
    at: 1_700_000_000_000 + 1000,
    caller: "tool",
    model: "jev-latest",
    questions: { line_1: { type: "noul" } },
    answers: null,
    inputTokens: null,
    outputTokens: null,
    ms: 50,
    ok: false,
  });
  const report = usageReport(store, {
    now: 1_700_000_000_000 + hour,
    days: 1,
    timeZoneOffsetMinutes: 0,
  });
  assert.equal(report.asks, 2);
  assert.equal(report.failed, 1);
  assert.equal(report.questions, 3);
  assert.equal(report.noul, 2);
  assert.equal(report.choice, 1);
  assert.equal(report.meanNoul, 1);
  assert.equal(report.medianMs, 800);
  assert.equal(report.confidence[9], 1);
  assert.equal(report.confidence.reduce((sum, n) => sum + n, 0), 1);
  assert.deepEqual(report.callers.map((row) => row.caller), ["tool", "unified-inbox"]);
});

test("an empty hour stays in the activity chart", () => {
  const store = db();
  const now = 10 * hour;
  recordUsage(store, {
    at: now - hour,
    caller: "client",
    model: "jev-latest",
    questions: { only: { type: "score" } },
    answers: {},
    inputTokens: 1,
    outputTokens: 1,
    ms: 100,
    ok: true,
  });
  const report = usageReport(store, { now, days: 1, timeZoneOffsetMinutes: 0 });
  assert.equal(report.points.length, 24);
  assert.equal(report.points.filter((point) => point.asks > 0).length, 1);
  assert.equal(report.score, 1);
  assert.equal(usageLine(report), "A typical ask took 100 ms.");
});

test("a backfilled ask with no measured wait is left out of the typical wait", () => {
  const store = db();
  recordUsage(store, {
    at: 1_700_000_000_000,
    caller: "unified-inbox",
    model: "jev-latest",
    questions: { line_1: { type: "noul" } },
    answers: null,
    inputTokens: null,
    outputTokens: null,
    ms: 0,
    ok: true,
  });
  const report = usageReport(store, { now: 1_700_000_000_000 + hour, days: 1, timeZoneOffsetMinutes: 0 });
  assert.equal(report.asks, 1);
  assert.equal(report.medianMs, null);
});

test("a million input tokens cost 4.2 cents and output tokens are free", () => {
  const store = db();
  const at = 1_700_000_000_000;
  recordUsage(store, {
    at,
    caller: "unified-inbox",
    model: "jev-latest",
    questions: { line_1: { type: "noul" } },
    answers: { line_1: { noul: 0.5 } },
    inputTokens: 1_000_000,
    outputTokens: 40,
    ms: 200,
    ok: true,
  });
  recordUsage(store, {
    at: at + 1_000,
    caller: "unified-inbox",
    model: "jev-latest",
    questions: { line_1: { type: "noul" } },
    answers: null,
    inputTokens: null,
    outputTokens: null,
    ms: 0,
    ok: true,
  });
  const report = usageReport(store, { now: at + hour, days: 1, timeZoneOffsetMinutes: 0 });
  assert.ok(Math.abs(inputCostUsd(1_000_000) - 0.042) < 1e-12);
  assert.equal(formatUsd(report.costUsd), "$0.042");
  assert.equal(report.pricedAsks, 1);
  assert.equal(report.unpricedAsks, 1);
  assert.equal(report.failed, 0);
  assert.equal(report.points.find((point) => point.costUsd > 0)?.tokensIn, 1_000_000);
  assert.equal(costLine(report), "$0.042 from 1 ask. 1 earlier ask had no token count.");
});

test("the route and caller names have a stable reading", () => {
  assert.deepEqual(readRoute(""), { days: 7, view: "activity", questionId: null });
  assert.deepEqual(readRoute("30/confidence"), { days: 30, view: "confidence", questionId: null });
  assert.deepEqual(readRoute("1/cost"), { days: 1, view: "cost", questionId: null });
  assert.deepEqual(readRoute("nope/callers"), { days: 7, view: "callers", questionId: null });
  assert.deepEqual(readRoute("7/question"), { days: 7, view: "question", questionId: null });
  assert.deepEqual(readRoute("7/question/attention"), { days: 7, view: "question", questionId: "attention" });
  assert.equal(callerLabel("tool"), "Threads");
  assert.equal(callerLabel("unified-inbox"), "unified-inbox");
});
