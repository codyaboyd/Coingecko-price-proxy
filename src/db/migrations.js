const MIGRATIONS = [
  {
    version: 1,
    name: 'create_initial_history_schema',
    up: `
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        name TEXT NOT NULL,
        coingecko_id TEXT NOT NULL,
        vs_currency TEXT NOT NULL DEFAULT 'usd',
        enabled INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS candles (
        asset_id TEXT NOT NULL,
        vs_currency TEXT NOT NULL,
        interval TEXT NOT NULL,
        ts INTEGER NOT NULL,
        open REAL,
        high REAL,
        low REAL,
        close REAL NOT NULL,
        volume REAL,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY(asset_id, vs_currency, interval, ts),
        FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS fetch_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id TEXT NOT NULL,
        vs_currency TEXT NOT NULL,
        interval TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        status TEXT NOT NULL,
        candles_fetched INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS import_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id TEXT,
        source_path TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        status TEXT NOT NULL,
        rows_imported INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS api_cache (
        cache_key TEXT PRIMARY KEY,
        response_json TEXT NOT NULL,
        status_code INTEGER NOT NULL DEFAULT 200,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_candles_history
        ON candles(asset_id, vs_currency, interval, ts);

      CREATE INDEX IF NOT EXISTS idx_fetch_runs_asset_started
        ON fetch_runs(asset_id, started_at);

      CREATE INDEX IF NOT EXISTS idx_import_runs_asset_created
        ON import_runs(asset_id, created_at);
    `
  },
  {
    version: 2,
    name: 'add_candle_market_cap',
    up: `
      ALTER TABLE candles ADD COLUMN market_cap REAL;
    `
  },
  {
    version: 3,
    name: 'add_manual_fetch_run_columns',
    up: `
      ALTER TABLE fetch_runs ADD COLUMN range_from INTEGER;
      ALTER TABLE fetch_runs ADD COLUMN range_to INTEGER;
      ALTER TABLE fetch_runs ADD COLUMN source TEXT NOT NULL DEFAULT 'coingecko';
      ALTER TABLE fetch_runs ADD COLUMN points_inserted INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE fetch_runs ADD COLUMN error TEXT;
      ALTER TABLE fetch_runs ADD COLUMN finished_at INTEGER;
    `
  },
  {
    version: 4,
    name: 'add_import_run_audit_columns',
    up: `
      ALTER TABLE import_runs ADD COLUMN filename TEXT;
      ALTER TABLE import_runs ADD COLUMN vs_currency TEXT;
      ALTER TABLE import_runs ADD COLUMN detected_format TEXT;
      ALTER TABLE import_runs ADD COLUMN rows_seen INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE import_runs ADD COLUMN error TEXT;
    `
  },
  {
    version: 5,
    name: 'add_durable_jobs_queue',
    up: `
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        priority INTEGER NOT NULL DEFAULT 100,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'delayed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        run_after INTEGER NOT NULL,
        locked_at INTEGER,
        locked_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_runnable
        ON jobs(status, run_after, priority, id);

      CREATE INDEX IF NOT EXISTS idx_jobs_locked
        ON jobs(status, locked_at);

      CREATE INDEX IF NOT EXISTS idx_jobs_updated
        ON jobs(status, updated_at);
    `
  },
  {
    version: 6,
    name: 'add_config_change_history',
    up: `
      CREATE TABLE IF NOT EXISTS config_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        backup_path TEXT NOT NULL,
        changed_by TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_config_changes_created
        ON config_changes(created_at DESC, id DESC);

      CREATE INDEX IF NOT EXISTS idx_config_changes_file_created
        ON config_changes(file_path, created_at DESC, id DESC);
    `
  },
  {
    version: 7,
    name: 'add_admin_activity_log',
    up: `
      CREATE TABLE IF NOT EXISTS admin_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT,
        entity_id TEXT,
        details_json TEXT,
        ip_address TEXT,
        user_agent TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_admin_events_created
        ON admin_events(created_at DESC, id DESC);

      CREATE INDEX IF NOT EXISTS idx_admin_events_action_created
        ON admin_events(action, created_at DESC, id DESC);

      CREATE INDEX IF NOT EXISTS idx_admin_events_entity_created
        ON admin_events(entity_type, created_at DESC, id DESC);
    `

  },
  {
    version: 8,
    name: 'add_alerts_table',
    up: `
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        severity TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        entity_type TEXT,
        entity_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('open', 'acknowledged', 'resolved')),
        created_at INTEGER NOT NULL,
        acknowledged_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_alerts_status_created
        ON alerts(status, created_at DESC, id DESC);

      CREATE INDEX IF NOT EXISTS idx_alerts_type_entity_status
        ON alerts(type, entity_type, entity_id, status);
    `

  },
  {
    version: 9,
    name: 'add_import_files_inbox',
    up: `
      CREATE TABLE IF NOT EXISTS import_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        full_path TEXT NOT NULL,
        file_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('pending', 'previewed', 'converted', 'imported', 'failed', 'archived')),
        detected_format TEXT,
        asset_id TEXT,
        interval TEXT,
        rows_seen INTEGER NOT NULL DEFAULT 0,
        rows_imported INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_import_files_status_updated
        ON import_files(status, updated_at DESC, id DESC);

      CREATE INDEX IF NOT EXISTS idx_import_files_hash
        ON import_files(file_hash);
    `
  }
];

function ensureMigrationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
}

function getAppliedMigrationVersions(db) {
  ensureMigrationTable(db);

  const rows = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version ASC')
    .all();

  return new Set(rows.map((row) => row.version));
}

function runMigrations(db) {
  const appliedVersions = getAppliedMigrationVersions(db);
  const pendingMigrations = MIGRATIONS.filter((migration) => !appliedVersions.has(migration.version));

  if (pendingMigrations.length === 0) {
    return [];
  }

  const applyMigrations = db.transaction((migrations) => {
    const insertMigration = db.prepare(`
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (@version, @name, @appliedAt)
    `);

    migrations.forEach((migration) => {
      db.exec(migration.up);
      insertMigration.run({
        version: migration.version,
        name: migration.name,
        appliedAt: Date.now()
      });
    });
  });

  applyMigrations(pendingMigrations);

  return pendingMigrations.map((migration) => ({
    version: migration.version,
    name: migration.name
  }));
}

module.exports = {
  MIGRATIONS,
  runMigrations
};
