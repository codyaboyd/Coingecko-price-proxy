const fs = require('fs');
const path = require('path');

const { MIGRATIONS } = require('../db/migrations');
const { openDatabase, resolveDatabasePath } = require('../db/node-sqlite');
const { validateAssetsFile } = require('./asset-service');
const { loadServerConfig } = require('../utils/config');
const { resolveFromRoot } = require('../utils/files');

const REQUIRED_DIRECTORY_NAMES = ['config', 'data', 'database'];
const CRITICAL = 'critical';
const NON_CRITICAL = 'non-critical';

function createResult(id, label, severity, ok, summary, details = null) {
  return { id, label, severity, ok, status: ok ? 'ok' : (severity === CRITICAL ? 'critical' : 'warning'), summary, details };
}

function uniquePaths(paths) {
  const seen = new Set();
  return paths.filter((item) => {
    const key = item.path;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function ensureDirectoryWritable(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
  fs.accessSync(directoryPath, fs.constants.W_OK);
}

function ensureDirectoryReadable(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
  fs.accessSync(directoryPath, fs.constants.R_OK);
}

function getStartupPaths(config) {
  const dataDir = resolveFromRoot(config.dataDir || './data');
  const logDir = resolveFromRoot(config.logDir || './logs');
  const databasePath = resolveDatabasePath(config.databasePath || './data/history.sqlite');

  return {
    configDir: resolveFromRoot(config.configDir || './config'),
    dataDir,
    logDir,
    databasePath,
    databaseDir: path.dirname(databasePath),
    assetsConfigPath: resolveFromRoot(config.assetsConfigPath || './config/assets.json'),
    importDir: resolveFromRoot(path.join(config.dataDir || './data', 'imports')),
    backupDir: resolveFromRoot(path.join(config.dataDir || './data', 'backups'))
  };
}

function checkRequiredDirectories(paths) {
  const directories = uniquePaths([
    { name: 'config', path: paths.configDir },
    { name: 'data', path: paths.dataDir },
    { name: 'database', path: paths.databaseDir }
  ]);

  const created = [];
  directories.forEach((directory) => {
    const existed = fs.existsSync(directory.path);
    ensureDirectoryWritable(directory.path);
    created.push({ ...directory, existed });
  });

  return createResult(
    'required_directories',
    'Required directories',
    CRITICAL,
    true,
    `${created.length} required director${created.length === 1 ? 'y' : 'ies'} available`,
    { directories: created, required: REQUIRED_DIRECTORY_NAMES }
  );
}

function checkSqliteOpen(config) {
  const db = openDatabase(config.databasePath);

  try {
    db.prepare('SELECT 1 AS ok').get();
    return {
      result: createResult('sqlite_open', 'SQLite database can be opened', CRITICAL, true, 'SQLite database opened successfully', {
        path: resolveDatabasePath(config.databasePath)
      }),
      db
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

function getAppliedVersionsWithoutMigrating(db) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();

  if (!table) {
    return [];
  }

  return db.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all().map((row) => row.version);
}

function checkMigrationsCurrent(db) {
  const expectedVersions = MIGRATIONS.map((migration) => migration.version);
  const expectedSet = new Set(expectedVersions);
  const appliedVersions = getAppliedVersionsWithoutMigrating(db);
  const appliedSet = new Set(appliedVersions);
  const pending = MIGRATIONS.filter((migration) => !appliedSet.has(migration.version));
  const unknown = appliedVersions.filter((version) => !expectedSet.has(version));
  const ok = pending.length === 0 && unknown.length === 0;

  return createResult(
    'migrations_current',
    'Migrations are current',
    CRITICAL,
    ok,
    ok ? `Current at version ${Math.max(...expectedVersions)}` : `${pending.length} pending, ${unknown.length} unknown`,
    {
      expectedVersions,
      appliedVersions,
      pending: pending.map((migration) => ({ version: migration.version, name: migration.name })),
      unknown
    }
  );
}

function checkAssetsValid(config) {
  const assets = validateAssetsFile(config.assetsConfigPath);
  return createResult('assets_config_valid', 'config/assets.json is valid', CRITICAL, true, `${assets.length} asset(s) validated`, {
    path: resolveFromRoot(config.assetsConfigPath),
    assetCount: assets.length
  });
}

function checkAdminCredentials(config) {
  const auth = config.adminAuth || {};
  const missing = [];

  if (!auth.username) missing.push('ADMIN_USERNAME');
  if (!auth.password) missing.push('ADMIN_PASSWORD');
  if (!auth.sessionSecret) missing.push('ADMIN_SESSION_SECRET');

  const ok = missing.length === 0;
  return createResult(
    'admin_credentials_configured',
    'Admin credentials are configured',
    CRITICAL,
    ok,
    ok ? 'Admin credentials configured' : `Missing ${missing.join(', ')}`,
    { missing }
  );
}

function parseIntegerEnv(name, options = {}) {
  const raw = process.env[name];

  if (raw === undefined || raw === null || raw === '') {
    return null;
  }

  const parsed = Number(raw);
  const min = options.min === undefined ? 1 : options.min;

  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`${name} must be an integer greater than or equal to ${min}. Received: ${raw}`);
  }

  return parsed;
}

function checkCoinGeckoConfig() {
  const errors = [];
  const baseUrl = (process.env.COINGECKO_API_BASE || 'https://api.coingecko.com/api/v3').trim();
  const apiKey = process.env.COINGECKO_API_KEY || '';
  const apiKeyType = (process.env.COINGECKO_API_KEY_TYPE || (apiKey ? 'demo' : 'none')).trim().toLowerCase();

  try {
    const parsedUrl = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      errors.push('COINGECKO_API_BASE must use http or https.');
    }
  } catch (error) {
    errors.push(`COINGECKO_API_BASE must be a valid URL: ${error.message}`);
  }

  if (!['demo', 'pro', 'none'].includes(apiKeyType)) {
    errors.push('COINGECKO_API_KEY_TYPE must be one of: demo, pro, none.');
  }

  ['COINGECKO_TIMEOUT_MS', 'COINGECKO_RATE_LIMIT_PAUSE_MS', 'COINGECKO_BACKOFF_MS', 'COINGECKO_MAX_CALLS_PER_MINUTE'].forEach((name) => {
    try {
      parseIntegerEnv(name, { min: 1 });
    } catch (error) {
      errors.push(error.message);
    }
  });

  try {
    parseIntegerEnv('COINGECKO_RETRIES', { min: 0 });
  } catch (error) {
    errors.push(error.message);
  }

  return createResult(
    'coingecko_config_valid',
    'CoinGecko config is syntactically valid',
    CRITICAL,
    errors.length === 0,
    errors.length === 0 ? 'CoinGecko config syntax is valid' : `${errors.length} CoinGecko config error(s)`,
    { errors, baseUrl, apiKeyType, apiKeyConfigured: Boolean(apiKey) }
  );
}

function checkImportDirectoryReadable(paths) {
  ensureDirectoryReadable(paths.importDir);
  return createResult('import_directory_readable', 'Import directory is readable', NON_CRITICAL, true, 'Import directory is readable', {
    path: paths.importDir
  });
}

function checkBackupDirectoryWritable(paths) {
  ensureDirectoryWritable(paths.backupDir);
  return createResult('backup_directory_writable', 'Backup directory is writable', NON_CRITICAL, true, 'Backup directory is writable', {
    path: paths.backupDir
  });
}

function checkLogDirectoryWritable(paths) {
  ensureDirectoryWritable(paths.logDir);
  return createResult('log_directory_writable', 'Log directory is writable', NON_CRITICAL, true, 'Log directory is writable', {
    path: paths.logDir
  });
}

function runCheck(results, id, label, severity, fn) {
  try {
    results.push(fn());
  } catch (error) {
    results.push(createResult(id, label, severity, false, error.message, { error: error.message }));
  }
}

function buildSelfCheckSummary(results) {
  const criticalFailures = results.filter((result) => !result.ok && result.severity === CRITICAL);
  const warnings = results.filter((result) => !result.ok && result.severity !== CRITICAL);

  return {
    ok: criticalFailures.length === 0,
    degraded: criticalFailures.length === 0 && warnings.length > 0,
    status: criticalFailures.length > 0 ? 'critical' : (warnings.length > 0 ? 'degraded' : 'ok'),
    criticalFailures,
    warnings
  };
}

function runStartupSelfCheck(options = {}) {
  const config = options.config || loadServerConfig();
  const paths = getStartupPaths(config);
  const results = [];
  let db = null;

  runCheck(results, 'required_directories', 'Required directories', CRITICAL, () => checkRequiredDirectories(paths));
  runCheck(results, 'sqlite_open', 'SQLite database can be opened', CRITICAL, () => {
    const opened = checkSqliteOpen(config);
    db = opened.db;
    return opened.result;
  });
  runCheck(results, 'migrations_current', 'Migrations are current', CRITICAL, () => {
    if (!db) {
      throw new Error('SQLite database was not opened; migration state cannot be checked.');
    }
    return checkMigrationsCurrent(db);
  });
  runCheck(results, 'assets_config_valid', 'config/assets.json is valid', CRITICAL, () => checkAssetsValid(config));
  runCheck(results, 'admin_credentials_configured', 'Admin credentials are configured', CRITICAL, () => checkAdminCredentials(config));
  runCheck(results, 'coingecko_config_valid', 'CoinGecko config is syntactically valid', CRITICAL, checkCoinGeckoConfig);
  runCheck(results, 'import_directory_readable', 'Import directory is readable', NON_CRITICAL, () => checkImportDirectoryReadable(paths));
  runCheck(results, 'backup_directory_writable', 'Backup directory is writable', NON_CRITICAL, () => checkBackupDirectoryWritable(paths));
  runCheck(results, 'log_directory_writable', 'Log directory is writable', NON_CRITICAL, () => checkLogDirectoryWritable(paths));

  if (db) {
    db.close();
  }

  return {
    generatedAt: Date.now(),
    generatedAtIso: new Date().toISOString(),
    config: {
      appName: config.appName,
      databasePath: config.databasePath,
      assetsConfigPath: config.assetsConfigPath,
      dataDir: config.dataDir,
      logDir: config.logDir
    },
    paths,
    checks: results,
    ...buildSelfCheckSummary(results)
  };
}

function formatSelfCheckResult(result) {
  const lines = [
    `Startup self-check status: ${result.status}`,
    `Generated: ${result.generatedAtIso}`
  ];

  result.checks.forEach((check) => {
    const marker = check.ok ? 'OK' : (check.severity === CRITICAL ? 'CRITICAL' : 'WARNING');
    lines.push(`[${marker}] ${check.label}: ${check.summary}`);
  });

  if (result.criticalFailures.length > 0) {
    lines.push('', 'Critical startup self-check failures:');
    result.criticalFailures.forEach((check) => {
      lines.push(`  - ${check.label}: ${check.summary}`);
    });
  }

  if (result.warnings.length > 0) {
    lines.push('', 'Non-critical startup self-check warnings (degraded mode):');
    result.warnings.forEach((check) => {
      lines.push(`  - ${check.label}: ${check.summary}`);
    });
  }

  return lines.join('\n');
}

module.exports = {
  CRITICAL,
  NON_CRITICAL,
  formatSelfCheckResult,
  runStartupSelfCheck
};
