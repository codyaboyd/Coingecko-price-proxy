const { MIGRATIONS } = require('../db/migrations');

const EXPECTED_TABLES = [
  'admin_events',
  'api_cache',
  'assets',
  'candles',
  'config_changes',
  'fetch_runs',
  'import_runs',
  'jobs',
  'schema_migrations'
];

const CANDLE_PRIMARY_KEY_COLUMNS = ['asset_id', 'vs_currency', 'interval', 'ts'];
const MAX_SQLITE_DATE_MS = 253402300799999;
const DEFAULT_STUCK_FETCH_RUN_MS = 60 * 60 * 1000;
const CURRENT_MIGRATION_VERSION = MIGRATIONS.reduce((max, migration) => Math.max(max, migration.version), 0);

function isoOrNull(value) {
  return value === null || value === undefined ? null : new Date(value).toISOString();
}

function createCheck(id, label, status, summary, options = {}) {
  return {
    id,
    label,
    status,
    summary,
    details: options.details || [],
    repairCommands: options.repairCommands || []
  };
}


function getTables(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
}

function getExistingTables(db) {
  return new Set(getTables(db));
}

function hasTable(existingTables, tableName) {
  return existingTables.has(tableName);
}

function countRows(db, sql, params = {}) {
  return db.prepare(sql).get(params).count;
}

function sampleRows(db, sql, params = {}, limit = 20) {
  return db.prepare(`${sql}\nLIMIT @limit`).all({ ...params, limit });
}

function buildIntegrityCheck(db) {
  let rows;

  try {
    rows = db.prepare('PRAGMA integrity_check').all();
  } catch (error) {
    return createCheck('pragma_integrity_check', 'PRAGMA integrity_check', 'critical', error.message, {
      repairCommands: [
        'npm run backup-db',
        'sqlite3 <database-path> "PRAGMA integrity_check;"',
        'Restore from a known-good backup if SQLite reports corruption.'
      ]
    });
  }

  const messages = rows.map((row) => row.integrity_check || Object.values(row)[0]);
  const ok = messages.length === 1 && messages[0] === 'ok';

  return createCheck(
    'pragma_integrity_check',
    'PRAGMA integrity_check',
    ok ? 'ok' : 'critical',
    ok ? 'SQLite reported ok.' : `SQLite reported ${messages.length} issue(s).`,
    {
      details: ok ? [] : messages.map((message) => ({ message })),
      repairCommands: ok ? [] : [
        'npm run backup-db',
        'sqlite3 <database-path> "PRAGMA integrity_check;"',
        'Restore from a known-good backup if SQLite reports corruption.'
      ]
    }
  );
}

function buildExpectedTablesCheck(existingTables) {
  const missingTables = EXPECTED_TABLES.filter((table) => !existingTables.has(table));

  return createCheck(
    'expected_tables',
    'Expected tables exist',
    missingTables.length === 0 ? 'ok' : 'critical',
    missingTables.length === 0 ? `All ${EXPECTED_TABLES.length} expected tables exist.` : `${missingTables.length} expected table(s) missing.`,
    {
      details: missingTables.map((table) => ({ table })),
      repairCommands: missingTables.length === 0 ? [] : ['npm run migrate']
    }
  );
}

function buildMigrationVersionCheck(db, existingTables) {
  if (!hasTable(existingTables, 'schema_migrations')) {
    return createCheck('migration_version_current', 'Migration version current', 'critical', 'schema_migrations table is missing.', {
      repairCommands: ['npm run migrate']
    });
  }

  const currentVersion = countRows(db, 'SELECT COALESCE(MAX(version), 0) AS count FROM schema_migrations');
  const pendingVersions = MIGRATIONS.filter((migration) => migration.version > currentVersion).map((migration) => migration.version);
  const status = currentVersion === CURRENT_MIGRATION_VERSION ? 'ok' : 'critical';

  return createCheck(
    'migration_version_current',
    'Migration version current',
    status,
    status === 'ok'
      ? `Database is at migration version ${currentVersion}.`
      : `Database is at migration version ${currentVersion}; expected ${CURRENT_MIGRATION_VERSION}.`,
    {
      details: pendingVersions.map((version) => ({ version })),
      repairCommands: status === 'ok' ? [] : ['npm run migrate']
    }
  );
}

