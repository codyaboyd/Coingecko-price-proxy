const express = require('express');
const fs = require('fs');
const path = require('path');

const { getAssetCandleBounds, getConfigChange, getNextConfigChangeForFile, getPublicAsset, listConfigChanges, listFetchRunsForAsset, upsertAssets } = require('../db/queries');
const { readAssetConfig, loadAssets } = require('../services/asset-service');
const { CONFLICT_POLICIES, DEFAULT_CONFLICT_POLICY, SUPPORTED_INTERVALS, countCandles } = require('../services/history-service');
const { INPUT_FORMATS, convertDumpFile, getImportFile, importNormalizedHistoryFile, listImportFiles, previewNormalizedHistoryFile, registerImportFile, updateImportFile } = require('../services/import-service');
const { ensureDirectory, resolveFromRoot } = require('../utils/files');
const { enqueueBackfill } = require('../jobs/backfill-job');
const { createScheduler } = require('../jobs/scheduler');
const { createCleanupScheduler } = require('../jobs/cleanup-scheduler');
const { buildRecentRefreshJobs, createRecentRefreshScheduler, normalizeFetchPolicy } = require('../jobs/recent-refresh-scheduler');
const { clearApiCache, getApiCacheStats } = require('../services/api-cache');
const { createBackupService } = require('../services/backup-service');
const { RESTORE_CONFIRMATION_PHRASE, restoreBackup } = require('../services/restore-service');
const { configureCoinGeckoDefaults, createCoinGeckoClient, fetchMarketChartRange } = require('../services/coingecko');
const { getGapReport, INTERVAL_STEPS_MS } = require('../services/cache-policy');
const { getGlobalRateBudgetService } = require('../services/rate-budget-service');
const { getGlobalLimiter } = require('../utils/limiter');
const { buildSystemHealth, bytesToSummary } = require('../services/system-health');
const { clearLogFile, listLogFiles, readLatestLogLines, resolveLogFile } = require('../services/log-service');
const { buildAdminDoctorReport } = require('../services/admin-doctor-service');
const { markStuckFetchRunsFailed, runDatabaseIntegrityCheck } = require('../services/db-integrity-service');
const { getAssetStaleness } = require('../services/staleness-service');
const { applyMaintenanceModeToRuntime, createMaintenanceError, isMaintenanceMode } = require('../services/maintenance-service');
const { assertTimestampRange, DAY_MS, parseDateInput } = require('../utils/date');
const { parseJsonText, rollbackConfigChange, saveConfigChange } = require('../services/config-change-service');
const { buildProfilePreview, listProfiles, readProfile, readServerConfigFile } = require('../services/profile-service');
const { ADMIN_EVENT_ACTIONS, ADMIN_EVENT_ENTITY_TYPES, adminEventsToCsv, listAdminEventFacetValues, listAdminEvents, recordAdminEvent } = require('../services/admin-activity-service');
const { createAlertsFromHealthReport, createAlertsFromIntegrityReport, listAlerts, updateAlertStatus } = require('../services/alert-service');
const logger = require('../utils/logger');
const { createPortableBundle } = require('../../scripts/create-portable-bundle');

const router = express.Router();
const MAX_IMPORT_FILE_BYTES = 50 * 1024 * 1024;
const MAX_ADMIN_FETCH_RANGE_MS = 366 * DAY_MS;
const IMPORT_UPLOAD_FIELD = 'importUpload';


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

function getImportArchiveDirectory(req) {
  return path.join(getImportsDirectory(req), 'archive');
}

function getImportFailedDirectory(req) {
  return path.join(getImportsDirectory(req), 'failed');
}

function sanitizeUploadFileName(fileName) {
  const baseName = path.basename(String(fileName || '').trim());
  const safeName = baseName.replace(/[^a-z0-9_.-]/gi, '-').replace(/^-+/, '').slice(0, 180);
  return safeName || `import-${Date.now()}`;
}

function buildUniqueImportUploadPath(importsDir, fileName) {
  const parsed = path.parse(sanitizeUploadFileName(fileName));
  const baseName = parsed.name || 'import';
  const extension = parsed.ext || '';
  let candidate = path.join(importsDir, `${baseName}${extension}`);
  let suffix = 1;

  while (fs.existsSync(candidate)) {
    candidate = path.join(importsDir, `${baseName}-${suffix}${extension}`);
    suffix += 1;
  }

  return candidate;
}

function collectMultipartRequest(req, maxBytes = MAX_IMPORT_FILE_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;

    req.on('data', (chunk) => {
      totalBytes += chunk.length;

      if (totalBytes > maxBytes) {
        const error = new Error('Import upload is too large for the admin inbox.');
        error.status = 413;
        req.destroy(error);
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks, totalBytes)));
    req.on('error', reject);
  });
}

