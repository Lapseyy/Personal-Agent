#!/bin/sh
# Scheduled jobs: morning briefing, proactive alert, end-of-day recap.
#
#   jobs.sh ensure            create any job that is missing (run by the entrypoint)
#   jobs.sh list              show the jobs and their next run
#   jobs.sh run <job>         run one now: briefing | alert | recap (same delivery as scheduled)
#   jobs.sh runs <job>        recent run history of one job
#
# The jobs live in OpenClaw's scheduler (SQLite state, snapshotted to the bucket), so they
# survive restarts. `ensure` matches by exact name and only creates what is missing, so a
# restart never duplicates a job. Scheduled runs may only read and draft: the approval gate
# blocks any send or change from a cron-triggered run.
set -eu

APP_DIR=/opt/a3
OWNER="${A3_TELEGRAM_OWNER:-9144973888}"
TZ_NAME="America/Los_Angeles"

# From an SSH session (root): re-run as the agent user.
if [ "$(id -u)" = "0" ]; then
  exec runuser -u node -- sh "$APP_DIR/container/jobs.sh" "$@"
fi

export HOME=/home/node
export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
export OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$OPENCLAW_STATE_DIR/openclaw.json}"
export PATH=/usr/local/bin:/usr/bin:/bin
# The gateway token comes from Secret Manager into the container's environment. An SSH
# session does not have it, so the entrypoint leaves an owner-only copy for CLI calls.
if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ] && [ -r "$HOME/.a3/cli.env" ]; then
  set -a
  . "$HOME/.a3/cli.env"
  set +a
fi
cd "$HOME"

log() {
  printf '{"severity":"%s","component":"a3-jobs","event":"%s","detail":"%s","ts":"%s"}\n' \
    "$1" "$2" "$3" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

name_of() {
  case "$1" in
    briefing) echo "A3 Morning briefing" ;;
    alert) echo "A3 Proactive alert" ;;
    recap) echo "A3 End-of-day recap" ;;
    *) echo "" ;;
  esac
}

# Prints the id of the job with exactly this name, or nothing.
job_id() {
  openclaw automations list --all --json 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let j;
      try { j = JSON.parse(s); } catch { process.exit(0); }
      const all = Array.isArray(j) ? j : (j.jobs ?? j.items ?? j.automations ?? []);
      const m = all.find((x) => x && x.name === process.argv[1]);
      if (m) process.stdout.write(String(m.id ?? m.jobId ?? ""));
    });' "$1"
}

create_job() { # name schedule session prompt-file
  msg="$(cat "$APP_DIR/config/jobs/$4.txt")"
  err="$(openclaw automations create "$2" "$msg" --name "$1" --tz "$TZ_NAME" --exact \
    --session "$3" --announce --channel telegram --to "$OWNER" 2>&1 >/dev/null)" && return 0
  log WARNING "job_create_error" "$1 ($3): $(printf '%s' "$err" | tr '"\n\\' "'  " | cut -c1-240)"
  return 1
}

ensure_one() { # key schedule session
  name="$(name_of "$1")"
  if [ -n "$(job_id "$name")" ]; then
    log INFO "job_present" "$name"
    return 0
  fi
  if create_job "$name" "$2" "$3" "$1"; then
    log INFO "job_created" "$name ($2, $3 session)"
  elif [ "$3" = "main" ] && create_job "$name" "$2" isolated "$1"; then
    # The recap prefers the conversation's own session so it can see what was done today.
    log WARNING "job_created" "$name ($2, isolated session: main was rejected)"
  else
    log ERROR "job_create_failed" "$name"
  fi
}

case "${1:-}" in
  ensure)
    # Bounded wait for the gateway at startup (not a polling loop): at most 10 minutes.
    i=0
    until openclaw automations list --all --json >/dev/null 2>&1; do
      i=$((i + 1))
      if [ "$i" -gt 40 ]; then
        log ERROR "jobs_ensure_failed" "scheduler not reachable after 10 minutes"
        exit 1
      fi
      sleep 15
    done
    ensure_one briefing "30 7 * * *" isolated
    ensure_one alert "*/15 * * * *" isolated
    ensure_one recap "0 18 * * *" main
    ;;
  list)
    openclaw automations list --all
    ;;
  run | runs)
    name="$(name_of "${2:-}")"
    [ -n "$name" ] || { echo "usage: a3job $1 briefing|alert|recap" >&2; exit 2; }
    id="$(job_id "$name")"
    [ -n "$id" ] || { echo "job not found: $name (try: a3job ensure)" >&2; exit 1; }
    if [ "$1" = "run" ]; then
      log INFO "job_run_manual" "$name"
      openclaw automations run "$id" --wait --wait-timeout 10m
    else
      openclaw automations runs "$id" --limit 10
    fi
    ;;
  *)
    echo "usage: a3job ensure | list | run <briefing|alert|recap> | runs <briefing|alert|recap>" >&2
    exit 2
    ;;
esac
