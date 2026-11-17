import { describe, expect, it } from "vitest";
import { loadSettings } from "../src/config/settings.ts";
import { createLocalHealthProbe } from "../src/local/health.ts";
import { formatRoutingLog } from "../src/logging/routingLog.ts";
import { classifyModelError } from "../src/router/cooldown.ts";

describe("settings", () => {
  it("has working defaults and env overrides", () => {
    expect(loadSettings(undefined, {}).localModel).toBe("gemma4:e4b");
    expect(loadSettings({ localModel: "a" }, { A3_LOCAL_MODEL: "b" }).localModel).toBe("b");
  });

  it("fails fast naming the field, without echoing the value", () => {
    const bad = "definitely-not-a-url-SECRET";
    expect(() => loadSettings(undefined, { A3_OLLAMA_BASE_URL: bad })).toThrow(/ollamaBaseUrl/);
    try {
      loadSettings(undefined, { A3_OLLAMA_BASE_URL: bad });
    } catch (e) {
      expect(String(e)).not.toContain(bad);
    }
  });
});

describe("local health probe", () => {
  const base = { baseUrl: "http://127.0.0.1:11435", model: "gemma4:e4b", timeoutMs: 50 };
  const respond = (body: unknown, ok = true) =>
    (() => Promise.resolve({ ok, json: () => Promise.resolve(body) })) as unknown as typeof fetch;

  it("is healthy only when the pinned model is listed", async () => {
    const probe = (fetchFn: typeof fetch) =>
      createLocalHealthProbe({ ...base, cacheMs: 0, now: () => 0, fetchFn })();
    expect(await probe(respond({ models: [{ name: "gemma4:e4b" }] }))).toBe(true);
    expect(await probe(respond({ models: [{ name: "other" }] }))).toBe(false);
    expect(await probe(respond({}, false))).toBe(false);
    expect(await probe(() => Promise.reject(new Error("refused")))).toBe(false);
  });

  it("times out quickly instead of hanging", async () => {
    const hang = ((_u: unknown, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
      })) as unknown as typeof fetch;
    const started = Date.now();
    expect(
      await createLocalHealthProbe({ ...base, cacheMs: 0, now: () => 0, fetchFn: hang })(),
    ).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("regression: the probe request is larger than one network packet", async () => {
    // A path that dropped full-size packets passed a tiny probe while real prompts hung.
    let sent = 0;
    const fetchFn = ((_u: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      sent = Object.entries(headers).reduce((n, [k, v]) => n + k.length + v.length, 0);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ models: [] }) });
    }) as unknown as typeof fetch;
    await createLocalHealthProbe({ ...base, cacheMs: 0, now: () => 0, fetchFn })();
    expect(sent).toBeGreaterThan(2_600); // two 1,280-byte tailnet packets
  });

  it("caches within the window", async () => {
    let calls = 0;
    let now = 0;
    const fetchFn = (() => {
      calls++;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ models: [] }) });
    }) as unknown as typeof fetch;
    const probe = createLocalHealthProbe({ ...base, cacheMs: 5000, now: () => now, fetchFn });
    await probe();
    await probe();
    expect(calls).toBe(1);
    now = 6000;
    await probe();
    expect(calls).toBe(2);
  });
});

describe("error classification and log format", () => {
  it("classifies provider errors", () => {
    expect(classifyModelError("rate_limit", undefined)).toBe("rate_limit");
    expect(classifyModelError("HTTP 429", undefined)).toBe("rate_limit");
    expect(classifyModelError("model_not_found", undefined)).toBe("model_unavailable");
    expect(classifyModelError("server_error 503", undefined)).toBe("server_error");
    expect(classifyModelError(undefined, "timeout")).toBe("timeout");
    expect(classifyModelError(undefined, "connection_reset")).toBe("stream_error");
    expect(classifyModelError(undefined, undefined)).toBe("unknown");
  });

  it("emits one JSON line tagged for the Cloud Logging filter", () => {
    const line = formatRoutingLog({
      ts: "2026-11-16T00:00:00.000Z",
      request_id: "r",
      task_type: "simple",
      route: "local",
      rule: "simple_local",
      model: "gemma4:e4b",
      success: true,
      latency_ms: 12,
      error_class: "none",
    });
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toMatchObject({ component: "a3-router", route: "local" });
  });
});
