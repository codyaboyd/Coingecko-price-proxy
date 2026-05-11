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
