#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

SESSION_NAME="chrono-cache"
LOG_FILE="logs/server.log"
REQUIRED_DIRS=(logs data data/imports data/exports data/backups)

session_exists() {
  screen -list | awk '{print $1}' | grep -qx "[0-9]*\.${SESSION_NAME}"
}

print_usage_commands() {
  echo "Attach to the running app:"
  echo "  screen -r ${SESSION_NAME}"
  echo "Watch server logs:"
  echo "  tail -f ${LOG_FILE}"
}

for dir in "${REQUIRED_DIRS[@]}"; do
  mkdir -p "$dir"
done

touch "$LOG_FILE"

if ! command -v screen >/dev/null 2>&1; then
  echo "Error: screen is required to run the app in a managed session." >&2
  exit 1
fi

if session_exists; then
  echo "A screen session named ${SESSION_NAME} is already running. Not starting a duplicate."
  print_usage_commands
  exit 0
fi

RUNTIME=""
PACKAGE_RUNNER=""
INSTALL_CMD=()

if [ "${USE_BUN:-0}" = "1" ]; then
  if command -v bun >/dev/null 2>&1; then
    RUNTIME="bun"
    PACKAGE_RUNNER="bun run"
    INSTALL_CMD=(bun install)
  elif command -v node >/dev/null 2>&1; then
    echo "USE_BUN=1 was set, but bun was not found. Falling back to node."
    RUNTIME="node"
    PACKAGE_RUNNER="npm run"
    INSTALL_CMD=(npm install)
  fi
else
  if command -v node >/dev/null 2>&1; then
    RUNTIME="node"
    PACKAGE_RUNNER="npm run"
    INSTALL_CMD=(npm install)
  elif command -v bun >/dev/null 2>&1; then
    RUNTIME="bun"
    PACKAGE_RUNNER="bun run"
    INSTALL_CMD=(bun install)
  fi
fi

if [ -z "$RUNTIME" ]; then
  echo "Error: neither node nor bun was found. Install Node.js or Bun and try again." >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "node_modules is missing. Installing dependencies with: ${INSTALL_CMD[*]}"
  "${INSTALL_CMD[@]}"
fi

echo "Running database migrations..."
$PACKAGE_RUNNER migrate

echo "Validating assets..."
$PACKAGE_RUNNER validate-assets

echo "Starting ${SESSION_NAME} with ${RUNTIME}. Logs: ${LOG_FILE}"
screen -dmS "$SESSION_NAME" bash -lc "printf '\n[%s] Starting chrono-cache with ${RUNTIME}\n' \"\$(date -Is)\" >> '${LOG_FILE}'; exec ${RUNTIME} server.js >> '${LOG_FILE}' 2>&1"

print_usage_commands
