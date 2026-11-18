import { beforeEach, describe, expect, it } from "vitest";
import { loadSettings } from "../src/config/settings.ts";
import type { RoutingLogEntry } from "../src/logging/routingLog.ts";
import { RouterRuntime } from "../src/plugin/runtime.ts";
import { InMemoryPrivateSessionStore } from "../src/router/privateSessions.ts";

const PRIVATE = "what is my bank account balance";
const SIMPLE = "What is 12 times 9?";
const HARD = "why is the sky blue";

interface Harness {
  runtime: RouterRuntime;
  logs: RoutingLogEntry[];
  state: { local: boolean; flag: boolean; now: number };
}

function harness(env: Record<string, string> = {}): Harness {
  const logs: RoutingLogEntry[] = [];
  const state = { local: true, flag: false, now: 1_000_000 };
  let id = 0;
  const runtime = new RouterRuntime({
    settings: loadSettings(undefined, env),
    localHealthy: () => Promise.resolve(state.local),
    rateLimitFlagPresent: () => state.flag,
    privateSessions: new InMemoryPrivateSessionStore(),
    log: (e) => logs.push(e),
    now: () => state.now,
    newRequestId: () => `req-${++id}`,
  });
  return { runtime, logs, state };
}

describe("RouterRuntime", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("HELD: private message + local down is claimed, answered, logged, never routed", async () => {
    h.state.local = false;
    const res = await h.runtime.onInboundMessage(PRIVATE);
    expect(res?.handled).toBe(true);
    expect(res?.text).toMatch(/local model is offline/);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({
      route: "held",
      rule: "privacy_held",
      model: "none",
      task_type: "private",
      error_class: "local_unavailable",
    });
  });

  it("private message + local up passes through and resolves to the local model", async () => {
    expect(await h.runtime.onInboundMessage(PRIVATE)).toBeUndefined();
    expect(await h.runtime.onModelResolve("r1", PRIVATE, 0)).toEqual({
      providerOverride: "ollama",
      modelOverride: "gemma4:e4b",
    });
  });

  it("non-private messages are never claimed, even with local down", async () => {
    h.state.local = false;
    expect(await h.runtime.onInboundMessage(SIMPLE)).toBeUndefined();
    expect(h.logs).toHaveLength(0);
  });

  it("fail closed: a HELD decision at resolve time is pinned to the local provider, then blocked", async () => {
    h.state.local = false;
    const override = await h.runtime.onModelResolve("r1", PRIVATE, 0);
    expect(override.providerOverride).toBe("ollama");
    const block = h.runtime.onBeforeAgentRun("r1", "ollama");
    expect(block).toMatchObject({ outcome: "block", category: "privacy_held" });
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ route: "held", model: "none" });
    h.runtime.onAgentEnd("r1", { success: false });
    expect(h.logs).toHaveLength(1);
  });

  it("backstop: a private run that resolved to a non-local provider is blocked", async () => {
    await h.runtime.onModelResolve("r1", PRIVATE, 0);
    const block = h.runtime.onBeforeAgentRun("r1", "openai");
    expect(block?.outcome).toBe("block");
    expect(h.logs[0]).toMatchObject({ route: "held", rule: "privacy_backstop", model: "none" });
  });

  it("gate passes non-private runs and private runs on the local provider", async () => {
    await h.runtime.onModelResolve("r1", HARD, 0);
    expect(h.runtime.onBeforeAgentRun("r1", "openai")).toBeUndefined();
    await h.runtime.onModelResolve("r2", PRIVATE, 0);
    expect(h.runtime.onBeforeAgentRun("r2", "ollama")).toBeUndefined();
  });

  it("simple -> local, hard -> cloud; one log line per turn at agent_end", async () => {
    expect((await h.runtime.onModelResolve("r1", SIMPLE, 0)).providerOverride).toBe("ollama");
    h.runtime.onModelCallEnded("r1", { provider: "ollama", outcome: "completed" });
    h.runtime.onAgentEnd("r1", { success: true, durationMs: 420 });

    expect(await h.runtime.onModelResolve("r2", HARD, 0)).toEqual({
      providerOverride: "openai",
      modelOverride: "gpt-5.6-sol",
    });
    h.runtime.onModelCallEnded("r2", { provider: "openai", outcome: "completed" });
    h.runtime.onModelCallEnded("r2", { provider: "openai", outcome: "completed" });
    h.runtime.onAgentEnd("r2", { success: true, durationMs: 2100 });

    expect(h.logs).toHaveLength(2);
    expect(h.logs[0]).toMatchObject({
      route: "local",
      rule: "simple_local",
      model: "gemma4:e4b",
      success: true,
      latency_ms: 420,
      error_class: "none",
    });
    expect(h.logs[1]).toMatchObject({ route: "cloud", rule: "reasoning_cloud", success: true });
  });

  it("local down: simple task is answered by the cloud", async () => {
    h.state.local = false;
    expect((await h.runtime.onModelResolve("r1", SIMPLE, 0)).providerOverride).toBe("openai");
  });

  it("a real 429 trips the cooldown: next simple-or-general turn goes local, then expires", async () => {
    const general = "tell me about the history of the bicycle in some detail please ".repeat(8);
    expect((await h.runtime.onModelResolve("r1", general, 0)).providerOverride).toBe("openai");
    h.runtime.onModelCallEnded("r1", {
      provider: "openai",
      outcome: "error",
      errorCategory: "rate_limit",
    });
    h.runtime.onAgentEnd("r1", { success: false });
    expect(h.logs[0]).toMatchObject({ success: false, error_class: "rate_limit" });

    expect((await h.runtime.onModelResolve("r2", general, 0)).providerOverride).toBe("ollama");
    h.state.now += 300_001;
    expect((await h.runtime.onModelResolve("r3", general, 0)).providerOverride).toBe("openai");
  });

  it("rate-limit simulation switch (env var and flag file) reroutes without a cloud call", async () => {
    const general = "tell me about the history of the bicycle in some detail please ".repeat(8);
    h.state.flag = true;
    await h.runtime.onModelResolve("r1", general, 0);
    h.runtime.onModelCallEnded("r1", { provider: "ollama", outcome: "completed" });
    h.runtime.onAgentEnd("r1", { success: true });
    expect(h.logs[0]).toMatchObject({ route: "local", rule: "rate_limited_local" });
    h.state.flag = false;
    expect((await h.runtime.onModelResolve("r2", general, 0)).providerOverride).toBe("openai");

    const viaEnv = harness({ A3_SIMULATE_CLOUD_429: "1" });
    expect((await viaEnv.runtime.onModelResolve("r1", general, 0)).providerOverride).toBe("ollama");
  });

  it("HTTP 200 is not success: agent success without a completed model call is logged as failure", async () => {
    await h.runtime.onModelResolve("r1", HARD, 0);
    h.runtime.onAgentEnd("r1", { success: true });
    expect(h.logs[0]).toMatchObject({ success: false, error_class: "no_completion" });

    await h.runtime.onModelResolve("r2", HARD, 0);
    h.runtime.onModelCallEnded("r2", {
      provider: "openai",
      outcome: "error",
      failureKind: "connection_reset",
    });
    h.runtime.onAgentEnd("r2", { success: true });
    expect(h.logs[1]).toMatchObject({ success: false, error_class: "stream_error" });
  });

  it("routing log never contains message text", async () => {
    const secret = "my bank account password is hunter2-zebra";
    h.state.local = false;
    await h.runtime.onInboundMessage(secret);
    h.state.local = true;
    await h.runtime.onModelResolve("r1", secret, 0);
    h.runtime.onModelCallEnded("r1", { provider: "ollama", outcome: "completed" });
    h.runtime.onAgentEnd("r1", { success: true });
    const dump = JSON.stringify(h.logs);
    expect(h.logs).toHaveLength(2);
    for (const word of ["hunter2", "zebra", "bank", "password"]) expect(dump).not.toContain(word);
    for (const e of h.logs) {
      expect(Object.keys(e).sort()).toEqual(
        [
          "error_class",
          "latency_ms",
          "model",
          "request_id",
          "route",
          "rule",
          "success",
          "task_type",
          "ts",
        ].sort(),
      );
    }
  });
});

