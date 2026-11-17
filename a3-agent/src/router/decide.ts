import type { RoutingDecision, RoutingEnvironment, TaskProperties } from "./types.ts";

/**
 * Ordered, deterministic routing rules. First match wins.
 *
 * 1. privacy_sensitive      -> local if available, else HELD (never cloud)
 *    session_private        -> same, because the cloud would receive the private history
 * 2. reasoning_heavy        -> cloud
 *    needs_long_context     -> cloud
 * 3. cloud_rate_limited     -> local if available
 * 4. needs_tools            -> cloud (local model is unreliable at multi-step tool calls)
 *    session_tools_recent   -> cloud (a follow-up such as "yes" continues that tool task)
 * 5. simple                 -> local if available
 * 6. default                -> cloud
 *
 * Pure function: no I/O, no clock, no randomness, so every rule is unit-testable.
 */
export function decideRoute(task: TaskProperties, env: RoutingEnvironment): RoutingDecision {
  if (task.privacy_sensitive) {
    return env.local_available
      ? { route: "local", rule: "privacy_local" }
      : { route: "held", rule: "privacy_held" };
  }
  if (env.session_private === true) {
    return env.local_available
      ? { route: "local", rule: "private_session_local" }
      : { route: "held", rule: "private_session_held" };
  }
  if (task.reasoning_heavy) {
    return { route: "cloud", rule: "reasoning_cloud" };
  }
  if (task.needs_long_context) {
    return { route: "cloud", rule: "long_context_cloud" };
  }
  if (env.cloud_rate_limited && env.local_available) {
    return { route: "local", rule: "rate_limited_local" };
  }
  if (task.needs_tools) {
    return { route: "cloud", rule: "tools_cloud" };
  }
  if (env.session_tools_recent === true) {
    return { route: "cloud", rule: "tools_session_cloud" };
  }
  if (task.simple && env.local_available) {
    return { route: "local", rule: "simple_local" };
  }
  return { route: "cloud", rule: "default_cloud" };
}
