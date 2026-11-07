import { TypeSafeClient, TypeSafeError, type Fetch } from "@typesafe-ai/sdk";
import { z } from "zod";

/** Alias that tracks the current stable Jev release. */
export const DEFAULT_MODEL = "jev-latest";

const MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const modelSchema = z.string().regex(MODEL_PATTERN, "Use a model id such as jev-latest.");

const text = z.string().max(8_000);
const stateSchema = z.union([
  z.string().min(1).max(200_000),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
]);

const questionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("noul"),
      instructions: text.optional(),
      criteria: z
        .object({
          true: text.optional(),
          false: text.optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("choice"),
      instructions: text.optional(),
      criteria: z.record(z.string(), text.nullable()),
    })
    .strict(),
  z
    .object({
      type: z.literal("score"),
      instructions: text.optional(),
      criteria: z.array(text).min(2).max(10),
    })
    .strict(),
]);

export const askInput = z
  .object({
    state: stateSchema,
    questions: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), questionSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    const count = Object.keys(value.questions).length;
    if (count < 1 || count > 32) {
      ctx.addIssue({
        code: "custom",
        path: ["questions"],
        message: "Send 1 to 32 questions.",
      });
    }
    if (JSON.stringify(value).length > 200_000) {
      ctx.addIssue({
        code: "custom",
        message: "The request is larger than 200000 characters.",
      });
    }
  });

export type AskInput = z.infer<typeof askInput>;

export const askResult = z
  .object({
    model: z.string(),
    answers: z.record(z.string(), z.unknown()),
    usage: z
      .object({
        input_tokens: z.number().nullable(),
        output_tokens: z.number().nullable(),
      })
      .strict(),
  })
  .strict();

export type AskResult = z.infer<typeof askResult>;

const MISSING_KEY =
  "The Decisions API key is not set. Set it with: bb plugin config decisions set apiKey <key>";

export async function askDecision(
  config: {
    apiKey: string | undefined;
    model: string;
    signal?: AbortSignal;
    fetch?: Fetch;
  },
  input: AskInput,
): Promise<AskResult> {
  if (!config.apiKey) throw new Error(MISSING_KEY);
  const client = new TypeSafeClient({
    apiKey: config.apiKey,
    defaultModel: config.model,
    logLevel: "off",
    timeout: 20_000,
    fetch: config.fetch,
  });
  try {
    const result = await client.systemOne(
      {
        state: input.state,
        questions: input.questions,
        model: config.model,
      } as Parameters<TypeSafeClient["systemOne"]>[0],
      { signal: config.signal },
    );
    return askResult.parse({
      model: result.model,
      answers: result.answers,
      usage: result.usage,
    });
  } catch (error) {
    if (error instanceof TypeSafeError) throw new Error(error.message);
    throw error;
  }
}
