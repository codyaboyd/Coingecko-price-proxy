const express = require('express');
const fs = require('fs');
const path = require('path');

const { getAssetCandleBounds, getPublicAsset, listFetchRunsForAsset } = require('../db/queries');
const { loadAssets } = require('../services/asset-service');
const { CONFLICT_POLICIES, DEFAULT_CONFLICT_POLICY, SUPPORTED_INTERVALS } = require('../services/history-service');
const { convertDumpFile, importNormalizedHistoryFile, previewNormalizedHistoryFile } = require('../services/import-service');
const { ensureDirectory, resolveFromRoot } = require('../utils/files');
const { createScheduler } = require('../jobs/scheduler');
const { createRecentRefreshScheduler } = require('../jobs/recent-refresh-scheduler');

const router = express.Router();


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

function resolveImportFile(req, fileName) {
  if (!fileName) {
    return null;
  }

  const importsDir = getImportsDirectory(req);
  const resolved = path.resolve(importsDir, fileName);

  if (resolved !== importsDir && !resolved.startsWith(`${importsDir}${path.sep}`)) {
    const error = new Error('Import file must be inside data/imports.');
    error.status = 400;
    throw error;
  }

  return resolved;
}

function looksLikeNormalizedFile(filePath) {
  return filePath && filePath.toLowerCase().endsWith('.normalized.json');
}

function buildConvertedPath(req, sourcePath, assetId) {
  const config = req.app.get('config');
  const convertedDir = path.join(config.dataDir, 'imports', 'converted');
  ensureDirectory(convertedDir);
  const parsed = path.parse(sourcePath);
  const safeAsset = String(assetId || 'asset').replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  return resolveFromRoot(path.join(convertedDir, `${safeAsset}-${parsed.name}.normalized.json`));
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
    scheduler = createScheduler({ db: getDatabase(req) });
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
    const interval = req.body.interval || '1d';
    const policy = req.body.policy || DEFAULT_CONFLICT_POLICY;
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
