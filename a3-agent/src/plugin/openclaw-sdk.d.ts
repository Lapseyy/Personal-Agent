/**
 * Minimal ambient types for the parts of the OpenClaw plugin SDK this plugin uses.
 * Shapes copied from openclaw@2026.10.9 (dist/config-contracts-*.d.ts) so the project
 * type-checks without installing the full gateway as a dev dependency. The gateway supplies
 * the real module at runtime. Re-check these if the pinned OpenClaw version changes.
 */
declare module "openclaw/plugin-sdk/plugin-entry" {
  export interface AgentHookContext {
    runId?: string;
    sessionKey?: string;
    sessionId?: string;
    /** How the run started: "user" | "manual" | "cron" | "heartbeat" | "event" | ... */
    trigger?: string;
    modelProviderId?: string;
  }
  export interface HookHandlers {
    before_dispatch: (event: {
      content: string;
      body?: string;
    }) => Promise<{ handled: boolean; text?: string } | undefined>;
    before_model_resolve: (
      event: { prompt: string; attachments?: { kind: string }[] },
      ctx: AgentHookContext,
    ) => Promise<{ modelOverride?: string; providerOverride?: string } | undefined>;
    before_agent_run: (
      event: { prompt: string },
      ctx: AgentHookContext,
    ) =>
      | { outcome: "block"; reason: string; message?: string; category?: string }
      | { outcome: "pass" }
      | undefined;
    before_tool_call: (
      event: { toolName: string; params: Record<string, unknown>; runId?: string },
      ctx: { runId?: string; sessionKey?: string; toolName: string },
    ) =>
      | {
          block?: boolean;
          blockReason?: string;
          requireApproval?: {
            title: string;
            description: string;
            severity?: "info" | "warning" | "critical";
            timeoutMs?: number;
            timeoutReason?: string;
            allowedDecisions?: ("allow-once" | "allow-always" | "deny")[];
            onResolution?: (decision: string) => Promise<void> | void;
          };
        }
      | undefined;
    model_call_ended: (
      event: {
        runId: string;
        provider: string;
        model: string;
        outcome: "completed" | "error";
        errorCategory?: string;
        failureKind?: string;
      },
      ctx: AgentHookContext,
    ) => void;
    agent_end: (
      event: { runId?: string; success: boolean; error?: string; durationMs?: number },
      ctx: AgentHookContext,
    ) => void;
  }
  export interface PluginApi {
    pluginConfig?: Record<string, unknown>;
    on<K extends keyof HookHandlers>(hookName: K, handler: HookHandlers[K]): void;
  }
  export function definePluginEntry(entry: {
    id: string;
    name: string;
    description: string;
    register(api: PluginApi): void;
  }): unknown;
}