function parseMultipartFileUpload(body, contentType, fieldName) {
  const boundaryMatch = String(contentType || '').match(/(?:^|;)\s*boundary=([^;]+)/i);

  if (!boundaryMatch) {
    const error = new Error('File upload must use multipart/form-data.');
    error.status = 400;
    throw error;
  }

  const boundaryValue = boundaryMatch[1].replace(/^"|"$/g, '');
  const boundary = Buffer.from(`--${boundaryValue}`);
  let cursor = body.indexOf(boundary);

  while (cursor !== -1) {
    const partStart = cursor + boundary.length;

    if (body.slice(partStart, partStart + 2).toString('latin1') === '--') {
      break;
    }

    const headerStart = body.slice(partStart, partStart + 2).toString('latin1') === '\r\n' ? partStart + 2 : partStart;
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), headerStart);

    if (headerEnd === -1) {
      break;
    }

    const headers = body.slice(headerStart, headerEnd).toString('latin1');
    const disposition = headers.split(/\r\n/).find((header) => /^content-disposition:/i.test(header)) || '';
    const nameMatch = disposition.match(/(?:^|;)\s*name="([^"]+)"/i);
    const filenameMatch = disposition.match(/(?:^|;)\s*filename="([^"]*)"/i);
    const contentStart = headerEnd + 4;
    const nextBoundary = body.indexOf(boundary, contentStart);

    if (nextBoundary === -1) {
      break;
    }

    let contentEnd = nextBoundary;

    if (contentEnd >= 2 && body[contentEnd - 2] === 13 && body[contentEnd - 1] === 10) {
      contentEnd -= 2;
    }

    if (nameMatch && nameMatch[1] === fieldName && filenameMatch) {
      return {
        filename: filenameMatch[1],
        content: body.slice(contentStart, contentEnd)
      };
    }

    cursor = nextBoundary;
  }

  const error = new Error('Choose a CSV or JSON file before adding it to the inbox.');
  error.status = 400;
  throw error;
}

async function saveImportUpload(req) {
  const importsDir = getImportsDirectory(req);
  ensureImportInboxDirectories(req);
  const body = await collectMultipartRequest(req);
  const upload = parseMultipartFileUpload(body, req.headers['content-type'], IMPORT_UPLOAD_FIELD);

  if (!upload.filename || upload.content.length === 0) {
    const error = new Error('Choose a non-empty import file before adding it to the inbox.');
    error.status = 400;
    throw error;
  }

  if (upload.content.length > MAX_IMPORT_FILE_BYTES) {
    const error = new Error('Import upload is too large for the admin inbox.');
    error.status = 413;
    throw error;
  }

  const targetPath = buildUniqueImportUploadPath(importsDir, upload.filename);
  fs.writeFileSync(targetPath, upload.content, { flag: 'wx' });
  const safePath = assertInsideDirectory(importsDir, targetPath, 'Import upload cannot be saved outside data/imports.');
  const relativeName = path.relative(importsDir, safePath);
  return registerImportFile(getDatabase(req), safePath, { filename: relativeName });
}

function ensureImportInboxDirectories(req) {
  ensureDirectory(getImportsDirectory(req));
  ensureDirectory(getImportArchiveDirectory(req));
  ensureDirectory(getImportFailedDirectory(req));
}

function isImportInboxFile(importsDir, absolutePath) {
  const relativePath = path.relative(importsDir, absolutePath);

  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return false;
  }

  const parts = relativePath.split(path.sep);
  return !['archive', 'failed', 'converted'].includes(parts[0]);
}

function syncImportInbox(req) {
  const db = getDatabase(req);
  const importsDir = getImportsDirectory(req);
  ensureImportInboxDirectories(req);

  const scan = (directory, prefix = '') => {
    fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
      if (entry.name.startsWith('.')) {
        return;
      }

      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.join(prefix, entry.name);

      if (!isImportInboxFile(importsDir, absolutePath)) {
        return;
      }

      if (entry.isDirectory()) {
        scan(absolutePath, relativePath);
        return;
      }

      if (!entry.isFile()) {
        return;
      }

      registerImportFile(db, absolutePath, { filename: relativePath });
    });
  };

  scan(importsDir);
  return listImportFiles(db);
}

function formatImportFileForView(file) {
  let stats = null;

  try {
    stats = fs.existsSync(file.fullPath) ? fs.statSync(file.fullPath) : null;
  } catch (error) {
    stats = null;
  }

  return {
    ...file,
    name: file.filename,
    size: stats ? stats.size : 0,
    updatedAtIso: formatTimestamp(file.updatedAt),
    createdAtIso: formatTimestamp(file.createdAt),
    shortHash: file.fileHash.slice(0, 12),
    exists: Boolean(stats)
  };
}