function buildCandlePrimaryKeyCheck(db, existingTables) {
  if (!hasTable(existingTables, 'candles')) {
    return createCheck('duplicate_candles_impossible', 'Duplicate candles impossible due to PK', 'critical', 'candles table is missing.', {
      repairCommands: ['npm run migrate']
    });
  }

  const columns = db.prepare('PRAGMA table_info(candles)').all();
  const primaryKeyColumns = columns
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name);
  const pkMatches = CANDLE_PRIMARY_KEY_COLUMNS.length === primaryKeyColumns.length
    && CANDLE_PRIMARY_KEY_COLUMNS.every((column, index) => primaryKeyColumns[index] === column);

  return createCheck(
    'duplicate_candles_impossible',
    'Duplicate candles impossible due to PK',
    pkMatches ? 'ok' : 'critical',
    pkMatches
      ? `candles primary key is (${CANDLE_PRIMARY_KEY_COLUMNS.join(', ')}).`
      : `candles primary key is (${primaryKeyColumns.join(', ') || 'none'}), expected (${CANDLE_PRIMARY_KEY_COLUMNS.join(', ')}).`,
    {
      details: primaryKeyColumns.map((column) => ({ column })),
      repairCommands: pkMatches ? [] : [
        'npm run backup-db',
        'npm run migrate',
        'Rebuild the candles table from a backup or export with PRIMARY KEY(asset_id, vs_currency, interval, ts).'
      ]
    }
  );
}

function buildNullCloseCheck(db, existingTables) {
  if (!hasTable(existingTables, 'candles')) {
    return createCheck('candles_null_close', 'Candles with null close', 'critical', 'candles table is missing.');
  }

  const count = countRows(db, 'SELECT COUNT(*) AS count FROM candles WHERE close IS NULL');
  return createCheck(
    'candles_null_close',
    'Candles with null close',
    count === 0 ? 'ok' : 'critical',
    count === 0 ? 'No candles have a null close.' : `${count} candle(s) have a null close.`,
    {
      details: count === 0 ? [] : sampleRows(db, `
        SELECT asset_id, vs_currency, interval, ts, close
        FROM candles
        WHERE close IS NULL
        ORDER BY asset_id, vs_currency, interval, ts
      `),
      repairCommands: count === 0 ? [] : [
        'npm run backup-db',
        'sqlite3 <database-path> "SELECT asset_id, vs_currency, interval, ts FROM candles WHERE close IS NULL LIMIT 20;"',
        'Re-import or refetch the affected asset/range; do not delete rows until a backup exists.'
      ]
    }
  );
}

function buildInvalidTimestampCheck(db, existingTables) {
  if (!hasTable(existingTables, 'candles')) {
    return createCheck('candles_invalid_timestamps', 'Candles with invalid timestamps', 'critical', 'candles table is missing.');
  }

  const whereClause = "ts IS NULL OR typeof(ts) != 'integer' OR ts < 0 OR ts > @maxTimestamp";
  const params = { maxTimestamp: MAX_SQLITE_DATE_MS };
  const count = countRows(db, `SELECT COUNT(*) AS count FROM candles WHERE ${whereClause}`, params);

  return createCheck(
    'candles_invalid_timestamps',
    'Candles with invalid timestamps',
    count === 0 ? 'ok' : 'critical',
    count === 0 ? 'All candle timestamps are valid millisecond timestamps.' : `${count} candle(s) have invalid timestamps.`,
    {
      details: count === 0 ? [] : sampleRows(db, `
        SELECT asset_id, vs_currency, interval, ts, typeof(ts) AS ts_type
        FROM candles
        WHERE ${whereClause}
        ORDER BY asset_id, vs_currency, interval, ts
      `, params),
      repairCommands: count === 0 ? [] : [
        'npm run backup-db',
        `sqlite3 <database-path> "SELECT asset_id, vs_currency, interval, ts, typeof(ts) FROM candles WHERE ts IS NULL OR typeof(ts) != 'integer' OR ts < 0 LIMIT 20;"`,
        'Re-import or refetch rows whose timestamps cannot be corrected from the source data.'
      ]
    }
  );
}

