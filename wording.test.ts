import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { USAGE_MIGRATIONS, type UsageSql } from "./usage.ts";
import { addWording, deleteWording, ensureWordings, listWordings, saveWording, usedWording, useWording } from "./wording-store.ts";
import { assertWording, DEFAULT_NAME, DEFAULT_WORDING, wordingFrom } from "./wording.ts";

function db(): UsageSql {
  const sqlite = new DatabaseSync(":memory:");
  for (const statement of USAGE_MIGRATIONS) sqlite.exec(statement);
  return sqlite;
}

test("a blank field keeps the original sentence", () => {
  assert.deepEqual(wordingFrom({ question: "  ", yes: "", no: undefined }), DEFAULT_WORDING);
});

test("a saved question is kept and an empty one is refused", () => {
  const saved = wordingFrom({ question: "Does message {n} need a reply?", yes: "Yes.", no: "No." });
  assert.equal(saved.question, "Does message {n} need a reply?");
  assert.throws(() => assertWording({ ...saved, yes: "  " }), /Yes is empty/);
});

test("a start writes the built-in question from the code and leaves a question you added", () => {
  const store = db();
  ensureWordings(store);
  saveWording(store, { id: "attention", name: "Needs attention", question: "Old?", yes: "Old yes.", no: "Old no." });
  ensureWordings(store);
  assert.equal(usedWording(store).question, DEFAULT_WORDING.question);
  assert.equal(usedWording(store).yes, DEFAULT_WORDING.yes);
  assert.equal(usedWording(store).no, DEFAULT_WORDING.no);
  assert.equal(listWordings(store)[0]?.name, "Needs attention");
  const added = addWording(store, "Mine");
  saveWording(store, { id: added.id, name: added.name, question: "Custom?", yes: "Y.", no: "N." });
  ensureWordings(store);
  assert.equal(listWordings(store).find((row) => row.id === added.id)?.question, "Custom?");
});

test("a question keeps the name you give it, and the inbox uses the marked one", () => {
  const store = db();
  ensureWordings(store);
  ensureWordings(store);
  const [first] = listWordings(store);
  assert.equal(first?.name, DEFAULT_NAME);
  assert.equal(first?.used, true);
  const renamed = saveWording(store, { ...first!, name: "  Pay me  " });
  assert.equal(renamed.name, "Pay me");
  const added = addWording(store, "Deadline");
  assert.equal(added.used, false);
  assert.equal(usedWording(store).question, DEFAULT_WORDING.question);
  useWording(store, added.id);
  assert.equal(listWordings(store).find((row) => row.used)?.name, "Deadline");
  assert.throws(() => deleteWording(store, added.id), /inbox is using this/);
  deleteWording(store, first!.id);
  assert.equal(listWordings(store).length, 1);
  assert.throws(() => deleteWording(store, added.id), /at least one/);
});
