export interface LocalHealthOptions {
  /** Base URL of the Ollama endpoint as seen from this process (the in-container forwarder). */
  readonly baseUrl: string;
  /** Model tag that must be present, e.g. "gemma4:e4b". */
  readonly model: string;
  /** Short timeout: a health probe must never wait for a cold model load. */
  readonly timeoutMs: number;
  /** Reuse a result for this long so two hooks in the same turn agree. */
  readonly cacheMs: number;
  readonly now: () => number;
  readonly fetchFn?: typeof fetch;
}

/** About 3 KB: larger than two tailnet packets, far below any HTTP header limit. */
const PROBE_PAD = "a".repeat(3_000);

interface TagsResponse {
  models?: { name?: string }[];
}

/**
 * Returns a probe that reports whether local Gemma is reachable AND has the pinned model.
 * Any failure (timeout, refused, bad JSON, missing model) is "unavailable": fail closed.
 */
export function createLocalHealthProbe(opts: LocalHealthOptions): () => Promise<boolean> {
  const fetchFn = opts.fetchFn ?? fetch;
  let cached: { at: number; ok: boolean } | undefined;

  return async () => {
    const now = opts.now();
    if (cached !== undefined && now - cached.at < opts.cacheMs) return cached.ok;
    let ok = false;
    try {
      const res = await fetchFn(new URL("/api/tags", opts.baseUrl), {
        // Padded so the request needs more than one full-size network packet. Found in
        // live testing: a Tailscale path that dropped full-size packets let a tiny probe
        // through while every real prompt hung. The probe must fail when a prompt would.
        headers: { "x-a3-probe-pad": PROBE_PAD },
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      if (res.ok) {
        const body = (await res.json()) as TagsResponse;
        ok = (body.models ?? []).some((m) => m.name === opts.model);
      }
    } catch {
      ok = false;
    }
    cached = { at: opts.now(), ok };
    return ok;
  };
}
