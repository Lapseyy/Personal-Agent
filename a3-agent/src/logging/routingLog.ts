import type { ErrorClass } from "../router/cooldown.ts";
import type { Route, RuleId, TaskType } from "../router/types.ts";

/**
 * One line per routing decision. Field set is fixed and contains NO message text or PII:
 * only ids, enums, model names, booleans and numbers.
 */
export interface RoutingLogEntry {
  readonly ts: string;
  readonly request_id: string;
  readonly task_type: TaskType;
  readonly route: Route;
  readonly rule: RuleId;
  readonly model: string;
  readonly success: boolean;
  readonly latency_ms: number;
  readonly error_class: ErrorClass;
}

export const ROUTER_COMPONENT = "a3-router";

/** Cloud Logging parses a JSON object on one stdout line into jsonPayload. */
export function formatRoutingLog(entry: RoutingLogEntry): string {
  return JSON.stringify({
    severity: entry.success ? "INFO" : "WARNING",
    component: ROUTER_COMPONENT,
    ts: entry.ts,
    request_id: entry.request_id,
    task_type: entry.task_type,
    route: entry.route,
    rule: entry.rule,
    model: entry.model,
    success: entry.success,
    latency_ms: entry.latency_ms,
    error_class: entry.error_class,
  });
}

export function writeRoutingLog(entry: RoutingLogEntry): void {
  process.stdout.write(`${formatRoutingLog(entry)}\n`);
}
