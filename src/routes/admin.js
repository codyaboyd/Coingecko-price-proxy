const express = require('express');
const fs = require('fs');
const path = require('path');

const { getAssetCandleBounds, getPublicAsset, listFetchRunsForAsset, upsertAssets } = require('../db/queries');
const { readAssetConfig, validateAssetsPayload, loadAssets } = require('../services/asset-service');
const { CONFLICT_POLICIES, DEFAULT_CONFLICT_POLICY, SUPPORTED_INTERVALS, countCandles } = require('../services/history-service');
const { convertDumpFile, importNormalizedHistoryFile, previewNormalizedHistoryFile } = require('../services/import-service');
const { ensureDirectory, resolveFromRoot } = require('../utils/files');
const { createScheduler } = require('../jobs/scheduler');
const { buildRecentRefreshJobs, createRecentRefreshScheduler, normalizeFetchPolicy } = require('../jobs/recent-refresh-scheduler');
const { clearApiCache, getApiCacheStats } = require('../services/api-cache');
const { createBackupService } = require('../services/backup-service');
const { fetchMarketChartRange } = require('../services/coingecko');
const { getGapReport } = require('../services/cache-policy');
const { buildSystemHealth, bytesToSummary } = require('../services/system-health');
const { assertTimestampRange, DAY_MS, parseDateInput } = require('../utils/date');
const logger = require('../utils/logger');

const router = express.Router();
const MAX_IMPORT_FILE_BYTES = 50 * 1024 * 1024;
const MAX_ADMIN_FETCH_RANGE_MS = 366 * DAY_MS;


function getHotReloadManager(req) {
  return req.app.get('hotReloadManager') || null;
}

function getConfiguredAssets(req) {
  const hotReloadManager = getHotReloadManager(req);

  if (hotReloadManager && typeof hotReloadManager.getAssets === 'function') {
    return hotReloadManager.getAssets();
  }

  const appAssets = req.app.get('assets');

  if (Array.isArray(appAssets)) {
    return appAssets;
  }

  const config = req.app.get('config');
  return loadAssets(config.assetsConfigPath);
}

function getReloadStatus(req) {
  const hotReloadManager = getHotReloadManager(req);

  if (!hotReloadManager || typeof hotReloadManager.getStatus !== 'function') {
    return {
      lastReload: {
        target: 'hot-reload',
        status: 'disabled',
        message: 'Hot reload manager is not running.',
        errors: [],
        changedSettings: [],
        restartRequiredSettings: [],
        at: null
      },
      events: [],
      importCandidates: []
    };
  }

  return hotReloadManager.getStatus();
}


function getImportsDirectory(req) {
  const config = req.app.get('config');
  return resolveFromRoot(path.join(config.dataDir, 'imports'));
}

function listPendingImportFiles(req) {
  const importsDir = getImportsDirectory(req);

  if (!fs.existsSync(importsDir)) {
    return [];
  }

  const files = [];
  const scan = (directory, prefix = '') => {
    fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
      if (entry.name.startsWith('.')) {
        return;
      }

      const absolutePath = path.join(directory, entry.name);
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
        size: stats.size,
        updatedAt: stats.mtimeMs,
        updatedAtIso: formatTimestamp(stats.mtimeMs)
      });
    });
  };

  scan(importsDir);
  return files.sort((left, right) => right.updatedAt - left.updatedAt);
}

function assertInsideDirectory(baseDir, candidatePath, message) {
  const baseRealPath = fs.realpathSync(baseDir);
  const candidateRealPath = fs.realpathSync(candidatePath);

  if (candidateRealPath !== baseRealPath && !candidateRealPath.startsWith(`${baseRealPath}${path.sep}`)) {
    const error = new Error(message);
    error.status = 400;
    throw error;
  }

  return candidateRealPath;
}

