import assert from "node:assert/strict";
import test from "node:test";
import type { Fetch } from "@typesafe-ai/sdk";
import { askDecision, askInput } from "./ask.ts";

const billing = {
  state: { subject: "Charged twice", body: "Please refund the second charge." },
  questions: {
    billing: {
      type: "noul" as const,
      instructions: "Is this message about a charge or a payment?",
    },
  },
};

test("a request uses the configured model and does not accept a caller model", async () => {
  let seen: { url: string; body: unknown; authorization: string | null } | undefined;
  const fetchImpl: Fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    seen = {
      url,
      body: JSON.parse(String(init?.body)),
      authorization: headers.get("authorization"),
    };
    return new Response(
      JSON.stringify({
        model: "jev-1.14.0",
        answers: { billing: { type: "noul", noul: 0.91 } },
        usage: { input_tokens: 20, output_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const result = await askDecision(
    { apiKey: "test-key", model: "jev-1.14.0", fetch: fetchImpl },
    billing,
  );

  assert.equal(seen?.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(seen?.authorization, "Bearer test-key");
  assert.deepEqual(seen?.body, { ...billing, model: "jev-1.14.0" });
  assert.equal(result.model, "jev-1.14.0");
  assert.deepEqual(result.answers.billing, { type: "noul", noul: 0.91 });
});

test("a missing API key fails before any request", async () => {
  let called = false;
  const fetchImpl: Fetch = async () => {
    called = true;
    throw new Error("fetch should not run");
  };
  await assert.rejects(
    () => askDecision({ apiKey: undefined, model: "jev-latest", fetch: fetchImpl }, billing),
    /API key is not set/,
  );
  assert.equal(called, false);
});

test("a score needs at least two levels", () => {
  const parsed = askInput.safeParse({
    state: "hello",
    questions: { urgency: { type: "score", criteria: ["now"] } },
  });
  assert.equal(parsed.success, false);
});
