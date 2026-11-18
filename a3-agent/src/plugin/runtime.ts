import type { Settings } from "../config/settings.ts";
import type { RoutingLogEntry } from "../logging/routingLog.ts";
import { classifyTask, taskTypeOf } from "../router/classify.ts";
import {
  CloudCooldown,
  classifyModelError,
  isAbortError,
  type ErrorClass,
} from "../router/cooldown.ts";
import { decideRoute } from "../router/decide.ts";
import type { PrivateSessionStore } from "../router/privateSessions.ts";
import type { Route, RuleId, TaskType } from "../router/types.ts";

export interface RuntimeDeps {
  readonly settings: Settings;
  readonly localHealthy: () => Promise<boolean>;
  readonly rateLimitFlagPresent: () => boolean;
  readonly privateSessions: PrivateSessionStore;
  readonly log: (entry: RoutingLogEntry) => void;
  readonly now: () => number;
  readonly newRequestId: () => string;
}

interface PendingRun {
  readonly requestId: string;
  readonly startedAt: number;
  readonly taskType: TaskType;
  readonly privacySensitive: boolean;
  route: Route;
  rule: RuleId;
  model: string;
  lastOutcome: "completed" | "error" | undefined;
  errorClass: ErrorClass;
  logged: boolean;
}

export interface ModelOverride {
  readonly providerOverride: string;
  readonly modelOverride: string;
}

export interface BlockDecision {
  readonly outcome: "block";
  readonly reason: string;
  readonly message: string;
  readonly category: string;
}

const MAX_PENDING = 500;
/** A short follow-up within this long of a tool-using turn stays on the same (cloud) route. */
const TOOL_SESSION_MS = 15 * 60_000;
/** A run with no agent_end after this long is logged as failed (see #sweepStale). */
const STALE_RUN_MS = 15 * 60_000;

/**
 * Framework-free router orchestration. The OpenClaw plugin (index.ts) is a thin adapter that
 * forwards hook events here, so every policy below is unit-tested without a gateway.
 */
export class RouterRuntime {
  readonly #deps: RuntimeDeps;
  readonly #cooldown: CloudCooldown;
  /** sessionRef -> time of the last tool-using turn. In memory: a restart simply forgets it. */
  readonly #toolSessions = new Map<string, number>();
  /** Same mechanism for the local model: a failed call stops further local routing for a while. */
  readonly #localCooldown: CloudCooldown;
  readonly #pending = new Map<string, PendingRun>();

  constructor(deps: RuntimeDeps) {
    this.#deps = deps;
    this.#cooldown = new CloudCooldown(deps.settings.cloudCooldownMs, deps.now);
    this.#localCooldown = new CloudCooldown(deps.settings.localCooldownMs, deps.now);
  }

