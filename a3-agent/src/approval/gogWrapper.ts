import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { classifyGogArgv, parseAllowlist } from "./gogPolicy.ts";
import { ApprovalTokenStore, approvalTokenPath } from "./tokens.ts";

/**
 * Installed in the container as `gog`. The real binary lives elsewhere and is only started
 * from here. This is the enforcement point for the send-approval rule: it sees the real
 * argument vector (no shell quoting to guess at), so a send or change runs only if the
 * policy allows it AND a matching single-use approval token exists.
 */
export type ExecDecision =
  | {
      readonly run: true;
      readonly args: string[];
      readonly label: string;
      readonly decision: string;
    }
  | {
      readonly run: false;
      readonly message: string;
      readonly label: string;
      readonly decision: string;
    };

export function decideExec(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  tokens: Pick<ApprovalTokenStore, "consume">,
): ExecDecision {
  const action = classifyGogArgv(argv, {
    account: env["GOG_ACCOUNT"],
    allowlist: parseAllowlist(env["A3_EMAIL_ALLOWLIST"]),
  });
  if (action.kind === "blocked") {
    return {
      run: false,
      label: action.label,
      decision: "blocked",
      message: `BLOCKED by the approval gate: ${action.reason ?? "not allowed"}.`,
    };
  }
  if (action.kind === "read" || action.kind === "draft") {
    // gog's own send lock stays on for everything that is not an approved send.
    return {
      run: true,
      args: ["--gmail-no-send", ...argv],
      label: action.label,
      decision: "allowed",
    };
  }
  const kind = action.kind === "send" ? "send" : "mutate";
  if (!tokens.consume(kind, action.recipients)) {
    return {
      run: false,
      label: action.label,
      decision: "needs_approval",
      message:
        "BLOCKED by the approval gate: this needs the user's approval and none is on record. " +
        "Nothing was sent or changed. Show the user exactly what you want to do and ask.",
    };
  }
  return { run: true, args: [...argv], label: action.label, decision: "approved" };
}

/** KEY=VALUE lines written by the entrypoint, for when the tool sandbox strips the env. */
function loadEnvFile(path: string, env: NodeJS.ProcessEnv): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    if (env[key] === undefined || env[key] === "") env[key] = line.slice(eq + 1);
  }
}

function audit(decision: string, label: string): void {
  const line = JSON.stringify({
    severity: decision === "allowed" || decision === "approved" ? "INFO" : "WARNING",
    component: "a3-approval",
    event: "gog_exec",
    decision,
    action: label,
    ts: new Date().toISOString(),
  });
  try {
    appendFileSync("/proc/1/fd/1", `${line}\n`); // the container's log stream
  } catch {
    // Not in the container (tests, desktop): no audit sink.
  }
}

function main(): void {
  const env = process.env;
  loadEnvFile(env["A3_GOG_ENV_FILE"] ?? join(homedir(), ".a3", "gog.env"), env);
  const stateDir = env["OPENCLAW_STATE_DIR"] ?? join(homedir(), ".openclaw");
  const decision = decideExec(
    process.argv.slice(2),
    env,
    new ApprovalTokenStore(approvalTokenPath(stateDir)),
  );
  audit(decision.decision, decision.label);
  if (!decision.run) {
    process.stderr.write(`${decision.message}\n`);
    process.exit(3);
  }
  const real = env["A3_GOG_REAL"] ?? "/usr/local/libexec/gog-real";
  const result = spawnSync(real, decision.args, { stdio: "inherit", env });
  process.exit(result.status ?? 1);
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) main();
