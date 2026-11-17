export type ErrorClass =
  | "none"
  | "rate_limit"
  | "model_unavailable"
  | "server_error"
  | "timeout"
  | "stream_error"
  | "local_unavailable"
  | "no_completion"
  | "aborted"
  | "unknown";

/**
 * Maps OpenClaw's model_call_ended fields to our error classes.
 * `errorCategory` is a free-form string in OpenClaw 2026.10.9, so we match on substrings.
 */
export function classifyModelError(
  errorCategory: string | undefined,
  failureKind: string | undefined,
): ErrorClass {
  const c = (errorCategory ?? "").toLowerCase();
  if (/429|rate[_ -]?limit|quota|too many requests/.test(c)) return "rate_limit";
  if (/404|not[_ -]?found|model[_ -]?unavailable|unknown model|not allowed/.test(c)) {
    return "model_unavailable";
  }
  if (/5\d\d|server|overloaded|unavailable|bad gateway/.test(c)) return "server_error";
  if (failureKind === "timeout" || /timeout|timed out/.test(c)) return "timeout";
  if (failureKind !== undefined) return "stream_error";
  return "unknown";
}

/** A turn the host cancelled (for example superseded by a newer message) is not a model fault. */
export function isAbortError(error: string | undefined): boolean {
  return error !== undefined && /abort|supersed|cancel/i.test(error);
}

/**
 * Cloud cooldown: after a rate limit we stop sending optional work to the cloud for a fixed
 * window instead of retrying in a loop. The router reads this as `cloud_rate_limited`.
 */
export class CloudCooldown {
  #until = 0;
  readonly #cooldownMs: number;
  readonly #now: () => number;

  constructor(cooldownMs: number, now: () => number) {
    this.#cooldownMs = cooldownMs;
    this.#now = now;
  }

  trip(): void {
    this.#until = this.#now() + this.#cooldownMs;
  }

  isActive(): boolean {
    return this.#now() < this.#until;
  }
}