describe("RouterRuntime: private sessions and failure logging", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("a private turn keeps the rest of that session local, even for reasoning-heavy turns", async () => {
    await h.runtime.onModelResolve("r1", PRIVATE, 0, "sess-A");
    h.runtime.onModelCallEnded("r1", { provider: "ollama", outcome: "completed" });
    h.runtime.onAgentEnd("r1", { success: true });
    // HARD would normally go to the cloud, which would receive the private history.
    expect(await h.runtime.onModelResolve("r2", HARD, 0, "sess-A")).toEqual({
      providerOverride: "ollama",
      modelOverride: "gemma4:e4b",
    });
    h.runtime.onModelCallEnded("r2", { provider: "ollama", outcome: "completed" });
    h.runtime.onAgentEnd("r2", { success: true });
    expect(h.logs[1]).toMatchObject({
      task_type: "reasoning",
      route: "local",
      rule: "private_session_local",
      model: "gemma4:e4b",
    });
  });

  // Regression (live, Nov 17): the same session id stayed private through four /new commands,
  // so a fresh conversation sent its reasoning and tool turns to local Gemma.
  it("/new or /reset clears the private flag for that session", async () => {
    await h.runtime.onModelResolve("r1", PRIVATE, 0, "sess-A");
    h.runtime.onModelCallEnded("r1", { provider: "ollama", outcome: "completed" });
    h.runtime.onAgentEnd("r1", { success: true });
    expect(h.runtime.onSessionReset(["sess-A", "agent:main:main"])).toBe(1);
    expect((await h.runtime.onModelResolve("r2", HARD, 0, "sess-A")).providerOverride).toBe(
      "openai",
    );
    expect(h.runtime.onSessionReset(["sess-A"])).toBe(0);
  });

  it('a short "yes" after a tool-using turn stays on the cloud; it expires after 15 minutes', async () => {
    await h.runtime.onModelResolve("r1", "Send an email to sam@example.com", 0, "sess-T");
    expect((await h.runtime.onModelResolve("r2", "Yes", 0, "sess-T")).providerOverride).toBe(
      "openai",
    );
    expect((await h.runtime.onModelResolve("r3", "Yes", 0, "sess-U")).providerOverride).toBe(
      "ollama",
    );
    h.state.now += 16 * 60_000;
    expect((await h.runtime.onModelResolve("r4", "Yes", 0, "sess-T")).providerOverride).toBe(
      "ollama",
    );
  });

  it("a new session (new id, as after /new) is not affected by an earlier private session", async () => {
    await h.runtime.onModelResolve("r1", PRIVATE, 0, "sess-A");
    expect((await h.runtime.onModelResolve("r2", HARD, 0, "sess-B")).providerOverride).toBe(
      "openai",
    );
  });

  it("HELD: a later turn in a private session is blocked when local is down, never cloud", async () => {
    await h.runtime.onModelResolve("r1", PRIVATE, 0, "sess-A");
    h.state.local = false;
    const override = await h.runtime.onModelResolve("r2", HARD, 0, "sess-A");
    expect(override.providerOverride).toBe("ollama");
    const block = h.runtime.onBeforeAgentRun("r2", "ollama");
    expect(block).toMatchObject({ outcome: "block", reason: "private_session_held" });
    expect(block?.message).toMatch(/\/new/);
    expect(h.logs.at(-1)).toMatchObject({
      route: "held",
      rule: "private_session_held",
      model: "none",
    });
  });

  it("backstop: a private-session turn that resolves to the cloud provider is blocked", async () => {
    await h.runtime.onModelResolve("r1", PRIVATE, 0, "sess-A");
    await h.runtime.onModelResolve("r2", HARD, 0, "sess-A");
    expect(h.runtime.onBeforeAgentRun("r2", "openai")).toMatchObject({ outcome: "block" });
    expect(h.logs.at(-1)).toMatchObject({ route: "held", rule: "privacy_backstop" });
  });

  it("a turn cancelled by the host is logged as aborted, not unknown", async () => {
    await h.runtime.onModelResolve("r1", SIMPLE, 0, "sess-A");
    h.runtime.onAgentEnd("r1", {
      success: false,
      error: "agent run superseded by a newer session writer",
    });
    expect(h.logs[0]).toMatchObject({ success: false, error_class: "aborted" });
  });

  it("regression: a turn that never reaches agent_end still gets a failure line", async () => {
    await h.runtime.onModelResolve("r1", HARD, 0, "sess-A"); // e.g. cloud sign-in rejected
    expect(h.logs).toHaveLength(0);
    h.state.now += 16 * 60_000;
    await h.runtime.onModelResolve("r2", SIMPLE, 0, "sess-A");
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({
      route: "cloud",
      rule: "reasoning_cloud",
      success: false,
      error_class: "no_completion",
    });
    // A late agent_end for the swept run must not produce a second line.
    h.runtime.onAgentEnd("r1", { success: true });
    expect(h.logs).toHaveLength(1);
  });

  it("regression: a local timeout stops local routing; non-private goes cloud, private is HELD", async () => {
    // Found live: the probe passed, the real prompt hung for 300 s, and every later
    // simple message was sent to the same dead route.
    expect((await h.runtime.onModelResolve("r1", SIMPLE, 0, "s1")).providerOverride).toBe("ollama");
    h.runtime.onModelCallEnded("r1", {
      provider: "ollama",
      outcome: "error",
      failureKind: "timeout",
    });
    h.runtime.onAgentEnd("r1", { success: false });
    expect(h.logs[0]).toMatchObject({ route: "local", success: false, error_class: "timeout" });

    // Probe still says healthy, but the cooldown wins.
    expect((await h.runtime.onModelResolve("r2", SIMPLE, 0, "s2")).providerOverride).toBe("openai");
    const held = await h.runtime.onInboundMessage(PRIVATE);
    expect(held?.handled).toBe(true);

    h.state.now += 301_000;
    expect((await h.runtime.onModelResolve("r3", SIMPLE, 0, "s3")).providerOverride).toBe("ollama");
  });

  it("a cloud failure does not trip the local cooldown", async () => {
    await h.runtime.onModelResolve("r1", HARD, 0, "s1");
    h.runtime.onModelCallEnded("r1", {
      provider: "openai",
      outcome: "error",
      failureKind: "timeout",
    });
    expect((await h.runtime.onModelResolve("r2", SIMPLE, 0, "s2")).providerOverride).toBe("ollama");
  });
});
