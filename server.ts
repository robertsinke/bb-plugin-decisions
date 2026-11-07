import {
  defineRpcContract,
  type BbPluginApi,
  type PluginAgentToolResult,
} from "@get-bb/plugin-sdk";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { askDecision, askInput, askResult, DEFAULT_MODEL, modelSchema, type AskInput, type AskResult } from "./ask.ts";
import { asksFromLog, importLoggedAsks, readAttentionScores } from "./backfill.ts";
import { USAGE_MIGRATIONS, recordUsage, usageReport, type UsageEvent, type UsageSql } from "./usage.ts";
import { addWording, ensureWordings, listWordings, saveWording, usedWording, useWording } from "./wording-store.ts";

const statusResult = z
  .object({
    configured: z.boolean(),
    model: z.string(),
  })
  .strict();

const wordingResult = z.object({
  question: z.string(),
  yes: z.string(),
  no: z.string(),
}).strict();

const namedWording = z.object({
  id: z.string(),
  name: z.string(),
  question: z.string(),
  yes: z.string(),
  no: z.string(),
  used: z.boolean(),
}).strict();

const questionList = z.object({ questions: z.array(namedWording) }).strict();

const usageInput = z.object({ days: z.union([z.literal(1), z.literal(7), z.literal(30)]) }).strict();

const usageResult = z
  .object({
    days: z.union([z.literal(1), z.literal(7), z.literal(30)]),
    from: z.number(),
    to: z.number(),
    asks: z.number(),
    questions: z.number(),
    failed: z.number(),
    tokensIn: z.number(),
    tokensOut: z.number(),
    costUsd: z.number(),
    pricedAsks: z.number(),
    unpricedAsks: z.number(),
    noul: z.number(),
    choice: z.number(),
    score: z.number(),
    meanNoul: z.number().nullable(),
    medianMs: z.number().nullable(),
    points: z.array(z.object({
      start: z.number(),
      asks: z.number(),
      questions: z.number(),
      tokensIn: z.number(),
      tokensOut: z.number(),
      costUsd: z.number(),
    }).strict()),
    callers: z.array(z.object({
      caller: z.string(),
      asks: z.number(),
      questions: z.number(),
    }).strict()),
    confidence: z.array(z.number()).length(10),
  })
  .strict();

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: statusResult,
  },
  ask: {
    input: askInput,
    output: askResult,
  },
  usage: {
    input: usageInput,
    output: usageResult,
  },
  wording: {
    input: z.null(),
    output: wordingResult,
  },
  questions: {
    input: z.null(),
    output: questionList,
  },
  save_question: {
    input: namedWording.omit({ used: true }),
    output: namedWording,
  },
  use_question: {
    input: z.object({ id: z.string() }).strict(),
    output: namedWording,
  },
});

const addQuestionInput = z.object({
  name: z.string().min(1).max(80),
  question: z.string().min(1).max(2_000).optional(),
  yes: z.string().min(1).max(2_000).optional(),
  no: z.string().min(1).max(2_000).optional(),
}).strict();

function toolError(message: string): PluginAgentToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function noteUsage(db: UsageSql, log: (line: string) => void, event: UsageEvent): void {
  try {
    recordUsage(db, event);
  } catch (error) {
    log(error instanceof Error ? error.message : "The usage row could not be saved.");
  }
}

async function loggedAsk(
  db: UsageSql,
  log: (line: string) => void,
  config: { apiKey: string | undefined; model: string; signal?: AbortSignal },
  input: AskInput,
  caller: string,
): Promise<AskResult> {
  const started = Date.now();
  const base = { at: started, caller, questions: input.questions, ms: 0 };
  try {
    const result = await askDecision(config, input);
    noteUsage(db, log, {
      ...base,
      model: result.model,
      answers: result.answers,
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
      ms: Date.now() - started,
      ok: true,
    });
    return result;
  } catch (error) {
    noteUsage(db, log, {
      ...base,
      model: config.model,
      answers: null,
      inputTokens: null,
      outputTokens: null,
      ms: Date.now() - started,
      ok: false,
    });
    throw error;
  }
}

