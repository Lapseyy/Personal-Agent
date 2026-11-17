import { classifyGogArgv, type GogAction, type GogPolicyOptions } from "./gogPolicy.ts";
import { extractJsStrings, findGogInvocations, type GogInvocations } from "./shell.ts";
import type { ApprovalTokenStore } from "./tokens.ts";

export interface ApprovalLogEntry {
  readonly ts: string;
  readonly decision:
    | "allowed_read"
    | "allowed_approved"
    | "passed_unparsed"
    | "blocked"
    | "blocked_scheduled"
    | "approval_requested"
    | "approved"
    | "denied";
  /** Command path such as "gmail send". Never message text or addresses. */
  readonly action: string;
  readonly recipients_count: number;
}

export interface ApprovalRequest {
  readonly title: string;
  readonly description: string;
  readonly severity: "warning";
  readonly timeoutMs: number;
  readonly timeoutReason: string;
  readonly allowedDecisions: ("allow-once" | "deny")[];
  readonly onResolution: (decision: string) => void;
}

export type GateResult =
  | undefined
  | { block: true; blockReason: string }
  | { requireApproval: ApprovalRequest };

export interface GateDeps {
  readonly policy: GogPolicyOptions;
  readonly tokens: ApprovalTokenStore;
  readonly log: (entry: ApprovalLogEntry) => void;
  readonly now: () => number;
  /** How long an approval stays usable by the wrapper. */
  readonly tokenTtlMs: number;
  /** How long the human has to answer. */
  readonly approvalTimeoutMs: number;
}

/**
 * Words that mean a gog command could send or change something. Text that mentions gog in a
 * form the parser cannot read is blocked only if it also contains one of these (or names the
 * real binary). Anything else, such as `which gog` or `gog --help | head`, passes: the gog
 * wrapper still refuses every send or change that has no approval token.
 */
const WRITE_HINT =
  /\b(send|forward|reply|reply-all|autoreply|create|update|delete|remove|rm|trash|modify|move|archive|mark|label|batch|import|insert|patch|respond|accept|decline|settings|track|filters?)\b|gog-real|libexec/i;

/**
 * Gog calls in one tool parameter. A shell command is parsed directly; if that finds none,
 * the text is treated as JavaScript (the code tool) and each string literal is parsed.
 */
function invocationsIn(text: string): GogInvocations {
  const direct = findGogInvocations(text);
  if (direct.calls.length > 0) return direct;
  const calls: (readonly string[])[] = [];
  let suspicious = false;
  for (const lit of extractJsStrings(text)) {
    if (!/gog/.test(lit)) continue;
    const inner = findGogInvocations(lit);
    calls.push(...inner.calls);
    suspicious ||= inner.suspicious;
  }
  if (calls.length > 0) return { calls, suspicious, heads: direct.heads };
  return direct;
}

/** Run triggers that came from a person. Everything else is a scheduled or system run. */
const INTERACTIVE_TRIGGERS = new Set(["user", "manual"]);

function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (typeof value === "string") out.push(value);
  else if (depth < 6 && Array.isArray(value))
    for (const v of value) collectStrings(v, out, depth + 1);
  else if (depth < 6 && value !== null && typeof value === "object") {
    for (const v of Object.values(value)) collectStrings(v, out, depth + 1);
  }
}

/**
 * Human-approval gate (before_tool_call). Looks at every tool call's parameters for `gog`
 * commands. Reads and drafts pass. A send or change is paused until the human answers in
 * chat; only "allow once" writes the single-use token the gog wrapper requires. Scheduled
 * runs can never get that far: they are blocked without asking.
 */
export class ApprovalGate {
  readonly #deps: GateDeps;
  readonly #triggers = new Map<string, string>();

  constructor(deps: GateDeps) {
    this.#deps = deps;
  }

  /** Remember how each run started (from the agent hook context). */
  noteRunTrigger(runId: string | undefined, trigger: string | undefined): void {
    if (runId === undefined || trigger === undefined) return;
    if (this.#triggers.size >= 500) {
      const oldest = this.#triggers.keys().next().value;
      if (oldest !== undefined) this.#triggers.delete(oldest);
    }
    this.#triggers.set(runId, trigger);
  }

