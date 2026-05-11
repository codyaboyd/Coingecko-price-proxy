const express = require('express');

const { getAssetCandleBounds, getPublicAsset, listFetchRunsForAsset } = require('../db/queries');
const { loadAssets } = require('../services/asset-service');
const { resolveFromRoot } = require('../utils/files');
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