function resolveImportFile(req, fileName) {
  if (!fileName) {
    return null;
  }

  const importsDir = getImportsDirectory(req);
  ensureDirectory(importsDir);

  if (path.isAbsolute(fileName) || String(fileName).includes('..')) {
    const error = new Error('Import file must be a relative path inside data/imports.');
    error.status = 400;
    throw error;
  }

  const resolved = path.resolve(importsDir, fileName);

  if (resolved === importsDir || !resolved.startsWith(`${importsDir}${path.sep}`)) {
    const error = new Error('Import file must be inside data/imports.');
    error.status = 400;
    throw error;
  }

  const safePath = assertInsideDirectory(importsDir, resolved, 'Import file cannot be a symlink or path outside data/imports.');
  const stats = fs.statSync(safePath);

  if (!stats.isFile()) {
    const error = new Error('Import path must be a regular file.');
    error.status = 400;
    throw error;
  }

  if (stats.size > MAX_IMPORT_FILE_BYTES) {
    const error = new Error('Import file is too large for admin preview/import.');
    error.status = 400;
    throw error;
  }

  return safePath;
}

function looksLikeNormalizedFile(filePath) {
  return filePath && filePath.toLowerCase().endsWith('.normalized.json');
}

function buildConvertedPath(req, sourcePath, assetId) {
  const config = req.app.get('config');
  const convertedDir = path.join(config.dataDir, 'imports', 'converted');
  ensureDirectory(convertedDir);
  const parsed = path.parse(path.basename(sourcePath));
  const safeAsset = String(assetId || 'asset').replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  const safeName = parsed.name.replace(/[^a-z0-9_.-]/gi, '-').slice(0, 120) || 'import';
  return resolveFromRoot(path.join(convertedDir, `${safeAsset}-${safeName}.normalized.json`));
}

function previewImportFile(filePath, options) {
  if (!filePath) {
    return null;
  }

  if (looksLikeNormalizedFile(filePath)) {
    return previewNormalizedHistoryFile(filePath, 25);
  }

  const conversion = convertDumpFile(filePath, options);
  return {
    ...conversion.output,
    detectedFormat: conversion.report.detectedFormat,
    rowsSeen: conversion.report.rowsSeen,
    rowsConverted: conversion.report.rowsConverted,
    rowsSkipped: conversion.report.rowsSkipped,
    candles: conversion.output.candles.slice(0, 25)
  };
}

function renderImportsPage(req, res, extras = {}) {
  const config = req.app.get('config');
  const assets = getConfiguredAssets(req);
  const selectedFile = extras.selectedFile || req.query.file || (listPendingImportFiles(req)[0] || {}).name || null;
  const selectedAssetId = extras.assetId || req.query.asset || (assets[0] || {}).id || '';
  const selectedAsset = assets.find((asset) => asset.id === selectedAssetId) || assets[0] || null;
  const selectedInterval = extras.interval || req.query.interval || '1d';
  const selectedPolicy = extras.policy || req.query.policy || DEFAULT_CONFLICT_POLICY;
  const files = listPendingImportFiles(req);
  let preview = extras.preview || null;
  let previewError = extras.previewError || null;

  if (!preview && selectedFile && selectedAsset) {
    try {
      preview = previewImportFile(resolveImportFile(req, selectedFile), {
        assetId: selectedAsset.id,
        symbol: selectedAsset.symbol,
        vsCurrency: selectedAsset.vsCurrency,
        interval: selectedInterval
      });
    } catch (error) {
      previewError = error.message;
      logger.warn(`Import preview failed for ${selectedFile}: ${error.message}`);
    }
  }

  res.render('admin-imports', {
    title: `${config.adminTitle} - Imports`,
    appName: config.appName,
    assets,
    files,
    intervals: Array.from(SUPPORTED_INTERVALS),
    policies: Array.from(CONFLICT_POLICIES),
    selectedFile,
    selectedAssetId,
    selectedInterval,
    selectedPolicy,
    preview,
    previewError,
    result: extras.result || null,
    error: extras.error || null
  });
}

function getDatabase(req) {
  const db = req.app.get('db');

  if (!db) {
    const error = new Error('Database connection is not available.');
    error.status = 503;
    throw error;
  }

  return db;
}

function getScheduler(req) {
  let scheduler = req.app.get('jobScheduler');

  if (!scheduler) {
    scheduler = createScheduler({ db: getDatabase(req), config: req.app.get('config') });
    req.app.set('jobScheduler', scheduler);
  }

  return scheduler;
}


function getRecentRefreshScheduler(req) {
  let scheduler = req.app.get('recentRefreshScheduler');

  if (!scheduler) {
    scheduler = createRecentRefreshScheduler({
      db: getDatabase(req),
      jobScheduler: getScheduler(req),
      assets: getConfiguredAssets(req)
    });
    scheduler.start();
    req.app.set('recentRefreshScheduler', scheduler);
  }

  return scheduler;
}