function buildImpossibleOhlcCheck(db, existingTables) {
  if (!hasTable(existingTables, 'candles')) {
    return createCheck('candles_impossible_ohlc', 'Candles with impossible OHLC values', 'critical', 'candles table is missing.');
  }

  const whereClause = `
    (high IS NOT NULL AND low IS NOT NULL AND high < low)
    OR (close IS NOT NULL AND high IS NOT NULL AND close > high)
    OR (close IS NOT NULL AND low IS NOT NULL AND close < low)
  `;
  const count = countRows(db, `SELECT COUNT(*) AS count FROM candles WHERE ${whereClause}`);

  return createCheck(
    'candles_impossible_ohlc',
    'Candles with impossible OHLC values',
    count === 0 ? 'ok' : 'critical',
    count === 0 ? 'No impossible OHLC values were found.' : `${count} candle(s) have impossible OHLC values.`,
    {
      details: count === 0 ? [] : sampleRows(db, `
        SELECT asset_id, vs_currency, interval, ts, open, high, low, close
        FROM candles
        WHERE ${whereClause}
        ORDER BY asset_id, vs_currency, interval, ts
      `),
      repairCommands: count === 0 ? [] : [
        'npm run backup-db',
        'sqlite3 <database-path> "SELECT asset_id, vs_currency, interval, ts, open, high, low, close FROM candles WHERE (high IS NOT NULL AND low IS NOT NULL AND high < low) OR (close IS NOT NULL AND high IS NOT NULL AND close > high) OR (close IS NOT NULL AND low IS NOT NULL AND close < low) LIMIT 20;"',
        'Re-import or refetch the affected asset/range from the original source.'
      ]
    }
  );
}

function buildAssetsWithoutCandlesCheck(db, existingTables) {
  if (!hasTable(existingTables, 'assets') || !hasTable(existingTables, 'candles')) {
    return createCheck('assets_without_candles', 'Assets without candles', 'critical', 'assets or candles table is missing.');
  }

  const rows = db.prepare(`
    SELECT assets.id, assets.symbol, assets.vs_currency, assets.enabled
    FROM assets
    LEFT JOIN candles ON candles.asset_id = assets.id AND candles.vs_currency = assets.vs_currency
    GROUP BY assets.id, assets.symbol, assets.vs_currency, assets.enabled
    HAVING COUNT(candles.ts) = 0
    ORDER BY assets.priority ASC, assets.symbol ASC
  `).all();

  return createCheck(
    'assets_without_candles',
    'Assets without candles',
    rows.length === 0 ? 'ok' : 'warning',
    rows.length === 0 ? 'Every asset has at least one candle.' : `${rows.length} asset(s) have no candles.`,
    {
      details: rows,
      repairCommands: rows.length === 0 ? [] : [
        'npm run repair-gaps -- --asset <asset-id> --from <YYYY-MM-DD> --to <YYYY-MM-DD> --interval 1d',
        'Or use Admin → Assets → Fetch recent for the affected asset.'
      ]
    }
  );
}

function getFetchRunColumns(db, existingTables) {
  if (!hasTable(existingTables, 'fetch_runs')) {
    return [];
  }

  return db.prepare('PRAGMA table_info(fetch_runs)').all().map((column) => column.name);
}

function getStuckFetchRuns(db, existingTables, options = {}) {
  const columns = getFetchRunColumns(db, existingTables);

  if (columns.length === 0 || !columns.includes('status') || !columns.includes('started_at')) {
    return [];
  }

  const now = options.now || Date.now();
  const stuckAfterMs = options.stuckAfterMs || DEFAULT_STUCK_FETCH_RUN_MS;
  const cutoff = now - stuckAfterMs;
  const selectColumns = [
    'id',
    'asset_id',
    'vs_currency',
    'interval',
    'started_at',
    columns.includes('ended_at') ? 'ended_at' : 'NULL AS ended_at',
    columns.includes('finished_at') ? 'finished_at' : 'NULL AS finished_at',
    'status',
    columns.includes('source') ? 'source' : 'NULL AS source'
  ];
  const unfinishedClause = columns.includes('finished_at') && columns.includes('ended_at')
    ? 'COALESCE(finished_at, ended_at) IS NULL'
    : (columns.includes('finished_at') ? 'finished_at IS NULL' : (columns.includes('ended_at') ? 'ended_at IS NULL' : '1 = 1'));

  return db.prepare(`
    SELECT ${selectColumns.join(', ')}
    FROM fetch_runs
    WHERE status = 'running'
      AND started_at <= @cutoff
      AND ${unfinishedClause}
    ORDER BY started_at ASC, id ASC
  `).all({ cutoff }).map((row) => ({
    ...row,
    started_at_iso: isoOrNull(row.started_at),
    age_ms: now - row.started_at
  }));
}

