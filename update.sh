#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

SESSION_NAME="chrono-cache"
BACKUP_ROOT="data/update-backups"
STAMP="$(date -u +%Y-%m-%d-%H-%M-%S)"
EMERGENCY_DIR="${BACKUP_ROOT}/emergency-${STAMP}"

show_rollback_instructions() {
  local failed_step="$1"
  echo
  echo "Update stopped during: ${failed_step}"
  echo "The app was not restarted by update.sh unless the failure happened during the final restart step."
  echo
  echo "Rollback instructions:"
  echo "  1. Review the backup created at: ${EMERGENCY_DIR}"
  echo "  2. Restore the latest emergency backup with: ./rollback.sh"
  echo "  3. Start the app again with: ./start.sh"
}

run_step() {
  local label="$1"
  shift

  echo
  echo "==> ${label}"
  if ! "$@"; then
    show_rollback_instructions "$label"
    exit 1
  fi
}

json_value() {
  local expression="$1"
  node -e "const fs = require('fs'); const cfg = JSON.parse(fs.readFileSync('config/server.json', 'utf8')); const value = (${expression}); if (value !== undefined && value !== null && value !== '') console.log(value);"
}

configured_database_path() {
  node -e "const fs = require('fs'); const path = require('path'); const cfg = JSON.parse(fs.readFileSync('config/server.json', 'utf8')); const db = process.env.DB_PATH || process.env.DATABASE_PATH || cfg.databasePath || './data/history.sqlite'; console.log(path.resolve(db));"
}

health_check_url() {
  local host port
  host="$(json_value "process.env.HOST || cfg.host || '127.0.0.1'")"
  port="$(json_value "process.env.PORT || cfg.port || 3000")"

  if [ "$host" = "0.0.0.0" ] || [ "$host" = "::" ]; then
    host="127.0.0.1"
  fi

  echo "http://${host}:${port}/health"
}

create_emergency_backup() {
  mkdir -p "$EMERGENCY_DIR/config"

  echo "Creating emergency update backup in ${EMERGENCY_DIR}..."
  npm run backup-db

  local latest_sqlite_backup db_path
  latest_sqlite_backup="$(find data/backups -maxdepth 1 -type f -name 'history-*.sqlite' -print 2>/dev/null | sort | tail -n 1)"
  if [ -n "$latest_sqlite_backup" ]; then
    cp "$latest_sqlite_backup" "${EMERGENCY_DIR}/history.sqlite"
  else
    db_path="$(configured_database_path)"
    if [ -f "$db_path" ]; then
      cp "$db_path" "${EMERGENCY_DIR}/history.sqlite"
      echo "Warning: no normal SQLite backup was found; copied the database file directly from ${db_path}."
    else
      echo "Warning: database file was not found at ${db_path}; no direct database copy was made."
    fi
  fi

  if [ -d config ]; then
    cp -R config/. "${EMERGENCY_DIR}/config/"
  fi

  if [ -f .env ]; then
    cp .env "${EMERGENCY_DIR}/.env"
  fi

  cat > "${EMERGENCY_DIR}/README.txt" <<BACKUP_NOTE
Emergency backup created before update.sh on ${STAMP} UTC.

Database copy: ${EMERGENCY_DIR}/history.sqlite
Config copy: ${EMERGENCY_DIR}/config/
Environment copy: ${EMERGENCY_DIR}/.env, if it existed

Restore with: ./rollback.sh
BACKUP_NOTE
}

echo "Starting safe update workflow for ${SESSION_NAME}."
run_step "create emergency backup" create_emergency_backup
run_step "install dependencies" npm install
run_step "run self-check" npm run self-check
run_step "run migrations" npm run migrate
run_step "run tests" npm run test
run_step "restart app" ./restart.sh

echo
echo "Update completed successfully."
echo "Final health check URL: $(health_check_url)"