function redirectWithCacheAction(res, action, details) {
  const params = new URLSearchParams({ cacheAction: action });

  if (details) {
    params.set('cacheDetails', details);
  }

  res.redirect(`/admin?${params.toString()}`);
}


function getBackupService(req) {
  const scheduler = getScheduler(req);

  if (scheduler.backupService) {
    return scheduler.backupService;
  }

  scheduler.backupService = createBackupService({
    db: getDatabase(req),
    config: req.app.get('config')
  });

  return scheduler.backupService;
}

function redirectWithBackupAction(res, action, details) {
  const params = new URLSearchParams({ backupAction: action });

  if (details) {
    params.set('backupDetails', details);
  }

  res.redirect(`/admin/backups?${params.toString()}`);
}

function formatBackupForView(backup) {
  return {
    ...backup,
    createdAtIso: backup.createdAt,
    sizeLabel: bytesToSummary(backup.sizeBytes),
    files: backup.files.map((file) => ({
      ...file,
      sizeLabel: bytesToSummary(file.sizeBytes),
      updatedAtIso: formatTimestamp(file.updatedAt)
    }))
  };
}

function redirectWithSchedulerAction(res, action, details) {
  const params = new URLSearchParams({ schedulerAction: action });

  if (details) {
    params.set('schedulerDetails', details);
  }

  res.redirect(`/admin?${params.toString()}`);
}

function formatJobLabel(job) {
  if (!job) {
    return 'None';
  }

  return `#${job.id} ${job.type} (${job.payload.assetId || 'n/a'})`;
}

function formatTimestamp(value) {
  return value === null || value === undefined ? null : new Date(value).toISOString();
}


function parsePositiveIntegerField(value, field) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${field} must be a non-negative integer.`);
  }

  return parsed;
}

function parsePositiveNumberField(value, field) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive number.`);
  }

  return parsed;
}

function normalizeTextField(value, field) {
  const normalized = String(value || '').trim();

  if (!normalized) {
    throw new Error(`${field} must be a non-empty string.`);
  }

  return normalized;
}

function normalizeConfigAssetForm(body = {}, currentAsset = {}) {
  return {
    ...currentAsset,
    name: normalizeTextField(body.name, 'name'),
    symbol: normalizeTextField(body.symbol, 'symbol').toUpperCase(),
    coingeckoId: normalizeTextField(body.coingeckoId, 'coingeckoId').toLowerCase(),
    vsCurrency: normalizeTextField(body.vsCurrency, 'vsCurrency').toLowerCase(),
    enabled: body.enabled === 'on' || body.enabled === 'true' || body.enabled === true,
    priority: parsePositiveIntegerField(body.priority, 'priority'),
    fetchPolicy: {
      ...(currentAsset.fetchPolicy || {}),
      recentEveryMinutes: parsePositiveNumberField(body.recentEveryMinutes, 'fetchPolicy.recentEveryMinutes'),
      dailyBackfill: body.dailyBackfill === 'on' || body.dailyBackfill === 'true' || body.dailyBackfill === true,
      maxBackfillDaysPerRun: parsePositiveNumberField(body.maxBackfillDaysPerRun, 'fetchPolicy.maxBackfillDaysPerRun')
    }
  };
}

function getAssetConfigPath(req) {
  return resolveFromRoot(req.app.get('config').assetsConfigPath);
}

function readEditableAssetConfig(req) {
  const configPath = getAssetConfigPath(req);
  const payload = readAssetConfig(configPath);

  if (!Array.isArray(payload.assets)) {
    throw new Error('Asset config must contain an assets array.');
  }

  return { configPath, payload };
}

function makeBackupPath(configPath) {
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `${configPath}.${stamp}.bak`;
}

function writeAssetConfigSafely(configPath, payload) {
  const errors = validateAssetsPayload(payload);

  if (errors.length > 0) {
    throw new Error(`Invalid asset config:\n${errors.map((error) => `- ${error}`).join('\n')}`);
  }

  const backupPath = makeBackupPath(configPath);
  const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  const mode = fs.statSync(configPath).mode & 0o777;

  fs.copyFileSync(configPath, backupPath);
  fs.writeFileSync(tempPath, json, { encoding: 'utf8', mode });
  fs.renameSync(tempPath, configPath);

  return backupPath;
}

