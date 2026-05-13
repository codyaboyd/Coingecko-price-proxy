#!/usr/bin/env node

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const { openDatabase } = require('../src/db/node-sqlite');
const { runMigrations } = require('../src/db/migrations');
const { getPublicAsset, upsertAssets } = require('../src/db/queries');
const { createScheduler } = require('../src/jobs/scheduler');
const { chunkMissingWindow } = require('../src/jobs/backfill-job');
const { getMissingWindows, INTERVAL_STEPS_MS } = require('../src/services/cache-policy');
const { getHistory, SUPPORTED_INTERVALS } = require('../src/services/history-service');
const { loadAssets, validateAssetsFile } = require('../src/services/asset-service');
const { fetchMarketChartRange } = require('../src/services/coingecko');
const { createBackupService } = require('../src/services/backup-service');
const { loadServerConfig } = require('../src/utils/config');
const { isMaintenanceMode, setMaintenanceMode } = require('../src/services/maintenance-service');
const { runDatabaseIntegrityCheck } = require('../src/services/db-integrity-service');

const DEFAULT_EXPORT_FORMAT = 'csv';
const EXPORT_FORMATS = new Set(['csv', 'json']);

function printUsage() {
  console.log('Usage:');
  console.log('  node scripts/cli.js migrate');
  console.log('  node scripts/cli.js validate-assets');
  console.log('  node scripts/cli.js db:check');
  console.log('  node scripts/cli.js backup');
  console.log('  node scripts/cli.js backups:list');
  console.log('  node scripts/cli.js backups:prune');
  console.log('  node scripts/cli.js export-history --asset <id> [--from <date>] [--to <date>] [--interval <5m|1h|1d>] [--vs <currency>] [--format <csv|json>] [--output <path>]');
  console.log('  node scripts/cli.js repair-gaps --asset <id> --from <date> --to <date> [--interval <5m|1h|1d>] [--vs <currency>]');
  console.log('  node scripts/cli.js queue-status');
  console.log('  node scripts/cli.js jobs:list');
  console.log('  node scripts/cli.js jobs:retry-failed');
  console.log('  node scripts/cli.js jobs:clear-completed');
  console.log('  node scripts/cli.js maintenance:on');
  console.log('  node scripts/cli.js maintenance:off');
  console.log('  node scripts/cli.js cg-test <coingecko-id> <vs-currency>');
  console.log('');
  console.log('Options may be passed as --name value or --name=value.');
}

function parseOptions(args) {
  const options = { _: [] };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg.startsWith('--')) {
      options._.push(arg);
      continue;
    }

    const withoutPrefix = arg.slice(2);
    const equalsIndex = withoutPrefix.indexOf('=');

    if (equalsIndex !== -1) {
      options[withoutPrefix.slice(0, equalsIndex)] = withoutPrefix.slice(equalsIndex + 1);
      continue;
    }

    const next = args[index + 1];

    if (next === undefined || next.startsWith('--')) {
      options[withoutPrefix] = true;
      continue;
    }

    options[withoutPrefix] = next;
    index += 1;
  }

  return options;
}

function normalizeDateOption(value, field, required) {
  if (value === undefined || value === null || String(value).trim() === '') {
    if (required) {
      throw new Error(`${field} is required.`);
    }

    return null;
  }

  const text = String(value).trim();

  if (/^-?\d+$/.test(text)) {
    const timestamp = Number(text);

    if (Number.isSafeInteger(timestamp)) {
      return timestamp;
    }

    throw new Error(`${field} must be a safe millisecond timestamp, YYYY-MM-DD date, or ISO date string.`);
  }

  const dateOnlyMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (dateOnlyMatch) {
    const year = Number(dateOnlyMatch[1]);
    const monthIndex = Number(dateOnlyMatch[2]) - 1;
    const day = Number(dateOnlyMatch[3]);
    const timestamp = field === 'to'
      ? Date.UTC(year, monthIndex, day, 23, 59, 59, 999)
      : Date.UTC(year, monthIndex, day, 0, 0, 0, 0);
    const parsedDate = new Date(timestamp);

    if (
      parsedDate.getUTCFullYear() === year &&
      parsedDate.getUTCMonth() === monthIndex &&
      parsedDate.getUTCDate() === day
    ) {
      return timestamp;
    }
  }

  const parsed = Date.parse(text);

  if (Number.isFinite(parsed)) {
    return parsed;
  }

  throw new Error(`${field} must be a YYYY-MM-DD date, ISO date string, or millisecond timestamp.`);
}

