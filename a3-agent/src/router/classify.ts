import type { TaskProperties, TaskType } from "./types.ts";

export interface ClassifierOptions {
  /** Prompts longer than this many characters need the cloud model's context window. */
  readonly longContextChars: number;
  /** Prompts at or under this many characters can count as "simple". */
  readonly simpleMaxChars: number;
}

export interface ClassifierInput {
  readonly text: string;
  /** Number of document/audio/video attachments (images do not force long context). */
  readonly heavyAttachments?: number;
}

/**
 * Privacy markers. Matching is keyword-based on purpose: a deterministic classifier can be
 * unit-tested and never needs a model call to decide whether text may leave the machine.
 * It over-matches by design (a false "private" costs a local answer, a miss costs a leak).
 */
const PRIVACY_PATTERNS: readonly RegExp[] = [
  /\[private\]|#private\b/i,
  /\b(password|passcode|passphrase|pin code|2fa code|recovery code|api key|secret key)\b/i,
  /\b(ssn|social security|passport|driver'?s licen[cs]e)\b/i,
  /\b(bank account|routing number|credit card|debit card|card number|salary|paycheck|tax return)\b/i,
  /\b(diagnos(is|ed)|medical|prescription|medication|therapy|therapist|health record|symptom)\b/i,
  /\b(confidential|private note|don'?t share|do not share|keep (this|it) private|just between us)\b/i,
  // Access codes in everyday wording ("my gym locker code", "the door code", "my PIN").
  // Deliberately not a bare "code": "debug my Python code" must not count as private.
  /\b(locker|door|gate|garage|alarm|safe|lock|access|security|entry|unlock|verification|login)\s+(code|pin|combination|combo)\b/i,
  /\b(my|our) pin\b|\bpin number\b/i,
  /\b(home address|date of birth)\b/i,
];

const REASONING_PATTERNS: readonly RegExp[] = [
  /\b(analy[sz]e|analysis|compare|contrast|evaluate|critique|trade-?offs?)\b/i,
  /\b(step[- ]by[- ]step|reason through|think through|prove|derive|justify)\b/i,
  /\b(plan|strategy|design|architect|debug|refactor|optimi[sz]e)\b/i,
  /\b(explain why|why (is|does|do|did|are|would)|pros and cons)\b/i,
  /\b(write (an?|the) (essay|report|proposal)|research)\b/i,
];

/**
 * Requests that need a live tool. Gemma e4b handles short chat well but is unreliable at
 * multi-step tool calls on OpenClaw's ~21k-token base prompt, so these go to the cloud
 * unless the request is private or the cloud is rate-limited.
 */
const TOOL_PATTERNS: readonly RegExp[] = [
  /\b(calendar|schedule|agenda|meetings?|events?|appointments?|free ?busy|availability)\b/i,
  /\b(e-?mails?|inbox|gmail|unread|drafts?|mailbox)\b/i,
  /\b(search (the web|online|for)|look (it )?up|google it|browse|latest|news|headlines)\b/i,
  /\b(weather|forecast|temperature|rain)\b/i,
];

export function classifyTask(input: ClassifierInput, opts: ClassifierOptions): TaskProperties {
  const text = input.text;
  const privacy_sensitive = PRIVACY_PATTERNS.some((p) => p.test(text));
  const reasoning_heavy = REASONING_PATTERNS.some((p) => p.test(text));
  const needs_long_context =
    text.length > opts.longContextChars || (input.heavyAttachments ?? 0) > 0;
  const needs_tools = TOOL_PATTERNS.some((p) => p.test(text));
  const simple =
    !reasoning_heavy && !needs_long_context && !needs_tools && text.length <= opts.simpleMaxChars;
  return { privacy_sensitive, reasoning_heavy, needs_long_context, simple, needs_tools };
}

/** Coarse label for the routing log. Never derived from, and never contains, message text. */
export function taskTypeOf(task: TaskProperties): TaskType {
  if (task.privacy_sensitive) return "private";
  if (task.reasoning_heavy) return "reasoning";
  if (task.needs_long_context) return "long_context";
  if (task.needs_tools) return "tool_use";
  if (task.simple) return "simple";
  return "general";
}