function reloadAssetsAfterWrite(req, payload) {
  const db = getDatabase(req);
  upsertAssets(db, payload.assets);
  req.app.set('assets', payload.assets);

  const recentRefreshScheduler = req.app.get('recentRefreshScheduler');
  if (recentRefreshScheduler && typeof recentRefreshScheduler.reloadAssets === 'function') {
    recentRefreshScheduler.reloadAssets(payload.assets);
  }

  const hotReloadManager = getHotReloadManager(req);
  if (hotReloadManager && typeof hotReloadManager.reloadAssetsConfig === 'function') {
    hotReloadManager.reloadAssetsConfig();
  }
}

function findConfiguredAsset(req, assetId) {
  return getConfiguredAssets(req).find((asset) => asset.id === assetId) || null;
}

function buildDefaultAdminRange() {
  const now = Date.now();
  return {
    from: new Date(now - (2 * 24 * 60 * 60 * 1000)).toISOString(),
    to: new Date(now).toISOString(),
    interval: '1h'
  };
}

function getAdminRangeQuery(req, asset) {
  const defaults = buildDefaultAdminRange();
  return {
    from: req.query.from || defaults.from,
    to: req.query.to || defaults.to,
    interval: req.query.interval || defaults.interval,
    vsCurrency: req.query.vsCurrency || req.query.vs || asset.vsCurrency
  };
}

function parseDateForAdminAction(value, field) {
  try {
    return parseDateInput(value, field, { required: true });
  } catch (error) {
    throw new Error(error.message);
  }
}

function validateAdminFetchRange(fromTs, toTs) {
  try {
    assertTimestampRange(fromTs, toTs, {
      maxSpanMs: MAX_ADMIN_FETCH_RANGE_MS,
      maxSpanMessage: 'Admin CoinGecko test range must be 366 days or less.'
    });

    if (toTs <= fromTs) {
      throw new Error('to must be greater than from.');
    }
  } catch (error) {
    throw new Error(error.message);
  }
}

router.get('/imports', (req, res, next) => {
  try {
    renderImportsPage(req, res);
  } catch (error) {
    next(error);
  }
});

router.post('/imports/run', (req, res, next) => {
  try {
    const fileName = req.body.file;
    const assetId = req.body.assetId;
    const interval = Array.from(SUPPORTED_INTERVALS).includes(req.body.interval) ? req.body.interval : '1d';
    const policy = Array.from(CONFLICT_POLICIES).includes(req.body.policy) ? req.body.policy : DEFAULT_CONFLICT_POLICY;
    const assets = getConfiguredAssets(req);
    const asset = assets.find((candidate) => candidate.id === assetId);

    if (!asset) {
      throw new Error('Choose a configured asset before importing.');
    }

    const sourcePath = resolveImportFile(req, fileName);
    let normalizedPath = sourcePath;
    let conversionReport = null;

    if (!looksLikeNormalizedFile(sourcePath)) {
      const conversion = convertDumpFile(sourcePath, {
        assetId: asset.id,
        symbol: asset.symbol,
        vsCurrency: asset.vsCurrency,
        interval
      });
      normalizedPath = buildConvertedPath(req, sourcePath, asset.id);
      fs.writeFileSync(normalizedPath, `${JSON.stringify({
        ...conversion.output,
        detectedFormat: conversion.report.detectedFormat
      }, null, 2)}\n`);
      conversionReport = conversion.report;
    }

    const result = importNormalizedHistoryFile(normalizedPath, {
      db: getDatabase(req),
      policy,
      assetId: asset.id,
      vsCurrency: asset.vsCurrency,
      interval
    });

    renderImportsPage(req, res, {
      selectedFile: path.relative(getImportsDirectory(req), normalizedPath),
      assetId: asset.id,
      interval,
      policy,
      result: {
        ...result,
        normalizedFile: path.relative(process.cwd(), normalizedPath),
        conversionReport
      }
    });
  } catch (error) {
    renderImportsPage(req, res, {
      selectedFile: req.body.file,
      assetId: req.body.assetId,
      interval: req.body.interval,
      policy: req.body.policy,
      error: error.message
    });
  }
});


