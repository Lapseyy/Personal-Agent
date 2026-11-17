import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { definePluginEntry, type AgentHookContext } from "openclaw/plugin-sdk/plugin-entry";
import { ApprovalGate } from "../approval/gate.ts";
import { parseAllowlist } from "../approval/gogPolicy.ts";
import { ApprovalTokenStore, approvalTokenPath } from "../approval/tokens.ts";
import { loadSettings } from "../config/settings.ts";
import { createLocalHealthProbe } from "../local/health.ts";
import { writeRoutingLog } from "../logging/routingLog.ts";
import { FilePrivateSessionStore } from "../router/privateSessions.ts";
import { RouterRuntime } from "./runtime.ts";

const HEAVY_ATTACHMENT_KINDS = new Set(["document", "audio", "video"]);

function runKeyOf(ctx: AgentHookContext, eventRunId?: string): string {
  return eventRunId ?? ctx.runId ?? ctx.sessionKey ?? "unknown-run";
}

export default definePluginEntry({
  id: "a3-router",
  name: "A3 Hybrid Router",
  description: "Routes each turn to local Gemma or the cloud model; holds private tasks offline.",
  register(api) {
    const settings = loadSettings(api.pluginConfig, process.env);
    const flagFile = settings.rateLimitFlagFile;
    // Inside the OpenClaw state dir so it is snapshotted and restored with the transcripts.
    const stateDir = process.env["OPENCLAW_STATE_DIR"] ?? join(homedir(), ".openclaw");
    const privateSessions = new FilePrivateSessionStore(
      settings.privateSessionsFile ?? join(stateDir, "a3-router", "private-sessions.json"),
    );
    const runtime = new RouterRuntime({
      settings,
      localHealthy: createLocalHealthProbe({
        baseUrl: settings.ollamaBaseUrl,
        model: settings.localModel,
        timeoutMs: settings.healthTimeoutMs,
        cacheMs: settings.healthCacheMs,
        now: Date.now,
      }),
      rateLimitFlagPresent: () => flagFile !== undefined && existsSync(flagFile),
      privateSessions,
      log: writeRoutingLog,
      now: Date.now,
      newRequestId: randomUUID,
    });

    // Human approval for anything that sends mail or changes mail/calendar (see README).
    const gate = new ApprovalGate({
      policy: {
        account: process.env["GOG_ACCOUNT"],
        allowlist: parseAllowlist(process.env["A3_EMAIL_ALLOWLIST"]),
      },
      tokens: new ApprovalTokenStore(approvalTokenPath(stateDir)),
      log: (entry) => {
        const blocked = entry.decision.startsWith("blocked") || entry.decision === "denied";
        process.stdout.write(
          `${JSON.stringify({ severity: blocked ? "WARNING" : "INFO", component: "a3-approval", event: "gate", ...entry })}\n`,
        );
      },
      now: Date.now,
      tokenTtlMs: 180_000,
      approvalTimeoutMs: 600_000,
    });

    api.on("before_tool_call", (event, ctx) =>
      gate.onBeforeToolCall(event.params, event.runId ?? ctx.runId),
    );

    api.on("before_dispatch", (event) => runtime.onInboundMessage(event.content));

    api.on("before_model_resolve", (event, ctx) => {
      const heavy = (event.attachments ?? []).filter((a) =>
        HEAVY_ATTACHMENT_KINDS.has(a.kind),
      ).length;
      gate.noteRunTrigger(ctx.runId, ctx.trigger);
      // sessionId changes on /new; sessionKey is the fallback and never resets (fail closed).
      const sessionRef = ctx.sessionId ?? ctx.sessionKey;
      return runtime.onModelResolve(runKeyOf(ctx), event.prompt, heavy, sessionRef);
    });

    api.on("before_agent_run", (_event, ctx) =>
      runtime.onBeforeAgentRun(runKeyOf(ctx), ctx.modelProviderId),
    );

    api.on("model_call_ended", (event, ctx) => {
      runtime.onModelCallEnded(runKeyOf(ctx, event.runId), event);
    });

    api.on("agent_end", (event, ctx) => {
      runtime.onAgentEnd(runKeyOf(ctx, event.runId), event);
    });
  },
});