export default function plugin(bb: BbPluginApi) {
  const database = bb.storage.database();
  bb.storage.migrate(database, USAGE_MIGRATIONS);
  const usageDb = database as UsageSql;
  importInboxHistory(usageDb, bb.server.experimental_dataDir, (line) => bb.log.info(line));
  const settings = bb.settings.define({
    apiKey: {
      type: "string",
      label: "TypeSafe API key",
      secret: true,
    },
    model: {
      type: "string",
      label: "Decision model",
      default: DEFAULT_MODEL,
      experimental_schema: modelSchema,
    },
  });
  ensureWordings(usageDb);

  bb.rpc.register(
    rpcContract,
    {
      async status() {
        const { apiKey, model } = await settings.get();
        return { configured: Boolean(apiKey), model };
      },
      async ask(input, context) {
        const { apiKey, model } = await settings.get();
        const caller = context.experimental_caller.kind === "plugin"
          ? context.experimental_caller.pluginId
          : "client";
        bb.log.info(`ask ${Object.keys(input.questions).join(",")}`);
        return loggedAsk(usageDb, (line) => bb.log.warn(`usage: ${line}`), { apiKey, model, signal: context.experimental_signal }, input, caller);
      },
      async usage(input) {
        return usageResult.parse(usageReport(usageDb, {
          now: Date.now(),
          days: input.days,
          timeZoneOffsetMinutes: new Date().getTimezoneOffset(),
        }));
      },
      async wording() {
        return usedWording(usageDb);
      },
      async questions() {
        return { questions: listWordings(usageDb) };
      },
      async save_question(input) {
        return saveWording(usageDb, input);
      },
      async use_question(input) {
        return useWording(usageDb, input.id);
      },
    },
    {
      experimental_discoverable: true,
      experimental_description:
        "Ask the configured TypeSafe decision model. The API key stays in this plugin.",
    },
  );

  bb.agents.registerTool({
    name: "decisions_ask",
    description:
      "Ask the configured decision model, such as Jev, a typed question about supplied state. The model returns probabilities. You decide the action.",
    instructions:
      "Use decisions_ask for a judgment such as a category or a yes/no fact. Do not ask the model what to do next. Another plugin calls RPC method ask on plugin id decisions instead of this tool.",
    presentation: {
      label: {
        pending: "Asking the decision model",
        completed: "Asked the decision model",
      },
    },
    parameters: askInput,
    async execute(input, ctx) {
      try {
        const { apiKey, model } = await settings.get();
        const result = await loggedAsk(usageDb, (line) => bb.log.warn(`usage: ${line}`), { apiKey, model, signal: ctx.signal }, input, "tool");
        return JSON.stringify(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : "The decision request failed.";
        return toolError(message);
      }
    },
  });

  bb.agents.registerTool({
    name: "decisions_add_question",
    description: "Add a named ask. The Decisions page edits it. The inbox keeps using the ask already marked in use.",
    parameters: addQuestionInput,
    async execute(input) {
      try {
        const created = addWording(usageDb, input.name);
        const stored = input.question || input.yes || input.no
          ? saveWording(usageDb, {
            id: created.id,
            name: created.name,
            question: input.question ?? created.question,
            yes: input.yes ?? created.yes,
            no: input.no ?? created.no,
          })
          : created;
        return JSON.stringify({ id: stored.id, name: stored.name, used: stored.used });
      } catch (error) {
        return toolError(error instanceof Error ? error.message : "The ask could not be added.");
      }
    },
  });

  const usage = "Usage: bb decisions status [--json]\n";
  bb.cli.register({
    name: "decisions",
    summary: "Show the configured decision model",
    commands: [
      {
        name: "status",
        summary: "Show the model and whether the API key is set",
        usage: "bb decisions status [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const command = argv.find((arg) => arg !== "--json");
      if (command !== undefined && command !== "status") {
        return { exitCode: 1, stderr: usage };
      }
      const { apiKey, model } = await settings.get();
      const status = { configured: Boolean(apiKey), model };
      if (json) return { exitCode: 0, stdout: `${JSON.stringify(status)}\n` };
      const keyLine = status.configured
        ? "API key: set"
        : "API key: not set. Run: bb plugin config decisions set apiKey <key>";
      return { exitCode: 0, stdout: `Model: ${status.model}\n${keyLine}\n` };
    },
  });
}

/** The plugin log names every past ask. The inbox still holds the scores from the latest pass. */
function importInboxHistory(db: UsageSql, dataDir: string, log: (line: string) => void): void {
  try {
    const asks = asksFromLog(readFileSync(path.join(dataDir, "plugins", "decisions", "logs", "plugin.log"), "utf8"));
    const scores = readAttentionScores(path.join(dataDir, "plugins", "unified-inbox", "data.db"));
    const count = importLoggedAsks(db, asks, scores);
    if (count > 0) log(`Imported ${count} earlier inbox asks and ${scores.length} kept scores.`);
  } catch (error) {
    log(error instanceof Error ? error.message : "Earlier inbox asks could not be imported.");
  }
}
