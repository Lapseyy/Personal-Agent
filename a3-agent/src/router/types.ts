/** Explicit task properties the router decides on. All are booleans so rules stay deterministic. */
export interface TaskProperties {
  readonly privacy_sensitive: boolean;
  readonly reasoning_heavy: boolean;
  readonly needs_long_context: boolean;
  readonly simple: boolean;
  /** Needs a live tool: calendar, email, web search, weather, news. */
  readonly needs_tools: boolean;
}

/** Environment facts sampled at decision time. */
export interface RoutingEnvironment {
  readonly cloud_rate_limited: boolean;
  readonly local_available: boolean;
  /** The session already contains a privacy-sensitive turn, so its history must stay local. */
  readonly session_private?: boolean;
  /** A recent turn in this session used tools, so a short follow-up ("yes") continues it. */
  readonly session_tools_recent?: boolean;
}

export type Route = "local" | "cloud" | "held";

export type RuleId =
  | "privacy_local"
  | "privacy_held"
  | "private_session_local"
  | "private_session_held"
  | "reasoning_cloud"
  | "long_context_cloud"
  | "rate_limited_local"
  | "tools_cloud"
  | "tools_session_cloud"
  | "simple_local"
  | "default_cloud"
  | "privacy_backstop";

export type TaskType = "private" | "reasoning" | "long_context" | "tool_use" | "simple" | "general";

export interface RoutingDecision {
  readonly route: Route;
  readonly rule: RuleId;
}
