#!/bin/sh
# A3 agent container entrypoint. Runs as the non-root `node` user.
# Order: verify config -> isolation report -> restore state -> Tailscale -> forwarder ->
# OpenClaw config -> gateway. On SIGTERM: stop gateway, snapshot state to the bucket, exit.
set -eu

MOUNT="${A3_STATE_MOUNT:-/mnt/agent-state}"
APP_DIR="/opt/a3"
SOCK="$HOME/.tailscale/tailscaled.sock"
GATEWAY_PORT=18789
BOOT_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# One JSON line to stdout (Cloud Logging) and one small object per event on the bucket.
# Object-per-event avoids appending to a file on GCS FUSE, which is not atomic.
event() {
  line="$(printf '{"severity":"%s","component":"a3-lifecycle","event":"%s","detail":"%s","boot_id":"%s","ts":"%s"}' \
    "$1" "$2" "$3" "$BOOT_ID" "$(now)")"
  printf '%s\n' "$line"
  if [ -d "$MOUNT/evidence/lifecycle" ]; then
    printf '%s\n' "$line" >"$MOUNT/evidence/lifecycle/$(date -u +%Y%m%dT%H%M%S)-$2-$$.json" || true
  fi
}

fail() {
  event ERROR "startup_failed" "$1"
  exit 1
}

# --- 1. Required configuration (names only; values are never printed) -----------------
for name in TAILSCALE_AUTHKEY OPENCLAW_GATEWAY_TOKEN TELEGRAM_BOT_TOKEN A3_OLLAMA_TAILNET_HOST; do
  eval "value=\${$name:-}"
  [ -n "$value" ] || fail "missing required env $name"
done
[ "${#OPENCLAW_GATEWAY_TOKEN}" -ge 16 ] || fail "OPENCLAW_GATEWAY_TOKEN shorter than 16 chars"

# --- 2. State mount must exist and be writable by this user --------------------------
[ -d "$MOUNT" ] || fail "state mount $MOUNT is absent"
mkdir -p "$MOUNT/evidence/lifecycle" "$MOUNT/evidence/isolation" "$MOUNT/backups" \
  "$MOUNT/tailscale" "$MOUNT/workspace" "$MOUNT/flags" || fail "state mount not writable"
event INFO "start" "container starting"

# --- 3. Isolation report (evidence for the security audit) ---------------------------
status_field() { awk -v k="$1:" '$1==k {print $2}' /proc/self/status; }
mounts_json="$(awk '{printf "%s{\"src\":\"%s\",\"dst\":\"%s\",\"type\":\"%s\"}", (NR>1?",":""), $1, $2, $3}' /proc/self/mounts)"
report="$(printf '{"severity":"INFO","component":"a3-isolation","ts":"%s","boot_id":"%s","uid":%s,"gid":%s,"user":"%s","cap_eff":"%s","cap_prm":"%s","cap_bnd":"%s","no_new_privs":"%s","seccomp":"%s","mounts":[%s]}' \
  "$(now)" "$BOOT_ID" "$(id -u)" "$(id -g)" "$(id -un)" \
  "$(status_field CapEff)" "$(status_field CapPrm)" "$(status_field CapBnd)" \
  "$(status_field NoNewPrivs)" "$(status_field Seccomp)" "$mounts_json")"
printf '%s\n' "$report"
printf '%s\n' "$report" >"$MOUNT/evidence/isolation/$BOOT_ID.json" || true
[ "$(id -u)" != "0" ] || fail "refusing to run as root"

# --- 4. Restore OpenClaw state from the newest bucket snapshot ------------------------
# Active SQLite state stays on local disk (unsafe on GCS FUSE); the bucket holds snapshots.
mkdir -p "$OPENCLAW_STATE_DIR"
STATE_PRESENT=0
if [ -e "$OPENCLAW_STATE_DIR/state/openclaw.sqlite" ]; then STATE_PRESENT=1; fi
latest="$(ls -1 "$MOUNT"/backups/*.tar.gz 2>/dev/null | sort | tail -n 1 || true)"
if [ -n "$latest" ] && [ ! -e "$OPENCLAW_STATE_DIR/state/openclaw.sqlite" ]; then
  stage="$(mktemp -d)/restore"
  if openclaw backup restore "$latest" --target "$stage" >/dev/null 2>&1; then
    db="$(find "$stage" -type f -name openclaw.sqlite -path '*/state/*' | head -n 1)"
    if [ -n "$db" ]; then
      src="$(dirname "$(dirname "$db")")"
      cp -a "$src/." "$OPENCLAW_STATE_DIR/"
      STATE_PRESENT=1
      event INFO "state_restored" "$(basename "$latest")"
    else
      event ERROR "state_restore_failed" "no state database found in archive"
    fi
  else
    event ERROR "state_restore_failed" "backup restore rejected $(basename "$latest")"
  fi
  rm -rf "$(dirname "$stage")"
else
  event INFO "state_fresh" "no snapshot restored"
fi

# --- 5. Tailscale (userspace, no TUN; identity persisted on the bucket) ---------------
mkdir -p "$HOME/.tailscale"
# Always use Tailscale's relay (DERP) path, never a direct UDP path. Measured on 2026-11-16:
# on a direct path from this instance, anything over about 1 KB was dropped (600 bytes
# passed, 1100 did not), so health checks worked while every real prompt hung for 300 s.
# Over the relay the same 120 KB request took 0.5 s. Relay is slower in theory and
# irrelevant at this traffic volume.
TS_DEBUG_ALWAYS_USE_DERP=true tailscaled --tun=userspace-networking --socks5-server=127.0.0.1:1055 \
  --state="$MOUNT/tailscale/tailscaled.state" --socket="$SOCK" >/dev/null 2>&1 &