  #cloudRateLimited(): boolean {
    return (
      this.#deps.settings.simulateCloud429 ||
      this.#deps.rateLimitFlagPresent() ||
      this.#cooldown.isActive()
    );
  }

  /**
   * Local is usable only if the health probe passes AND no local call failed recently.
   * A probe can pass while real prompts hang, so a failed call counts as evidence too.
   */
  async #localAvailable(): Promise<boolean> {
    if (this.#localCooldown.isActive()) return false;
    return this.#deps.localHealthy();
  }

  #classify(text: string, heavyAttachments: number) {
    return classifyTask(
      { text, heavyAttachments },
      {
        longContextChars: this.#deps.settings.longContextChars,
        simpleMaxChars: this.#deps.settings.simpleMaxChars,
      },
    );
  }

  #emit(run: PendingRun, success: boolean, latencyMs: number): void {
    if (run.logged) return;
    run.logged = true;
    this.#deps.log({
      ts: new Date(this.#deps.now()).toISOString(),
      request_id: run.requestId,
      task_type: run.taskType,
      route: run.route,
      rule: run.rule,
      model: run.route === "held" ? "none" : run.model,
      success,
      latency_ms: Math.max(0, Math.round(latencyMs)),
      error_class: run.errorClass,
    });
  }

  #remember(runKey: string, run: PendingRun): void {
    if (this.#pending.size >= MAX_PENDING) {
      const oldestKey = this.#pending.keys().next().value;
      if (oldestKey !== undefined) {
        const oldest = this.#pending.get(oldestKey);
        if (oldest !== undefined && !oldest.logged) {
          oldest.errorClass = "no_completion";
          this.#emit(oldest, false, this.#deps.now() - oldest.startedAt);
        }
        this.#pending.delete(oldestKey);
      }
    }
    this.#pending.set(runKey, run);
  }

  /**
   * Some failures (for example cloud sign-in rejected before the first model call) never
   * reach agent_end. Without this sweep such a decision would leave no routing-log line.
   * Runs at the start of the next decision: no timers, no polling.
   */
  #sweepStale(): void {
    const cutoff = this.#deps.now() - STALE_RUN_MS;
    for (const [key, run] of this.#pending) {
      if (run.startedAt > cutoff) continue;
      if (!run.logged) {
        if (run.errorClass === "none") run.errorClass = "no_completion";
        this.#emit(run, false, this.#deps.now() - run.startedAt);
      }
      this.#pending.delete(key);
    }
  }

  /**
   * Inbound claim (before_dispatch). A private message with local Gemma unavailable is
   * answered here and never reaches any model. Returns undefined to let the turn continue.
   */
  async onInboundMessage(text: string): Promise<{ handled: true; text: string } | undefined> {
    const startedAt = this.#deps.now();
    const task = this.#classify(text, 0);
    if (!task.privacy_sensitive) return undefined;
    if (await this.#localAvailable()) return undefined;
    const run: PendingRun = {
      requestId: this.#deps.newRequestId(),
      startedAt,
      taskType: "private",
      privacySensitive: true,
      route: "held",
      rule: "privacy_held",
      model: "none",
      lastOutcome: undefined,
      errorClass: "local_unavailable",
      logged: false,
    };
    this.#emit(run, true, this.#deps.now() - startedAt);
    return { handled: true, text: this.#deps.settings.heldMessage };
  }

  /**
   * Model selection (before_model_resolve). Always returns an explicit provider+model so the
   * turn never silently uses a default. A HELD decision is pinned to the LOCAL provider:
   * if the gate hook below did not run, the call fails against the offline desktop instead
   * of reaching the cloud (fail closed).
   *
   * `sessionRef` identifies the conversation. A privacy-sensitive turn marks its session
   * private; every later turn in that session is then kept local (or HELD), because the
   * model that answers receives the whole session history.
   */
  async onModelResolve(
    runKey: string,
    prompt: string,
    heavyAttachments: number,
    sessionRef?: string,
  ): Promise<ModelOverride> {
    this.#sweepStale();
    const startedAt = this.#deps.now();
    const { settings, privateSessions } = this.#deps;
    const task = this.#classify(prompt, heavyAttachments);
    const sessionPrivate = sessionRef !== undefined && privateSessions.has(sessionRef);
    if (task.privacy_sensitive && sessionRef !== undefined) privateSessions.add(sessionRef);
    const lastTool = sessionRef === undefined ? undefined : this.#toolSessions.get(sessionRef);
    const decision = decideRoute(task, {
      cloud_rate_limited: this.#cloudRateLimited(),
      local_available: await this.#localAvailable(),
      session_private: sessionPrivate,
      session_tools_recent: lastTool !== undefined && startedAt - lastTool < TOOL_SESSION_MS,
    });
    if (sessionRef !== undefined && (task.needs_tools || decision.rule === "tools_session_cloud")) {
      if (this.#toolSessions.size >= MAX_PENDING) {
        const oldest = this.#toolSessions.keys().next().value;
        if (oldest !== undefined) this.#toolSessions.delete(oldest);
      }
      this.#toolSessions.delete(sessionRef);
      this.#toolSessions.set(sessionRef, startedAt);
    }
    const useCloud = decision.route === "cloud";
    this.#remember(runKey, {
      requestId: this.#deps.newRequestId(),
      startedAt,
      taskType: taskTypeOf(task),
      privacySensitive: task.privacy_sensitive || sessionPrivate,
      route: decision.route,
      rule: decision.rule,
      model: useCloud ? settings.cloudModel : settings.localModel,
      lastOutcome: undefined,
      errorClass: decision.route === "held" ? "local_unavailable" : "none",
      logged: false,
    });
    return useCloud
      ? { providerOverride: settings.cloudProvider, modelOverride: settings.cloudModel }
      : { providerOverride: settings.localProvider, modelOverride: settings.localModel };
  }

  /**
   * Input gate (before_agent_run), last line of defence before the model reads the prompt.
   * Blocks HELD runs, and blocks any privacy-sensitive run (the message itself, or a turn in
   * a private session) whose resolved provider is not the local one (e.g. a fallback or a manual /model switch).
   */
  onBeforeAgentRun(
    runKey: string,
    resolvedProvider: string | undefined,
  ): BlockDecision | undefined {
    const run = this.#pending.get(runKey);
    if (run === undefined || !run.privacySensitive) return undefined;
    const providerMismatch =
      resolvedProvider !== undefined && resolvedProvider !== this.#deps.settings.localProvider;
    if (run.route !== "held" && !providerMismatch) return undefined;
    if (run.route !== "held") {
      run.route = "held";
      run.rule = "privacy_backstop";
      run.errorClass = "local_unavailable";
    }
    this.#emit(run, true, this.#deps.now() - run.startedAt);
    this.#pending.delete(runKey);
    return {
      outcome: "block",
      reason: run.rule,
      message:
        run.rule === "private_session_held"
          ? this.#deps.settings.heldSessionMessage
          : this.#deps.settings.heldMessage,
      category: "privacy_held",
    };
  }

  /** Observes each provider call (model_call_ended): records outcome, trips the cooldown. */
  onModelCallEnded(
    runKey: string,
    call: {
      provider: string;
      outcome: "completed" | "error";
      errorCategory?: string | undefined;
      failureKind?: string | undefined;
    },
  ): void {
    const errorClass =
      call.outcome === "error" ? classifyModelError(call.errorCategory, call.failureKind) : "none";
    if (errorClass === "rate_limit" && call.provider === this.#deps.settings.cloudProvider) {
      this.#cooldown.trip();
    }
    if (
      call.provider === this.#deps.settings.localProvider &&
      (errorClass === "timeout" ||
        errorClass === "server_error" ||
        errorClass === "model_unavailable")
    ) {
      // Later non-private turns go to the cloud and private ones are HELD until this expires.
      this.#localCooldown.trip();
    }
    const run = this.#pending.get(runKey);
    if (run === undefined) return;
    run.lastOutcome = call.outcome;
    run.errorClass = errorClass;
  }

  /**
   * End of turn (agent_end): emits the single routing-log line. Success requires the agent
   * to report success AND the last provider call to have completed; a 200 that produced no
   * completed call is not success.
   */
  /**
   * The user started a new conversation (/new or /reset). OpenClaw keeps the same session id
   * across a reset (seen live: one id stayed private through four /new commands), so the
   * private flag and the tool follow-up window are cleared explicitly here. Returns how many
   * of the given refs were private, for the log.
   */
  onSessionReset(refs: readonly string[]): number {
    let cleared = 0;
    for (const ref of new Set(refs)) {
      if (this.#deps.privateSessions.has(ref)) cleared++;
      this.#deps.privateSessions.delete(ref);
      this.#toolSessions.delete(ref);
    }
    return cleared;
  }

  onAgentEnd(
    runKey: string,
    end: { success: boolean; durationMs?: number | undefined; error?: string | undefined },
  ): void {
    const run = this.#pending.get(runKey);
    if (run === undefined) return;
    const success = end.success && run.lastOutcome === "completed";
    if (!success && isAbortError(end.error)) {
      run.errorClass = "aborted";
    } else if (!success && run.errorClass === "none") {
      run.errorClass = run.lastOutcome === undefined ? "no_completion" : "unknown";
    }
    this.#emit(run, success, end.durationMs ?? this.#deps.now() - run.startedAt);
    this.#pending.delete(runKey);
  }
}