function normalizeInterval(value, defaultValue = '1d') {
  const interval = String(value || defaultValue).trim().toLowerCase();

  if (!SUPPORTED_INTERVALS.has(interval)) {
    throw new Error(`interval must be one of: ${Array.from(SUPPORTED_INTERVALS).join(', ')}.`);
  }

  return interval;
}

function openConfiguredDatabase(config) {
  return openDatabase(config.databasePath);
}

function runMigrate() {
  const config = loadServerConfig();
  const db = openConfiguredDatabase(config);

  try {
    const appliedMigrations = runMigrations(db);
    const suffix = appliedMigrations.length === 0
      ? 'no pending migrations'
      : `${appliedMigrations.length} migration(s) applied`;

    console.log(`Migrations completed for ${config.databasePath}: ${suffix}`);
  } finally {
    db.close();
  }
}


function printDatabaseIntegrityReport(report) {
  console.log(`Database integrity check at ${report.checkedAtIso}`);
  console.log(`Summary: ${report.summary.ok} ok, ${report.summary.warning} warning, ${report.summary.critical} critical`);

  report.checks.forEach((check) => {
    const detailCount = Array.isArray(check.details) ? check.details.length : 0;
    console.log(`\n[${check.status.toUpperCase()}] ${check.label}`);
    console.log(`  ${check.summary}`);

    if (detailCount > 0) {
      console.log(`  Details: ${detailCount} sampled row(s)`);
      check.details.slice(0, 10).forEach((detail) => {
        console.log(`    ${JSON.stringify(detail)}`);
      });
    }

    if (check.repairCommands.length > 0) {
      console.log('  Suggested repair guidance:');
      check.repairCommands.forEach((command) => console.log(`    ${command}`));
    }
  });
}

function runDatabaseCheck() {
  const config = loadServerConfig();
  const db = openConfiguredDatabase(config);

  try {
    const report = runDatabaseIntegrityCheck(db);
    printDatabaseIntegrityReport(report);

    if (report.summary.critical > 0) {
      process.exitCode = 2;
    } else if (report.summary.warning > 0) {
      process.exitCode = 1;
    }

    return report;
  } finally {
    db.close();
  }
}

function runValidateAssets() {
  const config = loadServerConfig();
  const assets = validateAssetsFile(config.assetsConfigPath);

  console.log(`Validated ${assets.length} configured assets from ${config.assetsConfigPath}.`);
}

async function runBackupDb() {
  const config = loadServerConfig();
  const db = openConfiguredDatabase(config);

  try {
    const backup = await createBackupService({ config, db }).createBackup();
    console.log(`Created backup ${backup.relativePath}.`);
    return backup.path;
  } finally {
    db.close();
  }
}

function runListBackups() {
  const config = loadServerConfig();
  const backups = createBackupService({ config }).listBackups();

  if (backups.length === 0) {
    console.log('No backups found.');
    return backups;
  }

  backups.forEach((backup) => {
    console.log(`${backup.fileName}\t${backup.createdAt || 'unknown'}\t${backup.sizeBytes} bytes`);
  });

  return backups;
}

function runPruneBackups() {
  const config = loadServerConfig();
  const result = createBackupService({ config }).pruneBackups();

  console.log(`Pruned ${result.pruned} backup(s); deleted ${result.deletedFiles} file(s); kept ${result.kept} backup(s).`);
  return result;
}

function getAssetFromDatabaseOrConfig(db, config, assetId) {
  const databaseAsset = getPublicAsset(db, assetId);

  if (databaseAsset) {
    return databaseAsset;
  }

  const configuredAssets = loadAssets(config.assetsConfigPath);
  const configuredAsset = configuredAssets.find((asset) => asset.id.toLowerCase() === assetId);

  if (!configuredAsset) {
    return null;
  }

  upsertAssets(db, configuredAssets);
  return getPublicAsset(db, assetId);
}

function requireAssetOption(options) {
  const assetId = String(options.asset || options.assetId || '').trim().toLowerCase();

  if (!assetId) {
    throw new Error('--asset is required.');
  }

  return assetId;
}

