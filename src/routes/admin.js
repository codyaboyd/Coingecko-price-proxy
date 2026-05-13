const express = require('express');
const fs = require('fs');
const path = require('path');

const { getAssetCandleBounds, getConfigChange, getNextConfigChangeForFile, getPublicAsset, listConfigChanges, listFetchRunsForAsset, upsertAssets } = require('../db/queries');
const { readAssetConfig, loadAssets } = require('../services/asset-service');
const { CONFLICT_POLICIES, DEFAULT_CONFLICT_POLICY, SUPPORTED_INTERVALS, countCandles } = require('../services/history-service');
const { convertDumpFile, importNormalizedHistoryFile, previewNormalizedHistoryFile } = require('../services/import-service');
const { ensureDirectory, resolveFromRoot } = require('../utils/files');
const { createScheduler } = require('../jobs/scheduler');
const { buildRecentRefreshJobs, createRecentRefreshScheduler, normalizeFetchPolicy } = require('../jobs/recent-refresh-scheduler');
const { clearApiCache, getApiCacheStats } = require('../services/api-cache');
const { createBackupService } = require('../services/backup-service');
const { RESTORE_CONFIRMATION_PHRASE, restoreBackup } = require('../services/restore-service');
const { fetchMarketChartRange } = require('../services/coingecko');
const { getGapReport } = require('../services/cache-policy');
const { getGlobalRateBudgetService } = require('../services/rate-budget-service');
const { buildSystemHealth, bytesToSummary } = require('../services/system-health');
const { buildAdminDoctorReport } = require('../services/admin-doctor-service');
const { markStuckFetchRunsFailed, runDatabaseIntegrityCheck } = require('../services/db-integrity-service');
const { getAssetStaleness } = require('../services/staleness-service');
const { applyMaintenanceModeToRuntime, createMaintenanceError, isMaintenanceMode } = require('../services/maintenance-service');
const { assertTimestampRange, DAY_MS, parseDateInput } = require('../utils/date');
const { parseJsonText, rollbackConfigChange, saveConfigChange } = require('../services/config-change-service');
const { ADMIN_EVENT_ACTIONS, ADMIN_EVENT_ENTITY_TYPES, adminEventsToCsv, listAdminEventFacetValues, listAdminEvents, recordAdminEvent } = require('../services/admin-activity-service');
const { createAlertsFromHealthReport, createAlertsFromIntegrityReport, listAlerts, updateAlertStatus } = require('../services/alert-service');
const logger = require('../utils/logger');

const router = express.Router();
const MAX_IMPORT_FILE_BYTES = 50 * 1024 * 1024;
const MAX_ADMIN_FETCH_RANGE_MS = 366 * DAY_MS;


function isRequestInMaintenanceMode(req) {
  return isMaintenanceMode(req.app.get('config'));
}

function requireMaintenanceDisabled(req, message) {
  if (isRequestInMaintenanceMode(req)) {
    throw createMaintenanceError(message);
  }
}

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
      assets: getConfiguredAssets(req),
      maintenanceMode: isRequestInMaintenanceMode(req)
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

function buildBackupActionParams(action, details) {
  const params = new URLSearchParams({ backupAction: action });

  if (details) {
    params.set('backupDetails', details);
  }

  return params;
}

function redirectWithBackupAction(res, action, details) {
  res.redirect(`/admin/backups?${buildBackupActionParams(action, details).toString()}`);
}