function listPendingImportFiles(req) {
  return syncImportInbox(req).map(formatImportFileForView);
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


function formatCoverageTimestamp(timestamp) {
  return timestamp === null || timestamp === undefined ? null : new Date(timestamp).toISOString();
}

function summarizeMissingMarketFields(row) {
  const fields = [
    ['open', row.missing_open],
    ['high', row.missing_high],
    ['low', row.missing_low],
    ['volume', row.missing_volume],
    ['market cap', row.missing_market_cap]
  ];

  return fields
    .filter(([, count]) => Number(count) > 0)
    .map(([field, count]) => ({ field, count: Number(count) }));
}

function buildMarketDataCoverageSummary(db, assets, intervals) {
  const rows = db.prepare(`
    SELECT
      asset_id,
      vs_currency,
      interval,
      COUNT(*) AS candle_count,
      MIN(ts) AS earliest_ts,
      MAX(ts) AS latest_ts,
      SUM(CASE WHEN open IS NULL THEN 1 ELSE 0 END) AS missing_open,
      SUM(CASE WHEN high IS NULL THEN 1 ELSE 0 END) AS missing_high,
      SUM(CASE WHEN low IS NULL THEN 1 ELSE 0 END) AS missing_low,
      SUM(CASE WHEN volume IS NULL THEN 1 ELSE 0 END) AS missing_volume,
      SUM(CASE WHEN market_cap IS NULL THEN 1 ELSE 0 END) AS missing_market_cap
    FROM candles
    GROUP BY asset_id, vs_currency, interval
  `).all();
  const byAssetCurrencyInterval = new Map(rows.map((row) => [
    `${row.asset_id}:${row.vs_currency}:${row.interval}`,
    row
  ]));

  return assets.map((asset) => {
    const vsCurrency = String(asset.vsCurrency || 'usd').trim().toLowerCase();

    return {
      asset,
      vsCurrency,
      intervals: intervals.map((interval) => {
        const row = byAssetCurrencyInterval.get(`${asset.id}:${vsCurrency}:${interval}`) || null;

        if (!row || Number(row.candle_count) === 0) {
          return {
            interval,
            candleCount: 0,
            earliestIso: null,
            latestIso: null,
            expectedCount: 0,
            missingCandles: null,
            missingFields: [],
            importSummary: 'No local candles yet; import a complete dataset for this interval.'
          };
        }

        const stepMs = INTERVAL_STEPS_MS[interval];
        const expectedCount = stepMs
          ? Math.floor((Number(row.latest_ts) - Number(row.earliest_ts)) / stepMs) + 1
          : Number(row.candle_count);
        const missingCandles = Math.max(0, expectedCount - Number(row.candle_count));
        const missingFields = summarizeMissingMarketFields(row);
        const missingFieldTotal = missingFields.reduce((total, item) => total + item.count, 0);
        const importSummaryParts = [];

        if (missingCandles > 0) {
          importSummaryParts.push(`${missingCandles.toLocaleString()} missing candle timestamp(s)`);
        }

        missingFields.forEach((item) => {
          importSummaryParts.push(`${item.count.toLocaleString()} row(s) missing ${item.field}`);
        });

        return {
          interval,
          candleCount: Number(row.candle_count),
          earliestIso: formatCoverageTimestamp(row.earliest_ts),
          latestIso: formatCoverageTimestamp(row.latest_ts),
          expectedCount,
          missingCandles,
          missingFields,
          missingFieldTotal,
          importSummary: importSummaryParts.length > 0
            ? importSummaryParts.join('; ')
            : 'Complete within the stored range.'
        };
      })
    };
  });
}

function renderImportsPage(req, res, extras = {}) {
  const config = req.app.get('config');
  const assets = getConfiguredAssets(req);
  const files = listPendingImportFiles(req);
  const selectedImportId = Number(extras.importFileId || req.query.importFileId || req.query.fileId || 0) || null;
  const selectedById = selectedImportId ? files.find((file) => file.id === selectedImportId) : null;
  const selectedByName = extras.selectedFile || req.query.file || null;
  const selectedImportFile = selectedById || files.find((file) => file.filename === selectedByName) || files[0] || null;
  const selectedFile = selectedImportFile ? selectedImportFile.filename : null;
  const selectedAssetId = extras.assetId || req.query.asset || (selectedImportFile && selectedImportFile.assetId) || (assets[0] || {}).id || '';
  const selectedAsset = assets.find((asset) => asset.id === selectedAssetId) || assets[0] || null;
  const selectedInputFormat = Array.from(INPUT_FORMATS).includes(extras.inputFormat || req.query.inputFormat)
    ? (extras.inputFormat || req.query.inputFormat)
    : 'auto';
  const selectedInterval = selectedInputFormat === 'unix-ohlcv-60s'
    ? '1m'
    : (extras.interval || req.query.interval || (selectedImportFile && selectedImportFile.interval) || '1d');
  const selectedPolicy = extras.policy || req.query.policy || DEFAULT_CONFLICT_POLICY;
  const intervals = Array.from(SUPPORTED_INTERVALS);
  let preview = extras.preview || null;
  let previewError = extras.previewError || null;

  if (!preview && selectedImportFile && selectedAsset) {
    try {
      preview = previewImportFile(resolveImportFile(req, selectedImportFile.filename), {
        assetId: selectedAsset.id,
        symbol: selectedAsset.symbol,
        vsCurrency: selectedAsset.vsCurrency,
        interval: selectedInterval,
        inputFormat: selectedInputFormat
      });
      updateImportFile(getDatabase(req), selectedImportFile.id, {
        status: selectedImportFile.status === 'pending' ? 'previewed' : selectedImportFile.status,
        detectedFormat: preview.detectedFormat,
        assetId: selectedAsset.id,
        interval: selectedInterval,
        rowsSeen: preview.rowsSeen,
        lastError: null
      });
      selectedImportFile.status = selectedImportFile.status === 'pending' ? 'previewed' : selectedImportFile.status;
      selectedImportFile.detectedFormat = preview.detectedFormat;
      selectedImportFile.assetId = selectedAsset.id;
      selectedImportFile.interval = selectedInterval;
      selectedImportFile.rowsSeen = preview.rowsSeen;
      selectedImportFile.lastError = null;
    } catch (error) {
      previewError = error.message;
      if (selectedImportFile.status !== 'imported') {
        updateImportFile(getDatabase(req), selectedImportFile.id, { status: 'failed', lastError: error.message });
      }
      logger.warn(`Import preview failed for ${selectedFile}: ${error.message}`);
    }
  }

  res.render('admin-imports', {
    title: `${config.adminTitle} - Imports`,
    appName: config.appName,
    assets,
    files,
    intervals,
    inputFormats: Array.from(INPUT_FORMATS),
    policies: Array.from(CONFLICT_POLICIES),
    marketDataCoverage: buildMarketDataCoverageSummary(getDatabase(req), assets, intervals),
    selectedImportFile,
    selectedFile,
    selectedAssetId,
    selectedInterval,
    selectedInputFormat,
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



function getCleanupScheduler(req) {
  let scheduler = req.app.get('cleanupScheduler');

  if (!scheduler) {
    scheduler = createCleanupScheduler({ db: getDatabase(req), config: req.app.get('config'), app: req.app });
    scheduler.start();
    req.app.set('cleanupScheduler', scheduler);
  }

  return scheduler;
}

function redirectWithCleanupAction(res, action, details) {
  const params = new URLSearchParams({ cleanupAction: action });

  if (details) {
    params.set('cleanupDetails', details);
  }

  res.redirect(`/admin/cleanup?${params.toString()}`);
}

function formatCleanupSummary(summary) {
  if (!summary) {
    return [];
  }

  return [
    { label: 'Expired API cache rows pruned', value: summary.apiCache ? summary.apiCache.rowsDeleted : 0 },
    { label: 'Completed jobs cleared', value: summary.completedJobs ? summary.completedJobs.rowsDeleted : 0 },
    { label: 'Log files rotated', value: summary.logs && Array.isArray(summary.logs.rotatedFiles) ? summary.logs.rotatedFiles.length : 0 },
    { label: 'Backups pruned', value: summary.backups ? summary.backups.pruned : 0 },
    { label: 'Backup files deleted', value: summary.backups ? summary.backups.deletedFiles : 0 },
    { label: 'Imported files archived', value: summary.importedFiles ? summary.importedFiles.archived : 0 },
    { label: 'Stale alerts resolved', value: summary.alerts ? summary.alerts.resolved : 0 },
    { label: 'Raw historical candle rows deleted', value: summary.historicalCandlesDeleted || 0 }
  ];
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

function redirectWithBundleAction(res, action, details) {
  const params = new URLSearchParams({ bundleAction: action });

  if (details) {
    params.set('bundleDetails', details);
  }

  res.redirect(`/admin?${params.toString()}`);
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


function formatLogFileForView(file) {
  return {
    ...file,
    sizeLabel: bytesToSummary(file.sizeBytes),
    updatedAtIso: formatTimestamp(file.updatedAt)
  };
}

function redirectWithLogAction(res, params) {
  const searchParams = new URLSearchParams(params);
  res.redirect(`/admin/logs?${searchParams.toString()}`);
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

function slugifyAssetId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeNewAssetForm(body = {}, existingAssets = []) {
  const symbol = normalizeTextField(body.symbol, 'symbol').toUpperCase();
  const name = normalizeTextField(body.name, 'name');
  const id = slugifyAssetId(body.id || symbol);
  const coingeckoId = normalizeTextField(body.coingeckoId, 'coingeckoId').toLowerCase();
  const vsCurrency = normalizeTextField(body.vsCurrency || 'usd', 'vsCurrency').toLowerCase();
  const maxPriority = existingAssets.reduce((max, asset) => Math.max(max, Number(asset.priority) || 0), 0);

  if (!id) {
    throw new Error('id must contain at least one letter or number.');
  }

  if (existingAssets.some((asset) => String(asset.id).toLowerCase() === id)) {
    throw new Error(`Asset ID '${id}' is already configured.`);
  }

  if (existingAssets.some((asset) => String(asset.coingeckoId).toLowerCase() === coingeckoId)) {
    throw new Error(`CoinGecko ID '${coingeckoId}' is already configured.`);
  }

  return {
    id,
    symbol,
    name,
    coingeckoId,
    vsCurrency,
    enabled: true,
    priority: parsePositiveIntegerField(body.priority === undefined || body.priority === '' ? maxPriority + 10 : body.priority, 'priority'),
    fetchPolicy: {
      recentEveryMinutes: parsePositiveNumberField(body.recentEveryMinutes || 60, 'fetchPolicy.recentEveryMinutes'),
      dailyBackfill: body.dailyBackfill === undefined || body.dailyBackfill === 'on' || body.dailyBackfill === 'true' || body.dailyBackfill === true,
      maxBackfillDaysPerRun: parsePositiveNumberField(body.maxBackfillDaysPerRun || 10, 'fetchPolicy.maxBackfillDaysPerRun')
    }
  };
}

function duplicateAssetIssues(asset, existingAssets = []) {
  const id = String(asset.id || '').toLowerCase();
  const coingeckoId = String(asset.coingeckoId || '').toLowerCase();
  const issues = [];

  if (existingAssets.some((existingAsset) => String(existingAsset.id).toLowerCase() === id)) {
    issues.push(`Asset ID '${asset.id}' is already configured.`);
  }

  if (existingAssets.some((existingAsset) => String(existingAsset.coingeckoId).toLowerCase() === coingeckoId)) {
    issues.push(`CoinGecko ID '${asset.coingeckoId}' is already configured.`);
  }

  return issues;
}

async function validateCoinGeckoId(coingeckoId) {
  const id = normalizeTextField(coingeckoId, 'coingeckoId').toLowerCase();
  const client = createCoinGeckoClient();
  const metadata = await client.requestJson(`/coins/${encodeURIComponent(id)}`, {
    localization: false,
    tickers: false,
    market_data: false,
    community_data: false,
    developer_data: false,
    sparkline: false
  }, { trackRefresh: false });

  if (!metadata || String(metadata.id || '').toLowerCase() !== id) {
    throw new Error(`CoinGecko did not return metadata for '${id}'.`);
  }

  return {
    id: metadata.id,
    symbol: metadata.symbol ? String(metadata.symbol).toUpperCase() : null,
    name: metadata.name || null
  };
}

function buildInitialBackfillRequest(asset, body = {}) {
  const now = Date.now();
  const days = parsePositiveNumberField(body.backfillDays || 30, 'backfillDays');

  return {
    from: new Date(now - (days * DAY_MS)).toISOString(),
    to: new Date(now).toISOString(),
    interval: body.backfillInterval || '1d',
    vsCurrency: asset.vsCurrency,
    conflictPolicy: DEFAULT_CONFLICT_POLICY
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

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function renderMarkdownDocument(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const html = [];
  let inCodeBlock = false;
  let codeLines = [];
  let inList = false;
  let paragraph = [];

  function flushParagraph() {
    if (paragraph.length > 0) {
      html.push(`<p>${renderInlineMarkdown(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  }

  function closeList() {
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
  }

  lines.forEach((line) => {
    if (line.startsWith('```')) {
      flushParagraph();
      closeList();
      if (inCodeBlock) {
        html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        codeLines = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      return;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      return;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = Math.min(heading[1].length + 1, 5);
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      return;
    }

    const listItem = line.match(/^[-*]\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      html.push(`<li>${renderInlineMarkdown(listItem[1])}</li>`);
      return;
    }

    if (line.trim() === '') {
      flushParagraph();
      closeList();
      return;
    }

    closeList();
    paragraph.push(line.trim());
  });

  if (inCodeBlock) {
    html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  }

  flushParagraph();
  closeList();
  return html.join('\n');
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

    const runtimeConfig = { ...req.app.get('config'), ...payload };
    req.app.set('config', runtimeConfig);
    applyMaintenanceModeToRuntime(req.app, payload.maintenanceMode === true);
    if (runtimeConfig.coingecko) {
      configureCoinGeckoDefaults(runtimeConfig.coingecko);
      getGlobalRateBudgetService(runtimeConfig.coingecko).configure(runtimeConfig.coingecko);
      getGlobalLimiter(runtimeConfig.coingecko).configure(runtimeConfig.coingecko);
    }
    const recentRefreshScheduler = req.app.get('recentRefreshScheduler');
    if (recentRefreshScheduler && typeof recentRefreshScheduler.reloadConfig === 'function') {
      recentRefreshScheduler.reloadConfig(runtimeConfig);
    }
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



router.get('/runbook', (req, res, next) => {
  try {
    const config = req.app.get('config');
    const markdown = readTextFileSafe('docs/RUNBOOK.md');

    res.render('admin-runbook', {
      title: `${config.adminTitle} - Runbook`,
      appName: config.appName,
      markdown,
      runbookHtml: renderMarkdownDocument(markdown)
    });
  } catch (error) {
    next(error);
  }
});

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

router.post('/imports/upload', async (req, res, next) => {
  try {
    requireMaintenanceDisabled(req, 'Maintenance mode is active; imports are paused.');
    const importFile = await saveImportUpload(req);

    recordAdminEvent(req, {
      action: 'import upload',
      entityType: 'import',
      entityId: importFile.id,
      details: { fileName: importFile.filename, status: importFile.status }
    });

    res.redirect(`/admin/imports?importFileId=${importFile.id}`);
  } catch (error) {
    renderImportsPage(req, res, { error: error.message });
  }
});

router.post('/imports/run', (req, res, next) => {
  try {
    requireMaintenanceDisabled(req, 'Maintenance mode is active; imports are paused.');
    const importFileId = Number(req.body.importFileId || 0);
    const requestedFileName = String(req.body.file || '').trim();
    let importFile = importFileId ? getImportFile(getDatabase(req), importFileId) : null;

    if (requestedFileName && (!importFile || importFile.filename !== requestedFileName)) {
      importFile = syncImportInbox(req).find((candidate) => candidate.filename === requestedFileName) || null;
    }

    const fileName = importFile ? importFile.filename : requestedFileName;
    const assetId = req.body.assetId;
    const inputFormat = Array.from(INPUT_FORMATS).includes(req.body.inputFormat) ? req.body.inputFormat : 'auto';
    const interval = inputFormat === 'unix-ohlcv-60s'
      ? '1m'
      : (Array.from(SUPPORTED_INTERVALS).includes(req.body.interval) ? req.body.interval : '1d');
    const policy = Array.from(CONFLICT_POLICIES).includes(req.body.policy) ? req.body.policy : DEFAULT_CONFLICT_POLICY;
    const assets = getConfiguredAssets(req);
    const asset = assets.find((candidate) => candidate.id === assetId);

    if (!asset) {
      throw new Error('Choose a configured asset before importing.');
    }

    if (importFile && importFile.status === 'imported') {
      throw new Error('This file hash has already been imported. Archive it or choose a different file.');
    }

    const sourcePath = resolveImportFile(req, fileName);
    const registeredFile = importFile || registerImportFile(getDatabase(req), sourcePath, { filename: fileName });
    let normalizedPath = sourcePath;
    let conversionReport = null;

    if (!looksLikeNormalizedFile(sourcePath)) {
      const conversion = convertDumpFile(sourcePath, {
        assetId: asset.id,
        symbol: asset.symbol,
        vsCurrency: asset.vsCurrency,
        interval,
        inputFormat
      });
      normalizedPath = buildConvertedPath(req, sourcePath, asset.id);
      fs.writeFileSync(normalizedPath, `${JSON.stringify({
        ...conversion.output,
        detectedFormat: conversion.report.detectedFormat
      }, null, 2)}\n`);
      conversionReport = conversion.report;
      updateImportFile(getDatabase(req), registeredFile.id, {
        status: 'converted',
        detectedFormat: conversion.report.detectedFormat,
        assetId: asset.id,
        interval,
        rowsSeen: conversion.report.rowsSeen,
        lastError: null
      });
    }

    const result = importNormalizedHistoryFile(normalizedPath, {
      db: getDatabase(req),
      policy,
      assetId: asset.id,
      vsCurrency: asset.vsCurrency,
      interval
    });

    updateImportFile(getDatabase(req), registeredFile.id, {
      status: 'imported',
      detectedFormat: result.detectedFormat,
      assetId: asset.id,
      interval,
      rowsSeen: result.rowsSeen,
      rowsImported: result.rowsImported,
      lastError: null
    });

    recordAdminEvent(req, {
      action: 'import run',
      entityType: 'import',
      entityId: result.importRunId || asset.id,
      details: { status: result.status || 'completed', assetId: asset.id, fileName, normalizedPath: path.relative(process.cwd(), normalizedPath), rowsImported: result.rowsImported, policy }
    });

    renderImportsPage(req, res, {
      importFileId: registeredFile.id,
      assetId: asset.id,
      interval,
      inputFormat,
      policy,
      result: {
        ...result,
        normalizedFile: path.relative(process.cwd(), normalizedPath),
        rawFile: path.relative(process.cwd(), sourcePath),
        conversionReport
      }
    });
  } catch (error) {
    const importFileId = Number(req.body.importFileId || 0);
    if (importFileId) {
      const failedFile = getImportFile(getDatabase(req), importFileId);
      if (failedFile && failedFile.status !== 'imported') {
        updateImportFile(getDatabase(req), importFileId, { status: 'failed', lastError: error.message });
      }
    }
    recordAdminEvent(req, {
      action: 'import run',
      entityType: 'import',
      entityId: req.body.assetId || req.body.file || null,
      details: { status: 'failed', assetId: req.body.assetId, fileName: req.body.file, error: error.message }
    });
    renderImportsPage(req, res, {
      importFileId,
      selectedFile: req.body.file,
      assetId: req.body.assetId,
      interval: req.body.interval,
      inputFormat: req.body.inputFormat,
      policy: req.body.policy,
      error: error.message
    });
  }
});

router.post('/imports/archive', (req, res, next) => {
  try {
    const importFileId = Number(req.body.importFileId || 0);
    const importFile = importFileId ? getImportFile(getDatabase(req), importFileId) : null;

    if (!importFile) {
      throw new Error('Choose a registered import file to archive.');
    }

    const sourcePath = resolveImportFile(req, importFile.filename);
    const archiveDir = getImportArchiveDirectory(req);
    ensureDirectory(archiveDir);
    const targetPath = path.join(archiveDir, `${Date.now()}-${path.basename(importFile.filename)}`);
    fs.renameSync(sourcePath, targetPath);
    const archived = updateImportFile(getDatabase(req), importFile.id, {
      status: 'archived',
      fullPath: targetPath,
      filename: path.relative(getImportsDirectory(req), targetPath),
      lastError: null
    });

    recordAdminEvent(req, {
      action: 'import archive',
      entityType: 'import',
      entityId: importFile.id,
      details: { fileName: archived.filename, status: archived.status }
    });

    renderImportsPage(req, res, {
      result: {
        runId: importFile.id,
        rowsImported: importFile.rowsImported,
        rowsSeen: importFile.rowsSeen,
        policy: 'archive',
        normalizedFile: archived.filename
      }
    });
  } catch (error) {
    renderImportsPage(req, res, { importFileId: Number(req.body.importFileId || 0), error: error.message });
  }
});



router.get('/cleanup', (req, res, next) => {
  try {
    const config = req.app.get('config');
    const cleanupScheduler = getCleanupScheduler(req);
    const status = cleanupScheduler.getStatus();
    const lastRun = status.lastRun;

    res.render('admin-cleanup', {
      title: `${config.adminTitle} - Cleanup`,
      appName: config.appName,
      cleanup: {
        ...status,
        lastRun,
        summaryItems: formatCleanupSummary(lastRun && lastRun.summary)
      },
      cleanupAction: req.query.cleanupAction || null,
      cleanupDetails: req.query.cleanupDetails || null
    });
  } catch (error) {
    next(error);
  }
});

router.post('/cleanup/run', async (req, res, next) => {
  try {
    const result = await getCleanupScheduler(req).runNow({ manual: true });
    recordAdminEvent(req, {
      action: 'cleanup run',
      entityType: 'system',
      entityId: 'cleanup',
      details: { status: result.status, summary: result.summary }
    });
    redirectWithCleanupAction(res, 'completed', `Run #${result.id} completed.`);
  } catch (error) {
    next(error);
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


router.get('/logs', (req, res, next) => {
  try {
    const config = req.app.get('config');
    const files = listLogFiles().map(formatLogFileForView);
    const selectedFile = req.query.file || (files[0] && files[0].name) || 'server.log';
    const lineCount = req.query.lines || '200';
    const filter = req.query.filter || '';
    const lines = readLatestLogLines(selectedFile, { lines: lineCount, filter });

    res.render('admin-logs', {
      title: `${config.adminTitle} - Logs`,
      appName: config.appName,
      files,
      selectedFile,
      lineCount,
      filter,
      lines,
      logAction: req.query.logAction || null,
      logDetails: req.query.logDetails || null,
      error: req.query.error || null
    });
  } catch (error) {
    next(error);
  }
});

router.get('/logs/download', (req, res, next) => {
  try {
    const filePath = resolveLogFile(req.query.file || 'server.log');
    res.download(filePath, path.basename(filePath));
  } catch (error) {
    next(error);
  }
});

router.post('/logs/clear', (req, res) => {
  try {
    const result = clearLogFile(req.body.file || 'server.log', req.body.confirmation);
    recordAdminEvent(req, { action: 'log cleared', entityType: 'log', entityId: result.fileName, details: { fileName: result.fileName } });
    redirectWithLogAction(res, { file: result.fileName, logAction: 'cleared', logDetails: `${result.fileName} cleared` });
  } catch (error) {
    redirectWithLogAction(res, { file: req.body.file || 'server.log', error: error.message });
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


router.get('/settings', (req, res, next) => {
  try {
    const runtimeConfig = req.app.get('config');
    const fileConfig = readServerConfigFile(runtimeConfig);
    const previews = listProfiles().map((profile) => buildProfilePreview(fileConfig, profile));

    res.render('admin-settings', {
      title: `${runtimeConfig.adminTitle} Settings`,
      appName: runtimeConfig.appName,
      currentProfile: fileConfig.profile || runtimeConfig.profile || 'conservative',
      previews,
      settingsAction: req.query.settingsAction || null,
      settingsDetails: req.query.settingsDetails || null
    });
  } catch (error) {
    next(error);
  }
});

router.post('/settings/profile', (req, res) => {
  try {
    const profile = readProfile(req.body.profile);
    const fileConfig = readServerConfigFile(req.app.get('config'));
    const preview = buildProfilePreview(fileConfig, profile);
    const change = saveAdminConfigChange(req, 'config/server.json', preview.nextConfig, `Apply ${profile.name} profile`);
    hotReloadConfigFile(req, 'config/server.json', preview.nextConfig);
    recordAdminEvent(req, {
      action: 'profile apply',
      entityType: 'config',
      entityId: 'config/server.json',
      details: {
        profile: profile.id,
        changeId: change.id,
        backupPath: change.backupPath,
        changedValues: preview.changes.map((item) => item.key)
      }
    });

    const params = new URLSearchParams({
      settingsAction: 'profile applied',
      settingsDetails: `${profile.name} profile applied. Backup: ${change.backupPath}`
    });
    res.redirect(`/admin/settings?${params.toString()}`);
  } catch (error) {
    const params = new URLSearchParams({
      settingsAction: 'profile failed',
      settingsDetails: error.message
    });
    res.redirect(`/admin/settings?${params.toString()}`);
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
        staleness: getAssetStaleness(db, asset, { jobScheduler: scheduler, config: req.app.get('config') })
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

router.get('/assets/new', (req, res, next) => {
  try {
    const config = req.app.get('config');
    const existingAssets = getConfiguredAssets(req);
    const maxPriority = existingAssets.reduce((max, asset) => Math.max(max, Number(asset.priority) || 0), 0);

    res.render('admin-asset-new', {
      title: `${config.adminTitle} - Add Asset`,
      appName: config.appName,
      existingAssets,
      defaults: {
        vsCurrency: 'usd',
        recentEveryMinutes: 60,
        maxBackfillDaysPerRun: 10,
        priority: maxPriority + 10,
        backfillDays: 30,
        backfillInterval: '1d'
      },
      intervals: Array.from(SUPPORTED_INTERVALS),
      alert: req.query.alert || null,
      message: req.query.message || null
    });
  } catch (error) {
    next(error);
  }
});

router.post('/assets/new/test/coingecko', async (req, res, next) => {
  try {
    requireMaintenanceDisabled(req, 'Maintenance mode is active; CoinGecko asset validation is paused.');
    const { payload } = readEditableAssetConfig(req);
    const candidate = normalizeNewAssetForm(req.body, []);
    const duplicateIssues = duplicateAssetIssues(candidate, payload.assets);

    if (duplicateIssues.length > 0) {
      res.status(409).json({ ok: false, errors: duplicateIssues });
      return;
    }

    const metadata = await validateCoinGeckoId(candidate.coingeckoId);
    const toTs = Date.now();
    const fromTs = toTs - (2 * DAY_MS);
    const sample = await fetchMarketChartRange(candidate.coingeckoId, candidate.vsCurrency, fromTs, toTs);

    res.json({
      ok: true,
      asset: candidate,
      metadata,
      sampleCounts: {
        prices: Array.isArray(sample.prices) ? sample.prices.length : 0,
        marketCaps: Array.isArray(sample.market_caps) ? sample.market_caps.length : 0,
        totalVolumes: Array.isArray(sample.total_volumes) ? sample.total_volumes.length : 0
      }
    });
  } catch (error) {
    res.status(error.status || 400).json({ ok: false, message: error.message });
  }
});

router.post('/assets/new', async (req, res) => {
  let newAsset = null;

  try {
    requireMaintenanceDisabled(req, 'Maintenance mode is active; new asset validation and optional backfill are paused.');
    const { payload } = readEditableAssetConfig(req);
    newAsset = normalizeNewAssetForm(req.body, payload.assets);
    await validateCoinGeckoId(newAsset.coingeckoId);

    payload.assets.push(newAsset);
    const change = saveAdminConfigChange(req, 'config/assets.json', payload, `Add asset ${newAsset.id}`);
    hotReloadConfigFile(req, 'config/assets.json', payload);

    const details = { changeId: change.id, backupPath: change.backupPath, filePath: 'config/assets.json' };

    if (req.body.initialBackfill === 'on' || req.body.initialBackfill === 'true') {
      const result = enqueueBackfill(getDatabase(req), getScheduler(req), newAsset.id, buildInitialBackfillRequest(newAsset, req.body));
      details.initialBackfill = {
        projectedCalls: result.projectedCalls,
        jobCount: result.enqueuedJobs.length,
        interval: result.request.interval,
        fromIso: result.request.fromIso,
        toIso: result.request.toIso
      };
    }

    recordAdminEvent(req, { action: 'config edit', entityType: 'asset', entityId: newAsset.id, details });
    const params = new URLSearchParams({
      alert: 'success',
      message: `Added ${newAsset.symbol}. Backup: ${change.backupPath}`
    });
    res.redirect(`/admin/assets/${encodeURIComponent(newAsset.id)}?${params.toString()}`);
  } catch (error) {
    const params = new URLSearchParams({
      alert: 'danger',
      message: error.message
    });
    res.redirect(`/admin/assets/new?${params.toString()}`);
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
    const staleness = getAssetStaleness(db, asset, { jobScheduler: getScheduler(req), config: req.app.get('config') });

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
      rateBudget: getGlobalRateBudgetService().buildSnapshot({ scheduler: getScheduler(req), assets: getConfiguredAssets(req) }),
      alert: req.query.alert || null,
      message: req.query.message || null
    });
  } catch (error) {
    next(error);
  }
});

router.post('/portable-bundle/create', (req, res, next) => {
  try {
    const result = createPortableBundle({ rootDir: process.cwd(), env: process.env });
    recordAdminEvent(req, {
      action: 'portable bundle created',
      entityType: 'backup',
      entityId: result.archiveName,
      details: {
        fileName: result.archiveName,
        path: result.relativeArchivePath,
        sizeBytes: result.sizeBytes,
        databaseSource: result.database.source
      }
    });
    redirectWithBundleAction(res, 'created', `${result.relativeArchivePath} (${bytesToSummary(result.sizeBytes)})`);
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
      bundleAction: req.query.bundleAction || null,
      bundleDetails: req.query.bundleDetails || null,
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
