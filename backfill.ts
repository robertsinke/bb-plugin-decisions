import { DatabaseSync } from "node:sqlite";
import { recordUsage, type UsageSql } from "./usage.ts";

const IMPORT_ID = "unified-inbox";

export interface LoggedAsk {
  at: number;
  keys: string[];
}

/** One decisions log line is one ask. The line names the question keys and nothing else. */
export function asksFromLog(text: string): LoggedAsk[] {
  const asks: LoggedAsk[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let row: { ts?: unknown; message?: unknown };
    try {
      row = JSON.parse(line) as { ts?: unknown; message?: unknown };
    } catch {
      continue;
    }
    if (typeof row.ts !== "number" || typeof row.message !== "string") continue;
    const match = /^ask (\S+)$/.exec(row.message);
    if (!match) continue;
    const keys = match[1].split(",").filter((key) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key));
    if (keys.length === 0) continue;
    asks.push({ at: row.ts, keys });
  }
  return asks;
}

/**
 * Scores still stored for a conversation. A cleared label keeps the model's
 * earlier scores on `held`; those are the answers the API returned.
 */
export function scoresFromAttention(rows: Array<{ lines: string | null; noul: number }>): number[] {
  const scores: number[] = [];
  for (const row of rows) {
    const kept = keptScores(row.lines);
    if (kept.length > 0) scores.push(...kept);
    else if (row.noul >= 0 && row.noul <= 1) scores.push(row.noul);
  }
  return scores;
}

export function readAttentionScores(inboxDbPath: string): number[] {
  const inbox = new DatabaseSync(inboxDbPath, { readOnly: true });
  try {
    const rows = inbox.prepare("SELECT lines, noul FROM inbox_attention").all() as Array<{ lines: string | null; noul: number }>;
    return scoresFromAttention(rows);
  } finally {
    inbox.close();
  }
}

/** Log asks become usage rows. Kept scores land on one row so the histogram is not repeated. */
export function importLoggedAsks(db: UsageSql, asks: LoggedAsk[], scores: number[]): number {
  const done = db.prepare("SELECT 1 AS ok FROM decision_usage_import WHERE id = ?").get(IMPORT_ID);
  if (done) return 0;
  db.exec("BEGIN");
  try {
    for (const ask of asks) {
      const questions: Record<string, { type: string }> = {};
      for (const key of ask.keys) questions[key] = { type: "noul" };
      recordUsage(db, {
        at: ask.at,
        caller: "unified-inbox",
        model: "jev-latest",
        questions,
        answers: null,
        inputTokens: null,
        outputTokens: null,
        ms: 0,
        ok: true,
      });
    }
    if (scores.length > 0) {
      const hist = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      let sum = 0;
      for (const score of scores) {
        const bucket = Math.min(9, Math.max(0, Math.floor(score * 10)));
        hist[bucket] += 1;
        sum += score;
      }
      db.prepare(`UPDATE decision_usage SET noul_sum = ?, hist = ? WHERE id = (
        SELECT id FROM decision_usage WHERE caller = 'unified-inbox' AND ms = 0 ORDER BY at DESC, id DESC LIMIT 1
      )`).run(sum, hist.join(","));
    }
    db.prepare("INSERT INTO decision_usage_import (id) VALUES (?)").run(IMPORT_ID);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return asks.length;
}

function keptScores(lines: string | null): number[] {
  if (!lines) return [];
  try {
    const parsed = JSON.parse(lines) as { scores?: unknown; held?: { scores?: unknown } };
    const bag = parsed.held?.scores ?? parsed.scores;
    if (!bag || typeof bag !== "object") return [];
    return Object.values(bag).filter((score): score is number => typeof score === "number" && score >= 0 && score <= 1);
  } catch {
    return [];
  }
}