router.get('/backups', (req, res, next) => {
  try {
    const config = req.app.get('config');
    const backupService = getBackupService(req);
    const queue = getScheduler(req).getStatus();
    const backups = backupService.listBackups().map(formatBackupForView);

    res.render('admin-backups', {
      title: `${config.adminTitle} - Backups`,
      appName: config.appName,
      backups,
      nextBackupAtIso: formatTimestamp(queue.nextBackupAt),
      backupAction: req.query.backupAction || null,
      backupDetails: req.query.backupDetails || null
    });
  } catch (error) {
    next(error);
  }
});

router.post('/backups/create', async (req, res, next) => {
  try {
    const backup = await getBackupService(req).createBackup();
    redirectWithBackupAction(res, 'created', backup.fileName);
  } catch (error) {
    next(error);
  }
});

router.post('/backups/prune', (req, res, next) => {
  try {
    const result = getBackupService(req).pruneBackups();
    redirectWithBackupAction(res, 'pruned', `${result.pruned} backup(s), ${result.deletedFiles} file(s) deleted`);
  } catch (error) {
    next(error);
  }
});

router.get('/backups/download/:file', (req, res, next) => {
  try {
    const filePath = getBackupService(req).resolveBackupFile(req.params.file);
    res.download(filePath, path.basename(filePath));
  } catch (error) {
    next(error);
  }
});

router.post('/backups/:id/delete', (req, res, next) => {
  try {
    const result = getBackupService(req).deleteBackup(req.params.id);
    redirectWithBackupAction(res, 'deleted', `${result.baseName}: ${result.deleted} file(s) deleted`);
  } catch (error) {
    next(error);
  }
});

router.get('/api-test', (req, res, next) => {
  try {
    const config = req.app.get('config');
    const assets = getConfiguredAssets(req);

    res.render('admin-api-test', {
      title: `${config.adminTitle} API Test`,
      appName: config.appName,
      assets
    });
  } catch (error) {
    next(error);
  }
});


router.get('/reload-status', (req, res, next) => {
  try {
    const config = req.app.get('config');
    const reloadStatus = getReloadStatus(req);

    res.render('admin-reload-status', {
      title: `${config.adminTitle} - Reload Status`,
      appName: config.appName,
      reloadStatus: {
        ...reloadStatus,
        lastReloadAtIso: formatTimestamp(reloadStatus.lastReload.at),
        events: reloadStatus.events.map((event) => ({
          ...event,
          atIso: formatTimestamp(event.at)
        })),
        importCandidates: reloadStatus.importCandidates.map((candidate) => ({
          ...candidate,
          firstSeenAtIso: formatTimestamp(candidate.firstSeenAt),
          updatedAtIso: formatTimestamp(candidate.updatedAt)
        }))
      }
    });
  } catch (error) {
    next(error);
  }
});


router.get('/system-health', (req, res, next) => {
  try {
    const config = req.app.get('config');
    const health = buildSystemHealth(req.app);

    res.render('admin-system-health', {
      title: `${config.adminTitle} - System Health`,
      appName: config.appName,
      health,
      bytesToSummary
    });
  } catch (error) {
    next(error);
  }
});

router.get('/assets', (req, res, next) => {
  try {
    const config = req.app.get('config');
    const db = getDatabase(req);
    const assets = getConfiguredAssets(req).map((asset) => {
      const bounds = getAssetCandleBounds(db, asset.id);

      return {
        ...asset,
        earliestIso: formatTimestamp(bounds.earliest_ts),
        latestIso: formatTimestamp(bounds.latest_ts)
      };
    });

    res.render('admin-assets', {
      title: `${config.adminTitle} - Assets`,
      appName: config.appName,
      assets,
      alert: req.query.alert || null,
      message: req.query.message || null
    });
  } catch (error) {
    next(error);
  }
});

router.get('/assets/:id/edit', (req, res, next) => {
  try {
    const config = req.app.get('config');
    const asset = findConfiguredAsset(req, req.params.id);

    if (!asset) {
      const error = new Error(`Asset '${req.params.id}' was not found.`);
      error.status = 404;
      next(error);
      return;
    }

    const range = getAdminRangeQuery(req, asset);

    res.render('admin-asset-edit', {
      title: `${config.adminTitle} - Edit ${asset.symbol}`,
      appName: config.appName,
      asset,
      range,
      intervals: Array.from(SUPPORTED_INTERVALS),
      alert: req.query.alert || null,
      message: req.query.message || null
    });
  } catch (error) {
    next(error);
  }
});

