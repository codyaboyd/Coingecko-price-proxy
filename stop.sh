#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

SESSION_NAME="chrono-cache"

session_exists() {
  screen -list | awk '{print $1}' | grep -qx "[0-9]*\.${SESSION_NAME}"
}

if ! command -v screen >/dev/null 2>&1; then
  echo "Error: screen is required to stop the managed session." >&2
  exit 1
fi

if ! session_exists; then
  echo "No screen session named ${SESSION_NAME} is running."
  exit 0
fi

echo "Stopping ${SESSION_NAME}..."
screen -S "$SESSION_NAME" -X stuff $'\003'

for _ in {1..10}; do
  if ! session_exists; then
    echo "Stopped ${SESSION_NAME}."
    exit 0
  fi
  sleep 1
done

echo "Session did not exit after Ctrl-C; closing screen session."
screen -S "$SESSION_NAME" -X quit

echo "Stopped ${SESSION_NAME}."
