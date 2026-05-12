const fs = require('fs');
const os = require('os');
const path = require('path');

const { validateAssetsFile } = require('./asset-service');
const { resolveFromRoot } = require('../utils/files');
const { resolveDatabasePath } = require('../db/node-sqlite');
const packageJson = require('../../package.json');

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_GRACE_MULTIPLIER = 2;
const DEFAULT_STALE_MINUTES = 24 * 60;

function nowIso(value) {
  return value === null || value === undefined ? null : new Date(value).toISOString();
}

function bytesToSummary(bytes) {
  if (bytes === null || bytes === undefined) {
    return 'Unavailable';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = Number(bytes);
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function check(id, label, status, summary, value, details = null) {
  return { id, label, status, summary, value, details };
}

function criticalCheck(id, label, message, details = null) {
  return check(id, label, 'critical', message, null, details);
}

function getRuntime() {
  if (process.versions && process.versions.bun) {
    return { name: 'bun', version: process.versions.bun };
  }

  return { name: 'node', version: process.versions.node || process.version };
}

function getDatabaseFileSize(databasePath) {
  const resolvedPath = resolveDatabasePath(databasePath);
  const files = [resolvedPath, `${resolvedPath}-wal`, `${resolvedPath}-shm`];
  let totalBytes = 0;
  const parts = [];

  files.forEach((filePath) => {
    if (!fs.existsSync(filePath)) {
      return;
    }

    const stats = fs.statSync(filePath);
    totalBytes += stats.size;
    parts.push({ path: path.relative(process.cwd(), filePath), bytes: stats.size });
  });

  return {
    path: path.relative(process.cwd(), resolvedPath),
    bytes: totalBytes,
    parts
  };
}

function getDiskSpace(projectDir) {
  const resolvedProjectDir = path.resolve(projectDir || process.cwd());

  if (typeof fs.statfsSync !== 'function') {
    return { supported: false, path: resolvedProjectDir, freeBytes: null, totalBytes: null, availableBytes: null };
  }

  const stats = fs.statfsSync(resolvedProjectDir);
  const blockSize = Number(stats.bsize || 0);

  return {
    supported: true,
    path: resolvedProjectDir,
    freeBytes: Number(stats.bfree) * blockSize,
    availableBytes: Number(stats.bavail) * blockSize,
    totalBytes: Number(stats.blocks) * blockSize
  };
}

function listFilesRecursive(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }

  const files = [];
  const scan = (currentDir, prefix = '') => {
    fs.readdirSync(currentDir, { withFileTypes: true }).forEach((entry) => {
      if (entry.name.startsWith('.')) {
        return;
      }

      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = path.join(prefix, entry.name);

      if (entry.isDirectory()) {
        scan(absolutePath, relativePath);
        return;
      }

      if (!entry.isFile()) {
        return;
      }

      const stats = fs.statSync(absolutePath);
      files.push({
        name: relativePath,
        path: path.relative(process.cwd(), absolutePath),
        sizeBytes: stats.size,
        updatedAt: stats.mtimeMs,
        updatedAtIso: nowIso(stats.mtimeMs)
      });
    });
  };

  scan(directory);
  return files.sort((left, right) => right.updatedAt - left.updatedAt);
}

function getPendingImportFiles(config) {
  return listFilesRecursive(resolveFromRoot(path.join(config.dataDir || 'data', 'imports')));
}

function getLatestBackup(config) {
  const backupsDir = resolveFromRoot(path.join(config.dataDir || 'data', 'backups'));
  const backups = listFilesRecursive(backupsDir).filter((file) => /\.sqlite(?:3|\.db)?$/i.test(file.name) || /\.db$/i.test(file.name));
  return backups[0] || null;
}

function getEnabledAssets(assets) {
  return (assets || []).filter((asset) => asset.enabled);
}

function getFetchPolicyStaleCutoff(asset, now) {
  const policy = asset.fetchPolicy || {};
  const minutes = Number.isFinite(Number(policy.recentEveryMinutes)) && Number(policy.recentEveryMinutes) > 0
    ? Number(policy.recentEveryMinutes)
    : DEFAULT_STALE_MINUTES;

  return now - (minutes * 60 * 1000 * STALE_GRACE_MULTIPLIER);
}

function getAssetDataSummary(db, assets, now) {
  return getEnabledAssets(assets).map((asset) => {
    const candleRow = db.prepare(`
      SELECT COUNT(*) AS candleCount, MAX(ts) AS latestCandleTs, MAX(fetched_at) AS latestFetchedAt
      FROM candles
      WHERE asset_id = @assetId
        AND vs_currency = @vsCurrency
    `).get({ assetId: asset.id, vsCurrency: asset.vsCurrency });
    const fetchRow = db.prepare(`
      SELECT MAX(finished_at) AS latestSuccessfulFetchAt
      FROM fetch_runs
      WHERE asset_id = @assetId
        AND vs_currency = @vsCurrency
        AND status = 'success'
        AND finished_at IS NOT NULL
    `).get({ assetId: asset.id, vsCurrency: asset.vsCurrency });
    const candleCount = Number(candleRow && candleRow.candleCount ? candleRow.candleCount : 0);
    const latestFetchedAt = candleRow ? candleRow.latestFetchedAt : null;
    const staleCutoff = getFetchPolicyStaleCutoff(asset, now);

    return {
      assetId: asset.id,
      symbol: asset.symbol,
      name: asset.name,
      vsCurrency: asset.vsCurrency,
      candleCount,
      latestCandleTs: candleRow ? candleRow.latestCandleTs : null,
      latestCandleIso: nowIso(candleRow ? candleRow.latestCandleTs : null),
      latestFetchedAt,
      latestFetchedAtIso: nowIso(latestFetchedAt),
      latestSuccessfulFetchAt: fetchRow ? fetchRow.latestSuccessfulFetchAt : null,
      latestSuccessfulFetchIso: nowIso(fetchRow ? fetchRow.latestSuccessfulFetchAt : null),
      staleCutoff,
      staleCutoffIso: nowIso(staleCutoff),
      stale: candleCount > 0 && (!latestFetchedAt || latestFetchedAt < staleCutoff),
      noCandles: candleCount === 0
    };
  });
}

function safeSchedulerStatus(app) {
  const jobScheduler = app.get('jobScheduler');
  const recentRefreshScheduler = app.get('recentRefreshScheduler');

  return {
    queue: jobScheduler && typeof jobScheduler.getStatus === 'function' ? jobScheduler.getStatus() : null,
    recentRefresh: recentRefreshScheduler && typeof recentRefreshScheduler.getStatus === 'function'
      ? recentRefreshScheduler.getStatus()
      : null
  };
}

function buildSystemHealth(app, options = {}) {
  const now = options.now || Date.now();
  const config = app.get('config') || {};
  const db = app.get('db');
  const assets = app.get('assets') || [];
  const checks = [];

  checks.push(check('server_uptime', 'Server uptime', 'ok', `${Math.floor(process.uptime())} seconds`, process.uptime(), {
    seconds: process.uptime(),
    startedAtIso: nowIso(now - (process.uptime() * 1000))
  }));

  const runtime = getRuntime();
  checks.push(check('runtime', 'Runtime', runtime.name === 'node' || runtime.name === 'bun' ? 'ok' : 'warning', `${runtime.name} ${runtime.version}`, runtime.name, runtime));
  checks.push(check('app_version', 'App version', packageJson.version ? 'ok' : 'warning', packageJson.version || 'Unknown', packageJson.version || null));

  try {
    if (!db) {
      throw new Error('Database connection is not available.');
    }
    db.prepare('SELECT 1 AS ok').get();
    checks.push(check('database_reachable', 'Database reachable', 'ok', 'Reachable', true));
  } catch (error) {
    checks.push(criticalCheck('database_reachable', 'Database reachable', error.message));
  }

  try {
    const fileSize = getDatabaseFileSize(config.databasePath || 'data/history.sqlite');
    checks.push(check('database_file_size', 'Database file size', fileSize.bytes > 0 ? 'ok' : 'warning', bytesToSummary(fileSize.bytes), fileSize.bytes, fileSize));
  } catch (error) {
    checks.push(criticalCheck('database_file_size', 'Database file size', error.message));
  }

  try {
    const disk = getDiskSpace(process.cwd());
    let status = 'ok';
    const free = disk.availableBytes === null ? null : disk.availableBytes;
    if (!disk.supported) {
      status = 'warning';
    } else if (free < 512 * 1024 * 1024) {
      status = 'critical';
    } else if (free < 2 * 1024 * 1024 * 1024) {
      status = 'warning';
    }
    checks.push(check('project_free_disk_space', 'Free disk space for project directory', status, disk.supported ? bytesToSummary(free) : 'Unavailable on this runtime', free, disk));
  } catch (error) {
    checks.push(criticalCheck('project_free_disk_space', 'Free disk space for project directory', error.message));
  }

  try {
    const validatedAssets = validateAssetsFile(config.assetsConfigPath || './config/assets.json');
    checks.push(check('assets_config_valid', 'Assets config valid', 'ok', `${validatedAssets.length} asset(s) validated`, true, {
      path: config.assetsConfigPath || './config/assets.json',
      assetCount: validatedAssets.length
    }));
  } catch (error) {
    checks.push(criticalCheck('assets_config_valid', 'Assets config valid', error.message, { errors: error.errors || [] }));
  }

  const enabledAssets = getEnabledAssets(assets);
  checks.push(check('enabled_assets', 'Number of enabled assets', enabledAssets.length > 0 ? 'ok' : 'warning', `${enabledAssets.length} enabled`, enabledAssets.length));

  const schedulerStatus = safeSchedulerStatus(app);
  const recentRefresh = schedulerStatus.recentRefresh;
  const schedulerState = !recentRefresh || !recentRefresh.enabled ? 'not running' : (recentRefresh.paused ? 'paused' : 'running');
  checks.push(check('scheduler_state', 'Scheduler running or paused', schedulerState === 'running' ? 'ok' : 'warning', schedulerState, schedulerState, recentRefresh));

  const queue = schedulerStatus.queue || { depth: null, activeJob: null, activeJobs: [], recentFailures: [], callsUsedThisMinute: null, limiter: {} };
  checks.push(check('queue_depth', 'Queue depth', queue.depth === null ? 'warning' : (queue.depth > 100 ? 'warning' : 'ok'), queue.depth === null ? 'Unavailable' : `${queue.depth} queued`, queue.depth));
  checks.push(check('active_job', 'Active job', queue.activeJob ? 'ok' : 'ok', queue.activeJob ? `#${queue.activeJob.id} ${queue.activeJob.type}` : 'None', queue.activeJob, queue.activeJob));

  const failuresLast24Hours = (queue.recentFailures || []).filter((job) => job.finishedAt && job.finishedAt >= now - DAY_MS);
  checks.push(check('failed_jobs_last_24h', 'Failed jobs in last 24 hours', failuresLast24Hours.length > 0 ? 'warning' : 'ok', `${failuresLast24Hours.length} failed`, failuresLast24Hours.length, failuresLast24Hours));
  checks.push(check('coingecko_calls_used_this_minute', 'CoinGecko calls used this minute', queue.callsUsedThisMinute === null ? 'warning' : 'ok', queue.callsUsedThisMinute === null ? 'Unavailable' : `${queue.callsUsedThisMinute} call(s)`, queue.callsUsedThisMinute, queue.limiter));

  const pausedUntil = queue.limiter && queue.limiter.pausedUntil ? queue.limiter.pausedUntil : null;
  checks.push(check('coingecko_rate_limited', 'CoinGecko currently rate-limited', pausedUntil && pausedUntil > now ? 'warning' : 'ok', pausedUntil && pausedUntil > now ? 'Yes' : 'No', Boolean(pausedUntil && pausedUntil > now), { pausedUntil, pausedUntilIso: nowIso(pausedUntil) }));

  let assetData = [];
  try {
    if (!db) {
      throw new Error('Database connection is not available.');
    }
    assetData = getAssetDataSummary(db, assets, now);
    const missingFetches = assetData.filter((asset) => !asset.latestSuccessfulFetchAt);
    checks.push(check('latest_successful_fetch_per_asset', 'Latest successful fetch per asset', missingFetches.length > 0 ? 'warning' : 'ok', `${assetData.length - missingFetches.length}/${assetData.length} asset(s) fetched`, assetData, assetData));

    const staleAssets = assetData.filter((asset) => asset.stale);
    checks.push(check('assets_with_stale_data', 'Assets with stale data', staleAssets.length > 0 ? 'warning' : 'ok', `${staleAssets.length} stale`, staleAssets.length, staleAssets));

    const noCandleAssets = assetData.filter((asset) => asset.noCandles);
    checks.push(check('assets_with_no_candles', 'Assets with no candles', noCandleAssets.length > 0 ? 'critical' : 'ok', `${noCandleAssets.length} without candles`, noCandleAssets.length, noCandleAssets));
  } catch (error) {
    checks.push(criticalCheck('latest_successful_fetch_per_asset', 'Latest successful fetch per asset', error.message));
    checks.push(criticalCheck('assets_with_stale_data', 'Assets with stale data', error.message));
    checks.push(criticalCheck('assets_with_no_candles', 'Assets with no candles', error.message));
  }

  try {
    const pendingImports = getPendingImportFiles(config);
    checks.push(check('pending_import_files', 'Pending import files', pendingImports.length > 0 ? 'warning' : 'ok', `${pendingImports.length} pending`, pendingImports.length, pendingImports));
  } catch (error) {
    checks.push(criticalCheck('pending_import_files', 'Pending import files', error.message));
  }

  try {
    const latestBackup = getLatestBackup(config);
    checks.push(check('latest_backup_time', 'Latest backup time', latestBackup ? 'ok' : 'warning', latestBackup ? latestBackup.updatedAtIso : 'No backups found', latestBackup ? latestBackup.updatedAt : null, latestBackup));
  } catch (error) {
    checks.push(criticalCheck('latest_backup_time', 'Latest backup time', error.message));
  }

  const statusRank = { ok: 0, warning: 1, critical: 2 };
  const overallStatus = checks.reduce((current, item) => (
    statusRank[item.status] > statusRank[current] ? item.status : current
  ), 'ok');

  return {
    ok: overallStatus !== 'critical',
    status: overallStatus,
    generatedAt: now,
    generatedAtIso: nowIso(now),
    app: {
      name: config.appName || packageJson.name,
      version: packageJson.version,
      runtime
    },
    summary: {
      ok: checks.filter((item) => item.status === 'ok').length,
      warning: checks.filter((item) => item.status === 'warning').length,
      critical: checks.filter((item) => item.status === 'critical').length
    },
    checks
  };
}

module.exports = {
  buildSystemHealth,
  bytesToSummary
};