  #log(
    decision: ApprovalLogEntry["decision"],
    action: GogAction | { label: string; recipients: readonly string[] },
  ): void {
    this.#deps.log({
      ts: new Date(this.#deps.now()).toISOString(),
      decision,
      action: action.label,
      recipients_count: action.recipients.length,
    });
  }

  onBeforeToolCall(params: unknown, runId: string | undefined): GateResult {
    const strings: string[] = [];
    collectStrings(params, strings);
    const actions: GogAction[] = [];
    let suspicious = false;
    const unparsedHeads: string[] = [];
    for (const text of strings) {
      if (!/gog/.test(text)) continue;
      const found = invocationsIn(text);
      if (found.suspicious) {
        if (WRITE_HINT.test(text)) suspicious = true;
        else unparsedHeads.push(...found.heads);
      }
      for (const argv of found.calls) actions.push(classifyGogArgv(argv, this.#deps.policy));
    }
    if (unparsedHeads.length > 0) {
      this.#log("passed_unparsed", {
        label: [...new Set(unparsedHeads)].join(" "),
        recipients: [],
      });
    }
    if (actions.length === 0 && !suspicious) return undefined;

    const refused = actions.find((a) => a.kind === "blocked");
    if (refused !== undefined) {
      this.#log("blocked", refused);
      return {
        block: true,
        blockReason: `Blocked by the approval gate: ${refused.reason ?? "not allowed"}.`,
      };
    }
    // The same command often appears in several parameters of one call (the code tool's
    // source, a title, a summary). Identical actions count once; the wrapper still lets an
    // approval run only one send, so a loop that really sends twice gets one send at most.
    const seen = new Set<string>();
    const gated = actions.filter((a) => {
      if (a.kind !== "send" && a.kind !== "mutate") return false;
      const key = `${a.kind}|${a.label}|${[...a.recipients].sort().join(",")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (gated.length === 0 && !suspicious) {
      for (const a of actions) this.#log("allowed_read", a);
      return undefined;
    }
    if (suspicious || gated.length > 1) {
      const what = {
        label: suspicious ? "unparsed gog command" : "multiple actions",
        recipients: [],
      };
      this.#log("blocked", what);
      return {
        block: true,
        blockReason:
          "Blocked by the approval gate: run one plain `gog ...` command per tool call so the user can approve it.",
      };
    }
    const action = gated[0] as GogAction;
    const trigger = runId === undefined ? undefined : this.#triggers.get(runId);
    if (trigger !== undefined && !INTERACTIVE_TRIGGERS.has(trigger)) {
      this.#log("blocked_scheduled", action);
      return {
        block: true,
        blockReason:
          "Blocked by the approval gate: scheduled runs may only read and draft. Tell the user what you would do and ask them.",
      };
    }

    const kind = action.kind === "send" ? "send" : "mutate";
    if (this.#deps.tokens.pending(kind, action.recipients)) {
      // Already approved by the human moments ago (e.g. the code tool's inner exec):
      // do not ask twice. The wrapper still consumes the token, so it runs only once.
      this.#log("allowed_approved", action);
      return undefined;
    }
    this.#log("approval_requested", action);
    return {
      requireApproval: {
        title: action.kind === "send" ? "Send this email?" : `Allow "${action.label}"?`,
        description:
          action.kind === "send"
            ? `The assistant wants to run "${action.label}" to: ${action.recipients.join(", ")}.`
            : `The assistant wants to run "${action.label}", which changes your mail or calendar.`,
        severity: "warning",
        timeoutMs: this.#deps.approvalTimeoutMs,
        timeoutReason: "No answer from the user, so nothing was sent or changed.",
        allowedDecisions: ["allow-once", "deny"],
        onResolution: (decision) => {
          if (decision === "allow-once") {
            this.#deps.tokens.grant(kind, action.recipients, this.#deps.tokenTtlMs);
            this.#log("approved", action);
          } else {
            this.#log("denied", action);
          }
        },
      },
    };
  }
}
