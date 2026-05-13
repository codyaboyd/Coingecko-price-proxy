#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BACKUP_ROOT="data/update-backups"

latest_emergency_backup() {
  find "$BACKUP_ROOT" -maxdepth 1 -type d -name 'emergency-*' -print 2>/dev/null | sort | tail -n 1
}

configured_database_path() {
  node -e "const fs = require('fs'); const path = require('path'); const cfg = JSON.parse(fs.readFileSync('config/server.json', 'utf8')); const db = process.env.DB_PATH || process.env.DATABASE_PATH || cfg.databasePath || './data/history.sqlite'; console.log(path.resolve(db));"
}

show_failure() {
  local message="$1"
  echo
  echo "Rollback stopped: ${message}"
  echo "Manual rollback instructions:"
  echo "  1. Find the newest backup under ${BACKUP_ROOT}/emergency-*"
  echo "  2. Stop the app with: ./stop.sh"
  echo "  3. Copy history.sqlite from that backup to the configured database path"
  echo "  4. Copy files from the backup config/ directory back into ./config/ if needed"
  echo "  5. Start the app with: ./start.sh"
}

restore_config_backup() {
  local backup_dir="$1"

  if [ -d "${backup_dir}/config" ]; then
    mkdir -p config
    cp -R "${backup_dir}/config/." config/
    echo "Restored previous config backup from ${backup_dir}/config."
  else
    echo "No config backup found in ${backup_dir}; skipping config restore."
  fi

  if [ -f "${backup_dir}/.env" ]; then
    cp "${backup_dir}/.env" .env
    echo "Restored previous .env backup."
  else
    echo "No .env backup found in ${backup_dir}; skipping .env restore."
  fi
}

backup_dir="$(latest_emergency_backup)"
if [ -z "$backup_dir" ]; then
  show_failure "no emergency backup was found under ${BACKUP_ROOT}."
  exit 1
fi

if [ ! -f "${backup_dir}/history.sqlite" ]; then
  show_failure "${backup_dir}/history.sqlite is missing."
  exit 1
fi

echo "Restoring latest emergency backup: ${backup_dir}"

echo "Stopping app before restore..."
if ! ./stop.sh; then
  show_failure "could not stop the app safely."
  exit 1
fi

db_path="$(configured_database_path)"
mkdir -p "$(dirname "$db_path")"

if [ -f "$db_path" ]; then
  rollback_copy="${db_path}.rollback-$(date -u +%Y-%m-%d-%H-%M-%S)"
  cp "$db_path" "$rollback_copy"
  echo "Saved current database copy to ${rollback_copy}."
fi

rm -f "${db_path}-wal" "${db_path}-shm"
cp "${backup_dir}/history.sqlite" "$db_path"
echo "Restored database to ${db_path}."

restore_config_backup "$backup_dir"

echo "Running migrations after restore..."
if ! npm run migrate; then
  show_failure "migrations failed after restore."
  exit 1
fi

echo "Starting app after rollback..."
if ! ./start.sh; then
  show_failure "the backup was restored, but the app did not start."
  exit 1
fi

echo
echo "Rollback completed successfully."