function csvEscape(value) {
  if (value === null || value === undefined) {
    return '';
  }

  const text = String(value);

  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function serializeCandlesAsCsv(candles) {
  const headers = [
    'assetId',
    'vsCurrency',
    'interval',
    'ts',
    'isoTime',
    'open',
    'high',
    'low',
    'close',
    'volume',
    'marketCap',
    'fetchedAt',
    'fetchedAtIso'
  ];
  const rows = candles.map((candle) => [
    candle.assetId,
    candle.vsCurrency,
    candle.interval,
    candle.ts,
    new Date(candle.ts).toISOString(),
    candle.open,
    candle.high,
    candle.low,
    candle.close,
    candle.volume,
    candle.marketCap,
    candle.fetchedAt,
    candle.fetchedAt ? new Date(candle.fetchedAt).toISOString() : ''
  ].map(csvEscape).join(','));

  return `${headers.join(',')}\n${rows.join('\n')}${rows.length > 0 ? '\n' : ''}`;
}

function runExportHistory(rawArgs) {
  const options = parseOptions(rawArgs);
  const config = loadServerConfig();
  const db = openConfiguredDatabase(config);

  try {
    const assetId = requireAssetOption(options);
    const asset = getAssetFromDatabaseOrConfig(db, config, assetId);

    if (!asset) {
      throw new Error(`Asset '${assetId}' was not found.`);
    }

    const fromTs = normalizeDateOption(options.from, 'from', false);
    const toTs = normalizeDateOption(options.to, 'to', false);
    const interval = normalizeInterval(options.interval, '1d');
    const vsCurrency = String(options.vs || options.vsCurrency || asset.vsCurrency).trim().toLowerCase();
    const format = String(options.format || DEFAULT_EXPORT_FORMAT).trim().toLowerCase();

    if (!EXPORT_FORMATS.has(format)) {
      throw new Error(`format must be one of: ${Array.from(EXPORT_FORMATS).join(', ')}.`);
    }

    const candles = getHistory(asset.id, {
      db,
      vsCurrency,
      interval,
      fromTs,
      toTs
    });
    const output = format === 'json'
      ? `${JSON.stringify(candles, null, 2)}\n`
      : serializeCandlesAsCsv(candles);

    if (options.output) {
      const outputPath = path.resolve(process.cwd(), String(options.output));
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, output);
      console.error(`Exported ${candles.length} candle(s) to ${outputPath}.`);
      return;
    }

    process.stdout.write(output);
  } finally {
    db.close();
  }
}

