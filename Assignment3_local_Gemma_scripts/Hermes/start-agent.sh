#!/bin/sh
# start-agent.sh — starts web_ui.py (chat UI + reverse proxy) on $PORT,
# then your agent on $HERMES_PORT.
set -eu

export PORT="${PORT:-8080}"
export HERMES_PORT="${HERMES_PORT:-8081}"

# Start the chat UI / reverse proxy in the background, and remember its PID
python3 /app/web_ui.py &
WEB_PID=$!
echo "web_ui started (pid $WEB_PID) on 0.0.0.0:$PORT -> agent on 127.0.0.1:$HERMES_PORT"

# Hermes API server settings
# IMPORTANT: Your agent must listen on 127.0.0.1:$HERMES_PORT, NOT on $PORT
export API_SERVER_ENABLED=true
export API_SERVER_PORT="$HERMES_PORT"
export API_SERVER_HOST="${API_SERVER_HOST:-127.0.0.1}"

# Start your agent in the background, and remember its PID
# (replace with YOUR actual agent startup command if it differs)
hermes gateway run &
AGENT_PID=$!

# Shutdown: stop BOTH processes (Cloud Run sends SIGTERM before stopping the container)
shutdown() {
  kill -TERM "$AGENT_PID" 2>/dev/null || true
  wait "$AGENT_PID" 2>/dev/null || true
  kill -TERM "$WEB_PID" 2>/dev/null || true
  wait "$WEB_PID" 2>/dev/null || true
}
trap 'shutdown; exit 0' TERM INT

# If either process dies, stop the other and exit, so the container is restarted
while kill -0 "$AGENT_PID" 2>/dev/null && kill -0 "$WEB_PID" 2>/dev/null; do
  sleep 2
done
shutdown
exit 1