router.post('/assets/:id/edit', (req, res, next) => {
  try {
    const { configPath, payload } = readEditableAssetConfig(req);
    const index = payload.assets.findIndex((asset) => asset.id === req.params.id);

    if (index === -1) {
      const error = new Error(`Asset '${req.params.id}' was not found.`);
      error.status = 404;
      next(error);
      return;
    }

    payload.assets[index] = normalizeConfigAssetForm(req.body, payload.assets[index]);
    const backupPath = writeAssetConfigSafely(configPath, payload);
    reloadAssetsAfterWrite(req, payload);

    const params = new URLSearchParams({
      alert: 'success',
      message: `Saved ${payload.assets[index].symbol}. Backup: ${path.relative(process.cwd(), backupPath)}`
    });
    res.redirect(`/admin/assets/${encodeURIComponent(req.params.id)}/edit?${params.toString()}`);
  } catch (error) {
    const params = new URLSearchParams({
      alert: 'danger',
      message: error.message
    });
    res.redirect(`/admin/assets/${encodeURIComponent(req.params.id)}/edit?${params.toString()}`);
  }
});

router.post('/assets/:id/test/coingecko', async (req, res, next) => {
  try {
    const asset = findConfiguredAsset(req, req.params.id);

    if (!asset) {
      const error = new Error(`Asset '${req.params.id}' was not found.`);
      error.status = 404;
      next(error);
      return;
    }

    const range = getAdminRangeQuery(req, asset);
    const fromTs = parseDateForAdminAction(range.from, 'from');
    const toTs = parseDateForAdminAction(range.to, 'to');
    validateAdminFetchRange(fromTs, toTs);
    const response = await fetchMarketChartRange(asset.coingeckoId, range.vsCurrency, fromTs, toTs);

    res.json({
      ok: true,
      asset: { id: asset.id, symbol: asset.symbol, coingeckoId: asset.coingeckoId },
      range,
      sampleCounts: {
        prices: Array.isArray(response.prices) ? response.prices.length : 0,
        marketCaps: Array.isArray(response.market_caps) ? response.market_caps.length : 0,
        totalVolumes: Array.isArray(response.total_volumes) ? response.total_volumes.length : 0
      }
    });
  } catch (error) {
    next(error);
  }
});

router.get('/assets/:id/test/local-history', (req, res, next) => {
  try {
    const asset = findConfiguredAsset(req, req.params.id);

    if (!asset) {
      const error = new Error(`Asset '${req.params.id}' was not found.`);
      error.status = 404;
      next(error);
      return;
    }

    const range = getAdminRangeQuery(req, asset);
    const candleCount = countCandles(asset.id, range.vsCurrency, range.interval, { db: getDatabase(req) });
    const bounds = getAssetCandleBounds(getDatabase(req), asset.id);

    res.json({
      ok: true,
      asset: { id: asset.id, symbol: asset.symbol },
      range,
      candleCount,
      earliestCandle: formatTimestamp(bounds.earliest_ts),
      latestCandle: formatTimestamp(bounds.latest_ts)
    });
  } catch (error) {
    next(error);
  }
});

router.get('/assets/:id/test/gap-report', (req, res, next) => {
  try {
    const asset = findConfiguredAsset(req, req.params.id);

    if (!asset) {
      const error = new Error(`Asset '${req.params.id}' was not found.`);
      error.status = 404;
      next(error);
      return;
    }

    const range = getAdminRangeQuery(req, asset);
    const fromTs = parseDateForAdminAction(range.from, 'from');
    const toTs = parseDateForAdminAction(range.to, 'to');
    validateAdminFetchRange(fromTs, toTs);
    const report = getGapReport(asset.id, range.vsCurrency, range.interval, fromTs, toTs, { db: getDatabase(req) });

    res.json({ ok: true, asset: { id: asset.id, symbol: asset.symbol }, range, gapReport: report });
  } catch (error) {
    next(error);
  }
});