async function waitForSchedulerIdle(scheduler) {
  while (true) {
    const status = scheduler.getStatus();

    if (status.depth === 0 && status.activeJobs.length === 0) {
      return status;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function runRepairGaps(rawArgs) {
  const options = parseOptions(rawArgs);
  const config = loadServerConfig();

  if (isMaintenanceMode(config)) {
    throw new Error('Maintenance mode is active; gap repair fetch jobs are paused.');
  }
  const db = openConfiguredDatabase(config);

  try {
    const assetId = requireAssetOption(options);
    const asset = getAssetFromDatabaseOrConfig(db, config, assetId);

    if (!asset) {
      throw new Error(`Asset '${assetId}' was not found.`);
    }

    if (!asset.coingeckoId) {
      throw new Error(`Asset '${assetId}' does not have a CoinGecko ID.`);
    }

    const fromTs = normalizeDateOption(options.from, 'from', true);
    const toTs = normalizeDateOption(options.to, 'to', true);
    const interval = normalizeInterval(options.interval, '1d');
    const vsCurrency = String(options.vs || options.vsCurrency || asset.vsCurrency).trim().toLowerCase();

    if (toTs < fromTs) {
      throw new Error('to must be greater than or equal to from.');
    }

    const gaps = getMissingWindows(asset.id, vsCurrency, interval, fromTs, toTs, { db });
    const chunks = gaps.flatMap((gap) => chunkMissingWindow(gap, interval));
    const scheduler = createScheduler({ db });
    const enqueuedJobs = chunks.map((chunk) => scheduler.enqueue('gap_repair', {
      assetId: asset.id,
      from: new Date(chunk.from).toISOString(),
      to: new Date(chunk.to + INTERVAL_STEPS_MS[interval]).toISOString(),
      interval,
      vsCurrency,
      conflictPolicy: 'fill_only_missing',
      missingFrom: chunk.from,
      missingTo: chunk.to
    }, { assetPriority: asset.priority }));

    console.log(`Found ${gaps.length} gap window(s) and enqueued ${enqueuedJobs.length} gap repair job(s).`);

    if (enqueuedJobs.length === 0) {
      return;
    }

    const finalStatus = await waitForSchedulerIdle(scheduler);
    console.log(`Gap repair queue drained. Recent failures: ${finalStatus.recentFailures.length}.`);

    if (finalStatus.recentFailures.length > 0) {
      process.exitCode = 1;
      console.log(JSON.stringify(finalStatus.recentFailures, null, 2));
    }
  } finally {
    db.close();
  }
}

function withScheduler(callback) {
  const config = loadServerConfig();
  const db = openConfiguredDatabase(config);

  try {
    runMigrations(db);
    const scheduler = createScheduler({ db, config });
    return callback(scheduler);
  } finally {
    db.close();
  }
}

function formatJobForCli(job) {
  const assetId = job.payload && job.payload.assetId ? job.payload.assetId : 'n/a';
  const runAfter = job.runAfter ? new Date(job.runAfter).toISOString() : '';
  const lockedAt = job.lockedAt ? new Date(job.lockedAt).toISOString() : '';
  const error = job.lastError ? job.lastError.replace(/\s+/g, ' ').slice(0, 120) : '';
  return [job.id, job.status, job.type, assetId, `${job.attempts}/${job.maxAttempts}`, runAfter, lockedAt, error].join('\t');
}

function runJobsList() {
  return withScheduler((scheduler) => {
    const jobs = scheduler.listJobs({ limit: 200 });

    console.log('id\tstatus\ttype\tasset\tattempts\trun_after\tlocked_at\tlast_error');
    jobs.forEach((job) => console.log(formatJobForCli(job)));
    return jobs;
  });
}

function runRetryFailedJobs() {
  return withScheduler((scheduler) => {
    const count = scheduler.retryFailedJobs();
    console.log(`Queued ${count} failed job(s) for retry.`);
    return count;
  });
}

function runClearCompletedJobs() {
  return withScheduler((scheduler) => {
    const count = scheduler.clearCompletedJobs();
    console.log(`Cleared ${count} completed job(s).`);
    return count;
  });
}

function runQueueStatus() {
  return withScheduler((scheduler) => {
    const status = scheduler.getStatus();
    console.log(JSON.stringify({
      depth: status.depth,
      running: status.runningJobs.length,
      failed: status.failedJobs.length,
      queuedJobs: status.queuedJobs,
      runningJobs: status.runningJobs,
      failedJobs: status.failedJobs
    }, null, 2));
    return status;
  });
}

function getPointCount(value) {
  return Array.isArray(value) ? value.length : 0;
}

async function runCoinGeckoTest(args) {
  const config = loadServerConfig();

  if (isMaintenanceMode(config)) {
    throw new Error('Maintenance mode is active; CoinGecko test fetches are paused.');
  }

  const [coingeckoId, vsCurrency] = args;

  if (!coingeckoId || !vsCurrency) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const toMs = Date.now();
  const fromMs = toMs - (60 * 60 * 1000);
  const result = await fetchMarketChartRange(coingeckoId, vsCurrency, fromMs, toMs);

  console.log(`CoinGecko market chart range for ${coingeckoId}/${vsCurrency}`);
  console.log(`Range: ${new Date(fromMs).toISOString()} to ${new Date(toMs).toISOString()}`);
  console.log(`prices: ${getPointCount(result.prices)}`);
  console.log(`market_caps: ${getPointCount(result.market_caps)}`);
  console.log(`total_volumes: ${getPointCount(result.total_volumes)}`);
}


function runMaintenanceCommand(enabled) {
  const result = setMaintenanceMode(enabled);
  console.log(`Maintenance mode ${result.maintenanceMode ? 'enabled' : 'disabled'} in ${path.relative(process.cwd(), result.configPath)}.`);
  return result;
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    process.exitCode = command ? 0 : 1;
    return;
  }

  if (command === 'migrate') {
    runMigrate();
    return;
  }

  if (command === 'db:check') {
    runDatabaseCheck();
    return;
  }

  if (command === 'validate-assets') {
    runValidateAssets();
    return;
  }

  if (command === 'backup' || command === 'backup-db') {
    await runBackupDb();
    return;
  }

  if (command === 'backups:list') {
    runListBackups();
    return;
  }

  if (command === 'backups:prune') {
    runPruneBackups();
    return;
  }

  if (command === 'export-history') {
    runExportHistory(args);
    return;
  }

  if (command === 'repair-gaps') {
    await runRepairGaps(args);
    return;
  }

  if (command === 'queue-status') {
    runQueueStatus();
    return;
  }

  if (command === 'jobs:list') {
    runJobsList();
    return;
  }

  if (command === 'jobs:retry-failed') {
    runRetryFailedJobs();
    return;
  }

  if (command === 'jobs:clear-completed') {
    runClearCompletedJobs();
    return;
  }

  if (command === 'maintenance:on') {
    runMaintenanceCommand(true);
    return;
  }

  if (command === 'maintenance:off') {
    runMaintenanceCommand(false);
    return;
  }

  if (command === 'cg-test') {
    await runCoinGeckoTest(args);
    return;
  }

  console.error(`Unknown command: ${command}`);
  printUsage();
  process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  main,
  parseOptions,
  runBackupDb,
  runDatabaseCheck,
  runExportHistory,
  runListBackups,
  runMigrate,
  runPruneBackups,
  runQueueStatus,
  runMaintenanceCommand,
  runRepairGaps,
  runValidateAssets
};
