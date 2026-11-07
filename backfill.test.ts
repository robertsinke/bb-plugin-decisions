import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { asksFromLog, importLoggedAsks, scoresFromAttention } from "./backfill.ts";
import { USAGE_MIGRATIONS, usageReport, type UsageSql } from "./usage.ts";

function db(): UsageSql {
  const sqlite = new DatabaseSync(":memory:");
  for (const statement of USAGE_MIGRATIONS) sqlite.exec(statement);
  return sqlite;
}

test("a log line is one ask and a cleared label keeps the earlier scores", () => {
  const asks = asksFromLog([
    JSON.stringify({ ts: 100, level: "info", message: "ask line_1,line_2" }),
    JSON.stringify({ ts: 100, level: "info", message: "ask needs_attention" }),
    "{\"nope\"",
  ].join("\n"));
  assert.deepEqual(asks, [
    { at: 100, keys: ["line_1", "line_2"] },
    { at: 100, keys: ["needs_attention"] },
  ]);
  const scores = scoresFromAttention([
    { lines: JSON.stringify({ scores: { a: 0.1 }, held: { noul: 0.9, scores: { a: 0.91 } } }), noul: 0.3 },
    { lines: null, noul: 0.2 },
  ]);
  assert.deepEqual(scores, [0.91, 0.2]);
});

test("imported asks share one copy of the kept scores", () => {
  const store = db();
  const at = 1_700_000_000_000;
  const count = importLoggedAsks(store, [
    { at, keys: ["line_1"] },
    { at, keys: ["line_1", "line_2"] },
  ], [0.1, 1]);
  assert.equal(count, 2);
  assert.equal(importLoggedAsks(store, [{ at, keys: ["line_1"] }], [0.5]), 0);
  const report = usageReport(store, { now: at + 3_600_000, days: 1, timeZoneOffsetMinutes: 0 });
  assert.equal(report.asks, 2);
  assert.equal(report.questions, 3);
  assert.equal(report.medianMs, null);
  assert.equal(report.confidence[1], 1);
  assert.equal(report.confidence[9], 1);
  assert.equal(report.meanNoul, 0.55);
  assert.equal(report.callers[0]?.caller, "unified-inbox");
});
