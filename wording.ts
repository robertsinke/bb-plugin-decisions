/** The question the inbox sends. `{n}` is the message number, or “the preview” when there is no thread. */
export const DEFAULT_NAME = "Needs attention";

export const DEFAULT_WORDING = {
  question: "Messages are in order. Look only at message {n}. Does that one message still need the reader to act?",
  yes: "It asks the reader to reply, decide, pay, or fix something, and no later message settles that point.",
  no: "It does not ask the reader. Their own message does not ask them, unless it leaves a task they have not done. A later message settles it when the other person answers, or when the reader replies. Read or unread is not evidence.",
};

export interface Wording {
  question: string;
  yes: string;
  no: string;
}

export interface NamedWording extends Wording {
  id: string;
  name: string;
  used: boolean;
}

const MAX = 2_000;

export function wordingFrom(value: { question?: string; yes?: string; no?: string } | null | undefined): Wording {
  return {
    question: sentence(value?.question, DEFAULT_WORDING.question),
    yes: sentence(value?.yes, DEFAULT_WORDING.yes),
    no: sentence(value?.no, DEFAULT_WORDING.no),
  };
}

export function assertWording(value: Wording): Wording {
  return {
    question: required(value.question, "Question"),
    yes: required(value.yes, "Yes"),
    no: required(value.no, "No"),
  };
}

function sentence(value: string | undefined, fallback: string): string {
  const text = value?.trim() ?? "";
  return text ? text.slice(0, MAX) : fallback;
}

function required(value: string, label: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${label} is empty.`);
  if (text.length > MAX) throw new Error(`${label} is longer than ${MAX} characters.`);
  return text;
}

const NAME_MAX = 80;

export function assertName(value: string): string {
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) throw new Error("Name is empty.");
  if (name.length > NAME_MAX) throw new Error(`Name is longer than ${NAME_MAX} characters.`);
  return name;
}