router.post('/assets/:id/test/fetch-recent', (req, res, next) => {
  try {
    const asset = findConfiguredAsset(req, req.params.id);

    if (!asset) {
      const error = new Error(`Asset '${req.params.id}' was not found.`);
      error.status = 404;
      next(error);
      return;
    }

    const scheduler = getScheduler(req);
    const policy = normalizeFetchPolicy(asset);
    const jobs = policy.intervals.flatMap((interval) => buildRecentRefreshJobs(getDatabase(req), asset, interval, policy, Date.now()));
    const enqueuedJobs = jobs.map((payload) => scheduler.enqueue('recent_refresh', payload, { assetPriority: asset.priority }));

    res.status(202).json({
      ok: true,
      asset: { id: asset.id, symbol: asset.symbol },
      policy,
      enqueuedJobs,
      queue: scheduler.getStatus()
    });
  } catch (error) {
    next(error);
  }
});

router.get('/assets/:id', (req, res, next) => {
  try {
    const config = req.app.get('config');
    const db = getDatabase(req);
    const asset = getPublicAsset(db, req.params.id);

    if (!asset) {
      const error = new Error(`Asset '${req.params.id}' was not found.`);
      error.status = 404;
      next(error);
      return;
    }

    const bounds = getAssetCandleBounds(db, asset.id);
    const fetchRuns = listFetchRunsForAsset(db, asset.id, 10);

    res.render('admin-asset-detail', {
      title: `${config.adminTitle} - ${asset.symbol}`,
      appName: config.appName,
      asset,
      candleSummary: {
        earliestTs: bounds.earliest_ts,
        earliestIso: formatTimestamp(bounds.earliest_ts),
        latestTs: bounds.latest_ts,
        latestIso: formatTimestamp(bounds.latest_ts),
        count: bounds.candle_count || 0
      },
      fetchRuns
    });
  } catch (error) {
    next(error);
  }
});


router.post('/cache/clear', (req, res, next) => {
  try {
    const clearedEntries = clearApiCache(getDatabase(req));
    redirectWithCacheAction(res, 'cleared', `${clearedEntries} entr${clearedEntries === 1 ? 'y' : 'ies'} removed`);
  } catch (error) {
    next(error);
  }
});

router.post('/scheduler/pause', (req, res, next) => {
  try {
    getRecentRefreshScheduler(req).pause();
    redirectWithSchedulerAction(res, 'paused');
  } catch (error) {
    next(error);
  }
});

router.post('/scheduler/resume', (req, res, next) => {
  try {
    getRecentRefreshScheduler(req).resume();
    redirectWithSchedulerAction(res, 'resumed');
  } catch (error) {
    next(error);
  }
});

router.post('/scheduler/run-now', (req, res, next) => {
  try {
    const result = getRecentRefreshScheduler(req).runNow();
    redirectWithSchedulerAction(res, 'run-now', `${result.jobCount} job(s) queued`);
  } catch (error) {
    next(error);
  }
});

router.get('/', (req, res, next) => {
  try {
    const config = req.app.get('config');
    const assets = getConfiguredAssets(req);
    const reloadStatus = getReloadStatus(req);

    const queue = getScheduler(req).getStatus();
    const recentRefresh = getRecentRefreshScheduler(req).getStatus();
    const cacheStats = getApiCacheStats(getDatabase(req));

    res.render('admin', {
      title: config.adminTitle,
      assets,
      queue: {
        ...queue,
        activeJobLabel: formatJobLabel(queue.activeJob)
      },
      recentRefresh: {
        ...recentRefresh,
        startedAtIso: formatTimestamp(recentRefresh.startedAt),
        lastRunAtIso: formatTimestamp(recentRefresh.lastRunAt),
        nextRunAtIso: formatTimestamp(recentRefresh.nextRunAt)
      },
      schedulerAction: req.query.schedulerAction || null,
      schedulerDetails: req.query.schedulerDetails || null,
      cacheAction: req.query.cacheAction || null,
      cacheDetails: req.query.cacheDetails || null,
      cacheStats,
      reloadStatus: {
        ...reloadStatus,
        lastReloadAtIso: formatTimestamp(reloadStatus.lastReload.at),
        importCandidates: reloadStatus.importCandidates.map((candidate) => ({
          ...candidate,
          firstSeenAtIso: formatTimestamp(candidate.firstSeenAt),
          updatedAtIso: formatTimestamp(candidate.updatedAt)
        }))
      },
      status: {
        appName: config.appName,
        runtime: `Node.js ${process.version} (${config.nodeEnv})`,
        assetsLoaded: assets.length,
        configPath: resolveFromRoot(config.assetsConfigPath),
        databasePath: resolveFromRoot(config.databasePath)
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
