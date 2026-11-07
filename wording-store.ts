import { randomBytes } from "node:crypto";
import type { UsageSql } from "./usage.ts";
import { assertName, assertWording, DEFAULT_NAME, DEFAULT_WORDING, type NamedWording, type Wording } from "./wording.ts";

interface WordingRow {
  id: string;
  name: string;
  question: string;
  yes: string;
  no: string;
  used: number;
  sort: number;
}

function named(row: WordingRow): NamedWording {
  return {
    id: row.id,
    name: row.name,
    question: row.question,
    yes: row.yes,
    no: row.no,
    used: row.used === 1,
  };
}

/** One named question, so the inbox has something to ask before anyone renames it. */
export function ensureWordings(db: UsageSql): void {
  const count = db.prepare("SELECT COUNT(*) AS n FROM decision_wording").get() as { n: number };
  if (count.n > 0) return;
  db.prepare("INSERT INTO decision_wording (id, name, question, yes, no, used, sort) VALUES (?, ?, ?, ?, ?, 1, 0)").run(
    "attention",
    DEFAULT_NAME,
    DEFAULT_WORDING.question,
    DEFAULT_WORDING.yes,
    DEFAULT_WORDING.no,
  );
}

export function listWordings(db: UsageSql): NamedWording[] {
  const rows = db.prepare("SELECT id, name, question, yes, no, used, sort FROM decision_wording ORDER BY sort, name").all() as WordingRow[];
  return rows.map(named);
}

/** The sentences the inbox sends. A name change does not change this. */
export function usedWording(db: UsageSql): Wording {
  const row = db.prepare("SELECT id, name, question, yes, no, used, sort FROM decision_wording WHERE used = 1 ORDER BY sort LIMIT 1").get() as WordingRow | undefined;
  const chosen = row ?? (db.prepare("SELECT id, name, question, yes, no, used, sort FROM decision_wording ORDER BY sort LIMIT 1").get() as WordingRow | undefined);
  if (!chosen) return DEFAULT_WORDING;
  return { question: chosen.question, yes: chosen.yes, no: chosen.no };
}

export function saveWording(db: UsageSql, input: { id: string; name: string; question: string; yes: string; no: string }): NamedWording {
  const name = assertName(input.name);
  const wording = assertWording(input);
  const current = db.prepare("SELECT id, name, question, yes, no, used, sort FROM decision_wording WHERE id = ?").get(input.id) as WordingRow | undefined;
  if (!current) throw new Error("That question is gone.");
  db.prepare("UPDATE decision_wording SET name = ?, question = ?, yes = ?, no = ? WHERE id = ?").run(name, wording.question, wording.yes, wording.no, input.id);
  return named({ ...current, name, ...wording });
}

export function addWording(db: UsageSql, name: string): NamedWording {
  const clean = assertName(name);
  const sort = (db.prepare("SELECT COALESCE(MAX(sort), -1) AS sort FROM decision_wording").get() as { sort: number }).sort + 1;
  const used = (db.prepare("SELECT COUNT(*) AS n FROM decision_wording").get() as { n: number }).n === 0 ? 1 : 0;
  const row: WordingRow = {
    id: randomBytes(8).toString("hex"),
    name: clean,
    question: DEFAULT_WORDING.question,
    yes: DEFAULT_WORDING.yes,
    no: DEFAULT_WORDING.no,
    used,
    sort,
  };
  db.prepare("INSERT INTO decision_wording (id, name, question, yes, no, used, sort) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    row.id, row.name, row.question, row.yes, row.no, row.used, row.sort,
  );
  return named(row);
}

export function useWording(db: UsageSql, id: string): NamedWording {
  const current = db.prepare("SELECT id, name, question, yes, no, used, sort FROM decision_wording WHERE id = ?").get(id) as WordingRow | undefined;
  if (!current) throw new Error("That question is gone.");
  db.prepare("UPDATE decision_wording SET used = CASE WHEN id = ? THEN 1 ELSE 0 END").run(id);
  return named({ ...current, used: 1 });
}

export function deleteWording(db: UsageSql, id: string): void {
  const current = db.prepare("SELECT used FROM decision_wording WHERE id = ?").get(id) as { used: number } | undefined;
  if (!current) throw new Error("That question is gone.");
  const count = db.prepare("SELECT COUNT(*) AS n FROM decision_wording").get() as { n: number };
  if (count.n <= 1) throw new Error("Keep at least one question.");
  if (current.used === 1) throw new Error("The inbox is using this. Choose another first.");
  db.prepare("DELETE FROM decision_wording WHERE id = ?").run(id);
}