function buildStuckFetchRunsCheck(db, existingTables, options = {}) {
  if (!hasTable(existingTables, 'fetch_runs')) {
    return createCheck('fetch_runs_stuck_running', 'fetch_runs stuck in running state', 'critical', 'fetch_runs table is missing.');
  }

  const rows = getStuckFetchRuns(db, existingTables, options);

  return createCheck(
    'fetch_runs_stuck_running',
    'fetch_runs stuck in running state',
    rows.length === 0 ? 'ok' : 'warning',
    rows.length === 0 ? 'No stale running fetch_runs were found.' : `${rows.length} fetch_run(s) have been running for over ${Math.round((options.stuckAfterMs || DEFAULT_STUCK_FETCH_RUN_MS) / 60000)} minutes.`,
    {
      details: rows,
      repairCommands: rows.length === 0 ? [] : [
        'Use the Safe auto-mark-failed button on /admin/db-integrity.',
        `sqlite3 <database-path> "UPDATE fetch_runs SET status = 'failed', error = COALESCE(error, 'Marked failed after integrity check'), finished_at = strftime('%s','now') * 1000 WHERE status = 'running' AND finished_at IS NULL AND ended_at IS NULL;"`
      ]
    }
  );
}

function runDatabaseIntegrityCheck(db, options = {}) {
  const existingTables = getExistingTables(db);
  const checks = [
    buildIntegrityCheck(db),
    buildExpectedTablesCheck(existingTables),
    buildMigrationVersionCheck(db, existingTables),
    buildCandlePrimaryKeyCheck(db, existingTables),
    buildNullCloseCheck(db, existingTables),
    buildInvalidTimestampCheck(db, existingTables),
    buildImpossibleOhlcCheck(db, existingTables),
    buildAssetsWithoutCandlesCheck(db, existingTables),
    buildStuckFetchRunsCheck(db, existingTables, options)
  ];

  const summary = checks.reduce((accumulator, check) => {
    accumulator[check.status] = (accumulator[check.status] || 0) + 1;
    return accumulator;
  }, { ok: 0, warning: 0, critical: 0 });

  return {
    ok: summary.critical === 0,
    checkedAt: Date.now(),
    checkedAtIso: new Date().toISOString(),
    expectedTables: EXPECTED_TABLES,
    currentMigrationVersion: CURRENT_MIGRATION_VERSION,
    summary,
    checks
  };
}

function markStuckFetchRunsFailed(db, options = {}) {
  const existingTables = getExistingTables(db);
  const stuckRuns = getStuckFetchRuns(db, existingTables, options);

  if (stuckRuns.length === 0) {
    return { changed: 0, runs: [] };
  }

  const now = options.now || Date.now();
  const ids = stuckRuns.map((run) => run.id);
  const placeholders = ids.map((id) => `@id${id}`).join(', ');
  const params = ids.reduce((accumulator, id) => {
    accumulator[`id${id}`] = id;
    return accumulator;
  }, { now });

  const columns = getFetchRunColumns(db, existingTables);
  const setClauses = ["status = 'failed'"];

  if (columns.includes('finished_at')) {
    setClauses.push('finished_at = @now');
  }

  if (columns.includes('ended_at')) {
    setClauses.push('ended_at = @now');
  }

  if (columns.includes('error')) {
    setClauses.push("error = COALESCE(error, 'Marked failed by database integrity check')");
  }

  if (columns.includes('error_message')) {
    setClauses.push("error_message = COALESCE(error_message, 'Marked failed by database integrity check')");
  }

  const result = db.prepare(`
    UPDATE fetch_runs
    SET ${setClauses.join(', ')}
    WHERE id IN (${placeholders})
      AND status = 'running'
      AND ${columns.includes('finished_at') && columns.includes('ended_at') ? 'COALESCE(finished_at, ended_at) IS NULL' : (columns.includes('finished_at') ? 'finished_at IS NULL' : (columns.includes('ended_at') ? 'ended_at IS NULL' : '1 = 1'))}
  `).run(params);

  return {
    changed: result.changes,
    runs: stuckRuns
  };
}

module.exports = {
  CURRENT_MIGRATION_VERSION,
  DEFAULT_STUCK_FETCH_RUN_MS,
  EXPECTED_TABLES,
  markStuckFetchRunsFailed,
  runDatabaseIntegrityCheck
};