i=0
until tailscale --socket="$SOCK" status --json >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 30 ] || break
  sleep 1
done
tailscale --socket="$SOCK" up --authkey="$TAILSCALE_AUTHKEY" \
  --hostname="${TAILSCALE_HOSTNAME:-a3-agent}" --advertise-tags=tag:a3-agent \
  || fail "tailscale up failed"
# OpenClaw runs `tailscale whois` on the default socket path to identify graders.
ln -sf "$SOCK" /var/run/tailscale/tailscaled.sock
tailscale --socket="$SOCK" serve --bg --https=443 "http://127.0.0.1:$GATEWAY_PORT" \
  || fail "tailscale serve failed"
event INFO "tailscale_up" "serve https 443 to gateway"

# --- 6. Ollama forwarder (loopback -> SOCKS5 -> desktop) ------------------------------
node "$APP_DIR/src/local/forwarderMain.ts" &
FORWARDER_PID=$!

# --- 6b. gog (Gmail/Calendar) settings for the wrapper --------------------------------
# The agent's tool sandbox may not pass environment variables through, so the wrapper also
# reads this owner-only file. It lives on the container's in-memory disk, never the bucket.
mkdir -p "$HOME/.a3" "${GOG_HOME:-$HOME/.openclaw/gogcli}"
(
  umask 077
  : >"$HOME/.a3/gog.env"
  for name in GOG_KEYRING_PASSWORD GOG_ACCOUNT GOG_HOME GOG_KEYRING_BACKEND A3_EMAIL_ALLOWLIST; do
    eval "value=\${$name:-}"
    if [ -n "$value" ]; then printf '%s=%s\n' "$name" "$value" >>"$HOME/.a3/gog.env"; fi
  done
)
# Same idea for the operator CLI (container/jobs.sh, `a3job` over SSH): an SSH session does
# not inherit the container's environment, so it reads the gateway token from here.
(
  umask 077
  printf 'OPENCLAW_GATEWAY_TOKEN=%s\n' "$OPENCLAW_GATEWAY_TOKEN" >"$HOME/.a3/cli.env"
)
if [ -n "${GOG_KEYRING_PASSWORD:-}" ] && [ -n "${GOG_ACCOUNT:-}" ]; then
  event INFO "gog_env" "account and keyring password present"
else
  event WARNING "gog_env" "GOG_ACCOUNT or GOG_KEYRING_PASSWORD missing; email and calendar disabled"
fi

# --- 7. OpenClaw configuration (idempotent) ------------------------------------------
openclaw config patch --file "$APP_DIR/config/openclaw.patch.json5" >/dev/null \
  || fail "base config patch rejected"
install_router() {
  openclaw plugins install --link "$APP_DIR" --force --accept-capabilities >/dev/null
}
# Every CLI call costs about a minute on 1 vCPU. Fresh state cannot contain the plugin, so
# only ask "is it installed?" when earlier state exists.
if [ "$STATE_PRESENT" = "0" ] || ! openclaw plugins list 2>/dev/null | grep -q "a3-router"; then
  if ! install_router; then
    # Seen once on a CPU-starved boot ("no valid plugin manifest"). One bounded retry, logged.
    event WARNING "plugin_install_retry" "first attempt failed, retrying once after 10s"
    sleep 10
    install_router || fail "router plugin install failed"
  fi
fi
openclaw config patch --file "$APP_DIR/config/openclaw.container.patch.json5" >/dev/null \
  || fail "container config patch rejected"
openclaw config validate >/dev/null || fail "config validate failed"
event INFO "config_applied" "router plugin linked and config valid"

# --- 8. Graceful shutdown: stop gateway, snapshot state, then exit --------------------
snapshot_state() {
  out="$(mktemp -d)"
  if openclaw backup create --output "$out" --no-include-workspace --verify >/dev/null 2>&1; then
    archive="$(ls -1 "$out"/*.tar.gz 2>/dev/null | head -n 1)"
    if [ -n "$archive" ] && cp "$archive" "$MOUNT/backups/"; then
      event INFO "state_snapshot" "$(basename "$archive")"
      # Keep the five newest snapshots.
      ls -1 "$MOUNT"/backups/*.tar.gz | sort | head -n -5 | while read -r old; do rm -f "$old"; done
    else
      event ERROR "state_snapshot_failed" "copy to bucket failed"
    fi
  else
    event ERROR "state_snapshot_failed" "backup create failed"
  fi
  rm -rf "$out"
}

shutdown() {
  event INFO "shutdown_begin" "signal received"
  kill -TERM "$GATEWAY_PID" 2>/dev/null || true
  wait "$GATEWAY_PID" 2>/dev/null || true
  snapshot_state
  kill -TERM "$FORWARDER_PID" 2>/dev/null || true
  event INFO "shutdown_complete" "state flushed"
  exit 0
}
trap shutdown TERM INT

# --- 9. Gateway -----------------------------------------------------------------------
openclaw gateway run --port "$GATEWAY_PORT" --bind lan &
GATEWAY_PID=$!
event INFO "gateway_started" "pid $GATEWAY_PID"
# Create any missing scheduled job once the gateway answers (bounded wait inside jobs.sh).
sh "$APP_DIR/container/jobs.sh" ensure &
set +e
wait "$GATEWAY_PID"
code=$?
set -e
event ERROR "gateway_exited" "exit code $code"
snapshot_state
exit "$code"