function redirectWithRestoreAction(res, action, details) {
  res.redirect(`/admin/backups/restore?${buildBackupActionParams(action, details).toString()}`);
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


function redirectWithDbIntegrityAction(res, action, details) {
  const params = new URLSearchParams({ dbIntegrityAction: action });

  if (details) {
    params.set('dbIntegrityDetails', details);
  }

  params.set('run', '1');
  res.redirect(`/admin/db-integrity?${params.toString()}`);
}

function formatIntegrityReport(report) {
  return {
    ...report,
    checks: report.checks.map((check) => ({
      ...check,
      detailCount: Array.isArray(check.details) ? check.details.length : 0
    }))
  };
}

function redirectWithDoctorAction(res, action, details) {
  const params = new URLSearchParams({ doctorAction: action });

  if (details) {
    params.set('doctorDetails', details);
  }

  res.redirect(`/admin/doctor?${params.toString()}`);
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

function getAdminActor(req) {
  return req.adminUser && req.adminUser.username ? req.adminUser.username : 'admin-ui';
}

function saveAdminConfigChange(req, filePath, payload, summary) {
  return saveConfigChange({
    db: getDatabase(req),
    config: req.app.get('config'),
    filePath,
    payload,
    changedBy: getAdminActor(req),
    summary
  });
}

function readTextFileSafe(filePath) {
  return fs.readFileSync(resolveFromRoot(filePath), 'utf8');
}

function buildSimpleDiff(oldText, newText) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const max = Math.max(oldLines.length, newLines.length);
  const lines = [];

  for (let index = 0; index < max; index += 1) {
    const oldLine = oldLines[index];
    const newLine = newLines[index];

    if (oldLine === newLine) {
      lines.push({ type: 'context', number: index + 1, text: oldLine === undefined ? '' : oldLine });
    } else {
      if (oldLine !== undefined) {
        lines.push({ type: 'removed', number: index + 1, text: oldLine });
      }
      if (newLine !== undefined) {
        lines.push({ type: 'added', number: index + 1, text: newLine });
      }
    }
  }

  return lines;
}

function loadConfigChangeDiff(req, change) {
  if (!change) {
    return null;
  }

  const nextChange = getNextConfigChangeForFile(getDatabase(req), change);
  const oldText = readTextFileSafe(change.backupPath);
  const newText = nextChange ? readTextFileSafe(nextChange.backupPath) : readTextFileSafe(change.filePath);

  return {
    change,
    oldLabel: change.backupPath,
    newLabel: nextChange ? nextChange.backupPath : change.filePath,
    lines: buildSimpleDiff(oldText, newText)
  };
}

function hotReloadConfigFile(req, filePath, payload) {
  if (filePath === 'config/assets.json') {
    reloadAssetsAfterWrite(req, payload);
    return;
  }

  if (filePath === 'config/server.json') {
    const hotReloadManager = getHotReloadManager(req);
    if (hotReloadManager && typeof hotReloadManager.reloadServerConfig === 'function') {
      hotReloadManager.reloadServerConfig();
      return;
    }

    applyMaintenanceModeToRuntime(req.app, payload.maintenanceMode === true);
  }
}


function reloadRuntimeConfig(req) {
  const hotReloadManager = getHotReloadManager(req);
  let serverStatus = null;
  let assetsStatus = null;

  if (hotReloadManager && typeof hotReloadManager.reloadServerConfig === 'function') {
    serverStatus = hotReloadManager.reloadServerConfig();
  }

  if (hotReloadManager && typeof hotReloadManager.reloadAssetsConfig === 'function') {
    assetsStatus = hotReloadManager.reloadAssetsConfig();
  } else {
    const payload = readAssetConfig(getAssetConfigPath(req));
    reloadAssetsAfterWrite(req, payload);
  }

  return { serverStatus, assetsStatus };
}

function clearCompletedJobsOlderThan(db, days = 7) {
  const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
  const result = db.prepare("DELETE FROM jobs WHERE status = 'completed' AND updated_at < @cutoff").run({ cutoff });
  return result.changes;
}

function redirectWithConfigAction(res, action, details, selectedId) {
  const params = new URLSearchParams({ configAction: action });

  if (details) {
    params.set('configDetails', details);
  }

  if (selectedId) {
    params.set('change', selectedId);
  }

  res.redirect(`/admin/config-history?${params.toString()}`);
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



router.get('/alerts', (req, res, next) => {
  try {
    const config = req.app.get('config');
    const status = ['open', 'acknowledged', 'resolved'].includes(req.query.status) ? req.query.status : null;
    const alerts = listAlerts(getDatabase(req), { status });

    res.render('admin-alerts', {
      title: `${config.adminTitle} - Alerts`,
      appName: config.appName,
      alerts,
      selectedStatus: status || 'all',
      alertAction: req.query.alertAction || null,
      alertDetails: req.query.alertDetails || null
    });
  } catch (error) {
    next(error);
  }
});

router.post('/alerts/:id/acknowledge', (req, res, next) => {
  try {
    const alert = updateAlertStatus(getDatabase(req), Number(req.params.id), 'acknowledged');
    recordAdminEvent(req, { action: 'alert acknowledge', entityType: 'alert', entityId: String(req.params.id), details: { type: alert && alert.type } });
    res.redirect('/admin/alerts?alertAction=acknowledged');
  } catch (error) {
    next(error);
  }
});

router.post('/alerts/:id/resolve', (req, res, next) => {
  try {
    const alert = updateAlertStatus(getDatabase(req), Number(req.params.id), 'resolved');
    recordAdminEvent(req, { action: 'alert resolve', entityType: 'alert', entityId: String(req.params.id), details: { type: alert && alert.type } });
    res.redirect('/admin/alerts?alertAction=resolved');
  } catch (error) {
    next(error);
  }
});

router.get('/doctor', (req, res, next) => {
  try {
    const config = req.app.get('config');
    const scheduler = getScheduler(req);
    const report = buildAdminDoctorReport({
      app: req.app,
      db: getDatabase(req),
      config,
      assets: getConfiguredAssets(req),
      scheduler,
      recentRefreshScheduler: getRecentRefreshScheduler(req),
      backupService: getBackupService(req)
    });

    res.render('admin-doctor', {
      title: `${config.adminTitle} - Admin Doctor`,
      appName: config.appName,
      report,
      doctorAction: req.query.doctorAction || null,
      doctorDetails: req.query.doctorDetails || null
    });
  } catch (error) {
    next(error);
  }
});

router.post('/doctor/fix', async (req, res, next) => {
  try {
    const action = String(req.body.action || '').trim();
    let details = null;

    if (action === 'create-backup') {
      const backup = await getBackupService(req).createBackup();
      details = `Created backup ${backup.fileName}`;
    } else if (action === 'retry-failed-jobs') {
      const count = getScheduler(req).retryFailedJobs();
      details = `Queued ${count} failed job(s) for retry`;
    } else if (action === 'clear-completed-jobs') {
      const count = clearCompletedJobsOlderThan(getDatabase(req), 7);
      details = `Cleared ${count} completed job(s) older than 7 days`;
    } else if (action === 'reload-config') {
      reloadRuntimeConfig(req);
      details = 'Reloaded server and asset config where runtime-safe';
    } else if (action === 'pause-scheduler') {
      getRecentRefreshScheduler(req).pause();
      details = 'Paused recent refresh scheduler';
    } else if (action === 'resume-scheduler') {
      getRecentRefreshScheduler(req).resume();
      details = 'Resumed recent refresh scheduler';
    } else if (action === 'mark-stuck-fetch-runs-failed') {
      const result = markStuckFetchRunsFailed(getDatabase(req));
      details = `Marked ${result.changed} stuck fetch run(s) failed`;
    } else if (action === 'repair-stale-assets') {
      requireMaintenanceDisabled(req, 'Maintenance mode is active; repair jobs are paused.');
      const result = getRecentRefreshScheduler(req).runNow();
      details = `Queued ${result.jobCount} stale asset repair job(s)`;
    } else {
      const error = new Error(`Unsupported doctor fix: ${action || 'none'}`);
      error.status = 400;
      throw error;
    }

    if (action === 'create-backup') {
      recordAdminEvent(req, { action: 'backup created', entityType: 'backup', entityId: details, details: { route: '/admin/doctor/fix', doctorAction: action, summary: details } });
    } else if (action === 'retry-failed-jobs') {
      recordAdminEvent(req, { action: 'job retry', entityType: 'job', entityId: 'failed-jobs', details: { route: '/admin/doctor/fix', doctorAction: action, summary: details } });
    } else if (action === 'pause-scheduler') {
      recordAdminEvent(req, { action: 'scheduler pause', entityType: 'scheduler', entityId: 'recent-refresh', details: { route: '/admin/doctor/fix', doctorAction: action, summary: details } });
    } else if (action === 'resume-scheduler') {
      recordAdminEvent(req, { action: 'scheduler resume', entityType: 'scheduler', entityId: 'recent-refresh', details: { route: '/admin/doctor/fix', doctorAction: action, summary: details } });
    } else if (action === 'repair-stale-assets') {
      recordAdminEvent(req, { action: 'backfill request', entityType: 'scheduler', entityId: 'recent-refresh', details: { route: '/admin/doctor/fix', doctorAction: action, summary: details } });
    }

    redirectWithDoctorAction(res, action, details);
  } catch (error) {
    next(error);
  }
});

router.get('/imports', (req, res, next) => {
  try {
    renderImportsPage(req, res);
  } catch (error) {
    next(error);
  }
});

router.post('/imports/run', (req, res, next) => {
  try {
    requireMaintenanceDisabled(req, 'Maintenance mode is active; imports are paused.');
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

    recordAdminEvent(req, {
      action: 'import run',
      entityType: 'import',
      entityId: result.importRunId || asset.id,
      details: { status: result.status || 'completed', assetId: asset.id, fileName, normalizedPath: path.relative(process.cwd(), normalizedPath), rowsImported: result.rowsImported, policy }
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
    recordAdminEvent(req, {
      action: 'import run',
      entityType: 'import',
      entityId: req.body.assetId || req.body.file || null,
      details: { status: 'failed', assetId: req.body.assetId, fileName: req.body.file, error: error.message }
    });
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
    recordAdminEvent(req, { action: 'backup created', entityType: 'backup', entityId: backup.fileName, details: { fileName: backup.fileName, sizeBytes: backup.sizeBytes } });
    redirectWithBackupAction(res, 'created', backup.fileName);
  } catch (error) {
    next(error);
  }
});

router.post('/backups/prune', (req, res, next) => {
  try {
    const result = getBackupService(req).pruneBackups();
    recordAdminEvent(req, { action: 'backup deleted', entityType: 'backup', entityId: 'prune', details: result });
    redirectWithBackupAction(res, 'pruned', `${result.pruned} backup(s), ${result.deletedFiles} file(s) deleted`);
  } catch (error) {
    next(error);
  }
});


router.get('/backups/restore', (req, res, next) => {
  try {
    const config = req.app.get('config');
    const backupService = getBackupService(req);
    const backups = backupService.listBackups().map(formatBackupForView);
    const selected = backups.find((backup) => backup.fileName === req.query.file) || backups[0] || null;

    res.render('admin-backup-restore', {
      title: `${config.adminTitle} - Restore Backup`,
      appName: config.appName,
      backups,
      selectedFile: req.query.file || (selected && selected.fileName) || '',
      confirmationPhrase: RESTORE_CONFIRMATION_PHRASE,
      backupAction: req.query.backupAction || null,
      backupDetails: req.query.backupDetails || null
    });
  } catch (error) {
    next(error);
  }
});

router.post('/backups/restore', async (req, res, next) => {
  try {
    const config = req.app.get('config');
    const backupService = getBackupService(req);
    const backup = backupService.resolveBackupFile(req.body.backupFile);
    recordAdminEvent(req, { action: 'restore attempted', entityType: 'restore', entityId: path.basename(backup), details: { status: 'started', backupFile: path.basename(backup) } });
    const result = await restoreBackup(config, {
      app: req.app,
      db: getDatabase(req),
      backupPath: backup,
      confirmation: req.body.confirmation,
      actor: req.adminUser && req.adminUser.username ? req.adminUser.username : 'admin-ui'
    });

    recordAdminEvent(req, { action: 'restore attempted', entityType: 'restore', entityId: result.backupFileName, details: { status: 'completed', backupFileName: result.backupFileName, emergencyBackupPath: result.emergencyBackupPath ? path.relative(process.cwd(), result.emergencyBackupPath) : null } });
    redirectWithRestoreAction(res, 'restored', `${result.backupFileName}; emergency backup: ${result.emergencyBackupPath ? path.relative(process.cwd(), result.emergencyBackupPath) : 'none'}`);
  } catch (error) {
    recordAdminEvent(req, { action: 'restore attempted', entityType: 'restore', entityId: req.body.backupFile || null, details: { status: 'failed', backupFile: req.body.backupFile, error: error.message } });
    logger.error(`Admin backup restore failed: ${error.message}`);
    redirectWithRestoreAction(res, 'restore failed', error.message);
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
    recordAdminEvent(req, { action: 'backup deleted', entityType: 'backup', entityId: req.params.id, details: result });
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



router.get('/rate-budget', (req, res, next) => {
  try {
    const config = req.app.get('config');
    const rateBudget = getGlobalRateBudgetService();
    const snapshot = rateBudget.buildSnapshot({
      scheduler: getScheduler(req),
      assets: getConfiguredAssets(req)
    });

    res.render('admin-rate-budget', {
      title: `${config.adminTitle} - Rate Budget`,
      appName: config.appName,
      budget: {
        ...snapshot,
        last429AtIso: formatTimestamp(snapshot.last429At),
        recoveryUntilIso: formatTimestamp(snapshot.recoveryUntil)
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
    createAlertsFromHealthReport(getDatabase(req), health);

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


router.get('/db-integrity', (req, res, next) => {
  try {
    const config = req.app.get('config');
    const report = req.query.run === '1'
      ? runDatabaseIntegrityCheck(getDatabase(req))
      : null;

    if (report) {
      createAlertsFromIntegrityReport(getDatabase(req), report);
    }

    res.render('admin-db-integrity', {
      title: `${config.adminTitle} - Database Integrity`,
      appName: config.appName,
      report: report ? formatIntegrityReport(report) : null,
      dbIntegrityAction: req.query.dbIntegrityAction || null,
      dbIntegrityDetails: req.query.dbIntegrityDetails || null
    });
  } catch (error) {
    next(error);
  }
});

router.post('/db-integrity/run', (req, res, next) => {
  try {
    const report = runDatabaseIntegrityCheck(getDatabase(req));
    createAlertsFromIntegrityReport(getDatabase(req), report);
    redirectWithDbIntegrityAction(res, 'checked', 'Database integrity check completed.');
  } catch (error) {
    next(error);
  }
});

router.post('/db-integrity/mark-stuck-failed', (req, res, next) => {
  try {
    const result = markStuckFetchRunsFailed(getDatabase(req));
    redirectWithDbIntegrityAction(res, 'marked-stuck-failed', `${result.changed} stuck fetch_run(s) marked failed.`);
  } catch (error) {
    next(error);
  }
});

router.get('/config-history', (req, res, next) => {
  try {
    const config = req.app.get('config');
    const changes = listConfigChanges(getDatabase(req), 50).map((change) => ({
      ...change,
      createdAtIso: formatTimestamp(change.createdAt)
    }));
    const selectedId = Number(req.query.change || (changes[0] && changes[0].id));
    const selectedChange = selectedId ? getConfigChange(getDatabase(req), selectedId) : null;
    const diff = selectedChange ? loadConfigChangeDiff(req, selectedChange) : null;

    res.render('admin-config-history', {
      title: `${config.adminTitle} - Config History`,
      appName: config.appName,
      changes,
      selectedId,
      diff,
      editableConfigs: [
        { filePath: 'config/assets.json', json: readTextFileSafe('config/assets.json') },
        { filePath: 'config/server.json', json: readTextFileSafe(path.join(config.configDir, 'server.json')) }
      ],
      configAction: req.query.configAction || null,
      configDetails: req.query.configDetails || null
    });
  } catch (error) {
    next(error);
  }
});

router.post('/config-history/edit', (req, res) => {
  try {
    const filePath = String(req.body.filePath || '');
    const payload = parseJsonText(req.body.configJson || '');
    const summary = String(req.body.summary || '').trim() || `Edit ${filePath}`;
    const change = saveAdminConfigChange(req, filePath, payload, summary);
    hotReloadConfigFile(req, filePath, payload);
    recordAdminEvent(req, { action: 'config edit', entityType: 'config', entityId: filePath, details: { changeId: change.id, backupPath: change.backupPath, summary } });
    redirectWithConfigAction(res, 'saved', `${filePath} saved. Backup: ${change.backupPath}`, change.id);
  } catch (error) {
    redirectWithConfigAction(res, 'save failed', error.message);
  }
});

router.post('/config-history/:id/rollback', (req, res) => {
  try {
    const change = getConfigChange(getDatabase(req), Number(req.params.id));
    const rollback = rollbackConfigChange({
      db: getDatabase(req),
      config: req.app.get('config'),
      change,
      changedBy: getAdminActor(req)
    });
    const payload = parseJsonText(fs.readFileSync(resolveFromRoot(change.backupPath), 'utf8'));
    hotReloadConfigFile(req, change.filePath, payload);
    recordAdminEvent(req, { action: 'config rollback', entityType: 'config', entityId: change.filePath, details: { sourceChangeId: change.id, rollbackChangeId: rollback.id, restoredFrom: change.backupPath, backupPath: rollback.backupPath } });
    redirectWithConfigAction(res, 'rolled back', `Restored ${change.filePath} from ${change.backupPath}. Current backup: ${rollback.backupPath}`, rollback.id);
  } catch (error) {
    redirectWithConfigAction(res, 'rollback failed', error.message, req.params.id);
  }
});


router.get('/activity', (req, res, next) => {
  try {
    const config = req.app.get('config');
    const db = getDatabase(req);
    const { filters, events } = listAdminEvents(db, req.query, { limit: 200 });
    const actionValues = Array.from(new Set([...ADMIN_EVENT_ACTIONS, ...listAdminEventFacetValues(db, 'action')])).sort();
    const entityTypeValues = Array.from(new Set([...ADMIN_EVENT_ENTITY_TYPES, ...listAdminEventFacetValues(db, 'entity_type')])).sort();

    res.render('admin-activity', {
      title: `${config.adminTitle} - Activity`,
      appName: config.appName,
      filters,
      events: events.map((event) => ({
        ...event,
        createdAtIso: formatTimestamp(event.createdAt)
      })),
      actionValues,
      entityTypeValues
    });
  } catch (error) {
    next(error);
  }
});

router.get('/activity.csv', (req, res, next) => {
  try {
    const { events } = listAdminEvents(getDatabase(req), req.query, { limit: 1000 });
    res.type('text/csv');
    res.set('Content-Disposition', 'attachment; filename="admin-activity.csv"');
    res.send(`${adminEventsToCsv(events)}
`);
  } catch (error) {
    next(error);
  }
});

router.get('/assets', (req, res, next) => {
  try {
    const config = req.app.get('config');
    const db = getDatabase(req);
    const scheduler = getScheduler(req);
    const assets = getConfiguredAssets(req).map((asset) => {
      const bounds = getAssetCandleBounds(db, asset.id);

      return {
        ...asset,
        earliestIso: formatTimestamp(bounds.earliest_ts),
        latestIso: formatTimestamp(bounds.latest_ts),
        staleness: getAssetStaleness(db, asset, { jobScheduler: scheduler })
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
    const { payload } = readEditableAssetConfig(req);
    const index = payload.assets.findIndex((asset) => asset.id === req.params.id);

    if (index === -1) {
      const error = new Error(`Asset '${req.params.id}' was not found.`);
      error.status = 404;
      next(error);
      return;
    }

    payload.assets[index] = normalizeConfigAssetForm(req.body, payload.assets[index]);
    const change = saveAdminConfigChange(req, 'config/assets.json', payload, `Edit asset ${payload.assets[index].id}`);
    hotReloadConfigFile(req, 'config/assets.json', payload);
    recordAdminEvent(req, { action: 'config edit', entityType: 'asset', entityId: payload.assets[index].id, details: { changeId: change.id, backupPath: change.backupPath, filePath: 'config/assets.json' } });

    const params = new URLSearchParams({
      alert: 'success',
      message: `Saved ${payload.assets[index].symbol}. Backup: ${change.backupPath}`
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
    requireMaintenanceDisabled(req, 'Maintenance mode is active; CoinGecko test fetches are paused.');
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
    requireMaintenanceDisabled(req, 'Maintenance mode is active; CoinGecko fetch jobs are paused.');
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
    recordAdminEvent(req, { action: 'manual fetch', entityType: 'asset', entityId: asset.id, details: { kind: 'fetch-recent', jobCount: enqueuedJobs.length, jobs: enqueuedJobs.map((job) => job.id), policy } });

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
    const publicAsset = getPublicAsset(db, req.params.id);

    if (!publicAsset) {
      const error = new Error(`Asset '${req.params.id}' was not found.`);
      error.status = 404;
      next(error);
      return;
    }

    const configuredAsset = findConfiguredAsset(req, req.params.id);
    const asset = configuredAsset ? { ...publicAsset, ...configuredAsset } : publicAsset;
    const bounds = getAssetCandleBounds(db, asset.id);
    const fetchRuns = listFetchRunsForAsset(db, asset.id, 10);
    const staleness = getAssetStaleness(db, asset, { jobScheduler: getScheduler(req) });

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
      fetchRuns,
      staleness,
      rateBudget: getGlobalRateBudgetService().buildSnapshot({ scheduler: getScheduler(req), assets: getConfiguredAssets(req) })
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


router.post('/jobs/:id/retry', (req, res, next) => {
  try {
    const job = getScheduler(req).retryJob(Number(req.params.id));
    recordAdminEvent(req, { action: 'job retry', entityType: 'job', entityId: req.params.id, details: { retried: Boolean(job), job } });
    redirectWithSchedulerAction(res, 'job-retried', job ? `Job #${job.id} queued for retry` : `Job #${req.params.id} was not retried`);
  } catch (error) {
    next(error);
  }
});

router.post('/jobs/:id/cancel', (req, res, next) => {
  try {
    const job = getScheduler(req).cancelJob(Number(req.params.id));
    recordAdminEvent(req, { action: 'job cancel', entityType: 'job', entityId: req.params.id, details: { cancelled: Boolean(job), job } });
    redirectWithSchedulerAction(res, 'job-cancelled', job ? `Job #${job.id} cancelled` : `Job #${req.params.id} was not cancellable`);
  } catch (error) {
    next(error);
  }
});

router.post('/scheduler/pause', (req, res, next) => {
  try {
    getRecentRefreshScheduler(req).pause();
    recordAdminEvent(req, { action: 'scheduler pause', entityType: 'scheduler', entityId: 'recent-refresh', details: { route: '/admin/scheduler/pause' } });
    redirectWithSchedulerAction(res, 'paused');
  } catch (error) {
    next(error);
  }
});

router.post('/scheduler/resume', (req, res, next) => {
  try {
    getRecentRefreshScheduler(req).resume();
    recordAdminEvent(req, { action: 'scheduler resume', entityType: 'scheduler', entityId: 'recent-refresh', details: { route: '/admin/scheduler/resume' } });
    redirectWithSchedulerAction(res, 'resumed');
  } catch (error) {
    next(error);
  }
});


router.post('/scheduler/repair-stale', (req, res, next) => {
  try {
    requireMaintenanceDisabled(req, 'Maintenance mode is active; repair jobs are paused.');
    const result = getRecentRefreshScheduler(req).runNow();
    recordAdminEvent(req, { action: 'backfill request', entityType: 'scheduler', entityId: 'recent-refresh', details: { kind: 'repair-stale', jobCount: result.jobCount } });
    redirectWithSchedulerAction(res, 'repair-stale', `${result.jobCount} repair job(s) queued`);
  } catch (error) {
    next(error);
  }
});

router.post('/scheduler/run-now', (req, res, next) => {
  try {
    requireMaintenanceDisabled(req, 'Maintenance mode is active; refresh jobs are paused.');
    const result = getRecentRefreshScheduler(req).runNow();
    recordAdminEvent(req, { action: 'manual fetch', entityType: 'scheduler', entityId: 'recent-refresh', details: { kind: 'run-now', jobCount: result.jobCount } });
    redirectWithSchedulerAction(res, 'run-now', `${result.jobCount} job(s) queued`);
  } catch (error) {
    next(error);
  }
});


router.post('/maintenance', (req, res, next) => {
  try {
    const enable = req.body.mode === 'on' || req.body.maintenanceMode === 'true';
    const payload = parseJsonText(fs.readFileSync(resolveFromRoot(path.join(req.app.get('config').configDir, 'server.json')), 'utf8'));
    payload.maintenanceMode = enable;
    const change = saveAdminConfigChange(req, 'config/server.json', payload, `Maintenance mode ${enable ? 'enabled' : 'disabled'}`);
    hotReloadConfigFile(req, 'config/server.json', payload);
    recordAdminEvent(req, { action: 'maintenance mode toggle', entityType: 'config', entityId: 'config/server.json', details: { enabled: enable, changeId: change.id, backupPath: change.backupPath } });
    redirectWithSchedulerAction(
      res,
      enable ? 'maintenance-on' : 'maintenance-off',
      `Maintenance mode ${enable ? 'enabled' : 'disabled'} in config/server.json; backup: ${change.backupPath}`
    );
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
        databasePath: resolveFromRoot(config.databasePath),
        maintenanceMode: config.maintenanceMode === true
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
