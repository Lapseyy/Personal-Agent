import { describe, expect, it } from "vitest";
import { decideRoute } from "../src/router/decide.ts";
import type { RoutingEnvironment, TaskProperties } from "../src/router/types.ts";

const task = (over: Partial<TaskProperties> = {}): TaskProperties => ({
  privacy_sensitive: false,
  reasoning_heavy: false,
  needs_long_context: false,
  simple: false,
  needs_tools: false,
  ...over,
});
const env = (over: Partial<RoutingEnvironment> = {}): RoutingEnvironment => ({
  cloud_rate_limited: false,
  local_available: true,
  ...over,
});

describe("decideRoute", () => {
  it("private + local up -> local", () => {
    expect(decideRoute(task({ privacy_sensitive: true }), env())).toEqual({
      route: "local",
      rule: "privacy_local",
    });
  });

  it("private + local down -> HELD", () => {
    expect(decideRoute(task({ privacy_sensitive: true }), env({ local_available: false }))).toEqual(
      { route: "held", rule: "privacy_held" },
    );
  });

  it("private never routes to cloud, for every combination of other inputs", () => {
    for (const reasoning_heavy of [true, false])
      for (const needs_long_context of [true, false])
        for (const simple of [true, false])
          for (const cloud_rate_limited of [true, false])
            for (const local_available of [true, false]) {
              const d = decideRoute(
                task({ privacy_sensitive: true, reasoning_heavy, needs_long_context, simple }),
                { cloud_rate_limited, local_available },
              );
              expect(d.route).not.toBe("cloud");
              expect(d.route).toBe(local_available ? "local" : "held");
            }
  });

  it("reasoning -> cloud even when local is up", () => {
    expect(decideRoute(task({ reasoning_heavy: true }), env()).rule).toBe("reasoning_cloud");
  });

  it("long context -> cloud", () => {
    expect(decideRoute(task({ needs_long_context: true }), env())).toEqual({
      route: "cloud",
      rule: "long_context_cloud",
    });
  });

  it("reasoning outranks the rate-limit rule (rule order)", () => {
    expect(
      decideRoute(task({ reasoning_heavy: true }), env({ cloud_rate_limited: true })).route,
    ).toBe("cloud");
  });

  it("cloud rate limited + local up -> local", () => {
    expect(decideRoute(task(), env({ cloud_rate_limited: true }))).toEqual({
      route: "local",
      rule: "rate_limited_local",
    });
  });

  it("cloud rate limited + local down -> cloud (default)", () => {
    expect(
      decideRoute(task(), env({ cloud_rate_limited: true, local_available: false })).rule,
    ).toBe("default_cloud");
  });

  it("simple + local up -> local", () => {
    expect(decideRoute(task({ simple: true }), env())).toEqual({
      route: "local",
      rule: "simple_local",
    });
  });

  it("simple + local down -> cloud", () => {
    expect(decideRoute(task({ simple: true }), env({ local_available: false })).route).toBe(
      "cloud",
    );
  });

  it("tool-using request -> cloud even when short", () => {
    expect(decideRoute(task({ needs_tools: true }), env())).toEqual({
      route: "cloud",
      rule: "tools_cloud",
    });
  });

  it("tool-using request + cloud rate limited + local up -> local", () => {
    expect(decideRoute(task({ needs_tools: true }), env({ cloud_rate_limited: true })).rule).toBe(
      "rate_limited_local",
    );
  });

  it("short follow-up in a session that just used tools -> cloud", () => {
    expect(decideRoute(task({ simple: true }), env({ session_tools_recent: true })).rule).toBe(
      "tools_session_cloud",
    );
    expect(
      decideRoute(
        task({ simple: true, privacy_sensitive: true }),
        env({ session_tools_recent: true }),
      ).rule,
    ).toBe("privacy_local");
  });

  it("private tool-using request still stays local or held", () => {
    const t = task({ needs_tools: true, privacy_sensitive: true });
    expect(decideRoute(t, env()).rule).toBe("privacy_local");
    expect(decideRoute(t, env({ local_available: false })).route).toBe("held");
  });

  it("nothing matches -> default cloud", () => {
    expect(decideRoute(task(), env())).toEqual({ route: "cloud", rule: "default_cloud" });
  });
});
