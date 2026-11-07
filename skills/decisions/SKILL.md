---
name: decisions
description: >
  Ask the configured TypeSafe decision model (Jev by default) for a typed judgment.
  Use when classifying text, scoring a message, or choosing among named options,
  including from another BB plugin such as unified-inbox.
---

# Decisions

This plugin holds the TypeSafe API key and the model id. Callers send state and questions. The model returns probabilities. The caller decides the action.

The API key is a secret plugin setting. It is not an environment variable. BB prints provider environment values in the timeline, so this plugin does not inject `TYPESAFE_API_KEY`.

## Settings

- `apiKey` — TypeSafe API key. Secret. Set it with `bb plugin config decisions set apiKey <key>`.
- `model` — model id. Default `jev-latest`. Examples: `jev-1.14.0`, `jev-1.13.0`.

`bb decisions status` prints the model and whether the key is set. It does not print the key.

## From another plugin

Call RPC method `ask` on plugin id `decisions`. Read the key and the model only inside this plugin.

```ts
const result = await bb.sdk.plugins.callRpc({
  pluginId: "decisions",
  method: "ask",
  input: {
    state: { from, subject, body },
    questions: {
      billing: {
        type: "noul",
        instructions: "Is this message about a charge or a payment?",
      },
    },
  },
  outputSchema,
});
```

`outputSchema` must accept `{ model, answers, usage }`. `usage.input_tokens` and `usage.output_tokens` are numbers or null. Each answer has `type`: `noul`, `choice`, or `score`.

Method `status` takes `null` and returns `{ configured, model }`.

A question is one judgment:

- `noul` — yes/no. Read `answers.<name>.noul` (0 to 1). Start with yes above 0.7 and no below 0.3.
- `choice` — one option. `criteria` is a map of option name to a short description, or null.
- `score` — an ordered rubric. `criteria` is 2 to 10 level descriptions.

Send 1 to 32 questions. A request larger than 200000 characters is rejected. Image and box questions are not accepted yet.

unified-inbox classification belongs in unified-inbox. That plugin sends the message as `state`, asks one `noul` or `choice` per fact, and keeps the truth table that maps those answers to a label.

## From a thread

Use the `decisions_ask` tool with the same `state` and `questions` object. Ask what is true. Do not ask the model which action to take.

`decisions_add_question` stores a named ask (`name`, and optional `question`, `yes`, `no`). The Decisions page edits it. It does not replace the ask the inbox is already using.
