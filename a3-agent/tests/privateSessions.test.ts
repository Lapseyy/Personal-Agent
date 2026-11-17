import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decideRoute } from "../src/router/decide.ts";
import { FilePrivateSessionStore } from "../src/router/privateSessions.ts";

const NOT_PRIVATE = {
  privacy_sensitive: false,
  reasoning_heavy: true,
  needs_long_context: false,
  simple: false,
  needs_tools: false,
};

describe("decideRoute: session_private", () => {
  it("keeps a reasoning-heavy turn local when the session is private", () => {
    expect(
      decideRoute(NOT_PRIVATE, {
        cloud_rate_limited: false,
        local_available: true,
        session_private: true,
      }),
    ).toEqual({ route: "local", rule: "private_session_local" });
  });

  it("holds the turn when the session is private and local is down", () => {
    expect(
      decideRoute(NOT_PRIVATE, {
        cloud_rate_limited: false,
        local_available: false,
        session_private: true,
      }),
    ).toEqual({ route: "held", rule: "private_session_held" });
  });
});

describe("FilePrivateSessionStore", () => {
  const file = (): string => join(mkdtempSync(join(tmpdir(), "a3-priv-")), "a3", "private.json");

  it("starts empty when the file does not exist and persists additions", () => {
    const path = file();
    const store = new FilePrivateSessionStore(path);
    expect(store.has("s1")).toBe(false);
    store.add("s1");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(["s1"]);
  });

  it("survives a restart: a second instance reads what the first wrote", () => {
    const path = file();
    new FilePrivateSessionStore(path).add("s1");
    const reloaded = new FilePrivateSessionStore(path);
    expect(reloaded.has("s1")).toBe(true);
    expect(reloaded.has("s2")).toBe(false);
  });

  it("fails closed on a corrupt file: every session is private and the file is not overwritten", () => {
    const path = file();
    new FilePrivateSessionStore(path).add("s1");
    writeFileSync(path, "{not json");
    const store = new FilePrivateSessionStore(path);
    expect(store.failClosed).toBe(true);
    expect(store.has("anything")).toBe(true);
    store.add("s2");
    expect(readFileSync(path, "utf8")).toBe("{not json");
  });
});
