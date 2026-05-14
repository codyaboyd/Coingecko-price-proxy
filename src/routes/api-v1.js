const express = require('express');

const { getPublicAsset, listPublicAssets } = require('../db/queries');
const { getHistory, SUPPORTED_INTERVALS } = require('../services/history-service');
const { getGapReport } = require('../services/cache-policy');
const { enqueueBackfill } = require('../jobs/backfill-job');
const { createScheduler } = require('../jobs/scheduler');
const { assertTimestampRange, DAY_MS, parseDateInput } = require('../utils/date');
const { buildSystemHealth } = require('../services/system-health');
const { getAssetStaleness } = require('../services/staleness-service');
const { getGlobalRateBudgetService } = require('../services/rate-budget-service');
const { recordAdminEvent } = require('../services/admin-activity-service');
const { buildOpenApiDocument } = require('../services/api-docs');
const { createMaintenanceError, isMaintenanceMode } = require('../services/maintenance-service');
const {
  buildHistoryCacheKey,
  getCachedResponse,
  getHistoryCacheTtl,
  isCacheBypassed,
  setCachedResponse
} = require('../services/api-cache');

const router = express.Router();

const DEFAULT_INTERVAL = '1d';
const DEFAULT_SOURCE = 'local';
const DEFAULT_FORMAT = 'json';
const DEFAULT_FILL = 'none';
const DEFAULT_HISTORY_LIMIT = 1000;
const MAX_HISTORY_LIMIT = 5000;
const MAX_RANGE_MS_BY_INTERVAL = {
  '5m': 31 * DAY_MS,
  '1h': 2 * 366 * DAY_MS,
  '1d': 20 * 366 * DAY_MS
};
const INTERVAL_DURATIONS = {
  '5m': 5 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000
};

function requireMaintenanceDisabled(req, message) {
  if (isMaintenanceMode(req.app.get('config'))) {
    throw createMaintenanceError(message);
  }
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


function getConfiguredAssetForStaleness(req, asset) {
  const configuredAssets = req.app.get('assets');

  if (!Array.isArray(configuredAssets)) {
    return asset;
  }

  const configuredAsset = configuredAssets.find((candidate) => candidate.id === asset.id);
  return configuredAsset ? { ...asset, ...configuredAsset } : asset;
}

function getScheduler(req) {
  let scheduler = req.app.get('jobScheduler');

  if (!scheduler) {
    scheduler = createScheduler({ db: getDatabase(req) });
    req.app.set('jobScheduler', scheduler);
  }

  return scheduler;
}

function createApiError(status, code, message, details) {
  const error = new Error(message);
  error.status = status;
  error.code = code;

  if (details) {
    error.details = details;
  }

  return error;
}

function createNotFoundError(assetId) {
  return createApiError(404, 'asset_not_found', `Asset '${assetId}' was not found.`);
}

function normalizeChoice(value, defaultValue, allowedValues, field) {
  const normalized = String(value || defaultValue).trim().toLowerCase();

  if (!allowedValues.includes(normalized)) {
    throw createApiError(
      400,
      `invalid_${field}`,
      `${field} must be one of: ${allowedValues.join(', ')}.`
    );
  }

  return normalized;
}

function parseTimestamp(value, field) {
  try {
    return parseDateInput(value, field);
  } catch (error) {
    throw createApiError(400, error.code || `invalid_${field}`, error.message);
  }
}


function parseGapTimestamp(value, field) {
  try {
    return parseDateInput(value, field, { endOfDay: false });
  } catch (error) {
    throw createApiError(400, error.code || `invalid_${field}`, error.message);
  }
}


function parseRequiredGapTimestamp(value, field) {
  const timestamp = parseGapTimestamp(value, field);

  if (timestamp === null) {
    throw createApiError(400, `missing_${field}`, `${field} is required.`);
  }

  return timestamp;
}

function parseLimit(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return DEFAULT_HISTORY_LIMIT;
  }

  const limit = Number(value);

  if (!Number.isInteger(limit) || limit < 1) {
    throw createApiError(400, 'invalid_limit', 'limit must be a positive integer.');
  }

  if (limit > MAX_HISTORY_LIMIT) {
    throw createApiError(400, 'limit_too_large', `limit must be less than or equal to ${MAX_HISTORY_LIMIT}.`);
  }

  return limit;
}

function validateRange(fromTs, toTs, interval) {
  try {
    assertTimestampRange(fromTs, toTs, {
      maxSpanMs: interval ? MAX_RANGE_MS_BY_INTERVAL[interval] : null,
      maxSpanMessage: interval ? `Date range is too large for interval ${interval}.` : null
    });
  } catch (error) {
    throw createApiError(400, error.code || 'invalid_range', error.message, fromTs !== null && toTs !== null ? {
      from: new Date(fromTs).toISOString(),
      to: new Date(toTs).toISOString()
    } : undefined);
  }
}

function getEffectiveRange(candles, fromTs, toTs) {
  const timestamps = candles.map((candle) => candle.ts);

  return {
    from: fromTs !== null ? fromTs : (timestamps.length > 0 ? timestamps[0] : null),
    to: toTs !== null ? toTs : (timestamps.length > 0 ? timestamps[timestamps.length - 1] : null)
  };
}

function clonePreviousCandle(previousCandle, timestamp) {
  return {
    assetId: previousCandle.assetId,
    vsCurrency: previousCandle.vsCurrency,
    interval: previousCandle.interval,
    ts: timestamp,
    open: previousCandle.close,
    high: previousCandle.close,
    low: previousCandle.close,
    close: previousCandle.close,
    volume: null,
    marketCap: null,
    fetchedAt: null
  };
}

function fillWithPrevious(candles, options) {
  const { assetId, db, fromTs, toTs, interval, limit, vsCurrency } = options;
  const effectiveRange = getEffectiveRange(candles, fromTs, toTs);

  if (effectiveRange.from === null || effectiveRange.to === null) {
    return candles;
  }

  const stepMs = INTERVAL_DURATIONS[interval];
  const candleByTimestamp = new Map(candles.map((candle) => [candle.ts, candle]));
  const previousCandles = fromTs === null
    ? []
    : getHistory(assetId, {
      db,
      vsCurrency,
      interval,
      toTs: fromTs - 1,
      order: 'desc',
      limit: 1
    });
  let previousCandle = previousCandles[0] || null;
  const filled = [];

  for (let timestamp = effectiveRange.from; timestamp <= effectiveRange.to && filled.length < limit; timestamp += stepMs) {
    const candle = candleByTimestamp.get(timestamp);

    if (candle) {
      previousCandle = candle;
      filled.push(candle);
    } else if (previousCandle) {
      const filledCandle = clonePreviousCandle(previousCandle, timestamp);
      previousCandle = filledCandle;
      filled.push(filledCandle);
    }
  }

  return filled;
}

function toCsvValue(value) {
  if (value === null || value === undefined) {
    return '';
  }

  const text = String(value);

  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function toCsv(history) {
  const headers = ['assetId', 'vsCurrency', 'interval', 'ts', 'isoTime', 'open', 'high', 'low', 'close', 'volume', 'marketCap', 'fetchedAt'];
  const rows = history.candles.map((candle) => [
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
    candle.fetchedAt
  ]);

  return [headers, ...rows]
    .map((row) => row.map(toCsvValue).join(','))
    .join('\n');
}

function parseHistoryRequest(req) {
  const db = getDatabase(req);
  const asset = getPublicAsset(db, req.params.assetId);

  if (!asset) {
    throw createNotFoundError(req.params.assetId);
  }

  const interval = normalizeChoice(req.query.interval, DEFAULT_INTERVAL, Array.from(SUPPORTED_INTERVALS), 'interval');
  const source = normalizeChoice(req.query.source, DEFAULT_SOURCE, [DEFAULT_SOURCE], 'source');
  const format = normalizeChoice(req.query.format, DEFAULT_FORMAT, ['json', 'csv'], 'format');
  const fill = normalizeChoice(req.query.fill, DEFAULT_FILL, ['none', 'previous'], 'fill');
  const vsCurrency = String(req.query.vs || asset.vsCurrency).trim().toLowerCase();
  const fromTs = parseTimestamp(req.query.from, 'from');
  const toTs = parseTimestamp(req.query.to, 'to');
  const limit = parseLimit(req.query.limit);

  if (!/^[a-z0-9_-]{2,20}$/.test(vsCurrency)) {
    throw createApiError(400, 'invalid_vs', 'vs must be a 2-20 character currency code.');
  }

  validateRange(fromTs, toTs, interval);

  return {
    asset,
    db,
    interval,
    source,
    format,
    fill,
    vsCurrency,
    fromTs,
    toTs,
    limit,
    cacheKey: buildHistoryCacheKey({
      assetId: asset.id,
      from: fromTs,
      to: toTs,
      interval,
      vs: vsCurrency,
      fill,
      format,
      limit
    })
  };
}

function buildHistoryResponse(request) {
  let candles = getHistory(request.asset.id, {
    db: request.db,
    fromTs: request.fromTs,
    toTs: request.toTs,
    interval: request.interval,
    limit: request.limit,
    vsCurrency: request.vsCurrency
  });

  if (request.fill === 'previous') {
    candles = fillWithPrevious(candles, {
      assetId: request.asset.id,
      db: request.db,
      fromTs: request.fromTs,
      toTs: request.toTs,
      interval: request.interval,
      limit: request.limit,
      vsCurrency: request.vsCurrency
    });
  }

  const effectiveRange = getEffectiveRange(candles, request.fromTs, request.toTs);

  return {
    history: {
      asset: request.asset,
      vsCurrency: request.vsCurrency,
      interval: request.interval,
      from: effectiveRange.from,
      to: effectiveRange.to,
      source: request.source,
      count: candles.length,
      candles
    },
    format: request.format
  };
}

function sendHistoryResponse(res, payload) {
  if (payload.format === 'csv') {
    res.type('text/csv');
    res.set('Content-Disposition', `attachment; filename="${payload.history.asset.id}-${payload.history.interval}-history.csv"`);
    res.send(payload.body || toCsv(payload.history));
    return;
  }

  res.json(payload.history);
}


router.get('/openapi.json', (req, res, next) => {
  try {
    res.json(buildOpenApiDocument({ assets: listPublicAssets(getDatabase(req)) }));
  } catch (error) {
    next(error);
  }
});

router.get('/admin/rate-budget', (req, res, next) => {
  try {
    const scheduler = getScheduler(req);
    const assets = req.app.get('assets') || [];
    res.json({ budget: getGlobalRateBudgetService().buildSnapshot({ scheduler, assets }) });
  } catch (error) {
    next(error);
  }
});

router.get('/admin/system-health', (req, res, next) => {
  try {
    res.json(buildSystemHealth(req.app));
  } catch (error) {
    next(error);
  }
});

router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'chrono-cache',
    apiVersion: 'v1',
    timestamp: new Date().toISOString()
  });
});

router.get('/assets', (req, res) => {
  const assets = listPublicAssets(getDatabase(req));

  res.json({ assets });
});

router.get('/assets/:assetId', (req, res, next) => {
  try {
    const asset = getPublicAsset(getDatabase(req), req.params.assetId);

    if (!asset) {
      next(createNotFoundError(req.params.assetId));
      return;
    }

    res.json({ asset });
  } catch (error) {
    next(error);
  }
});


router.get('/admin/assets/:assetId/staleness', (req, res, next) => {
  try {
    const db = getDatabase(req);
    const asset = getPublicAsset(db, req.params.assetId);

    if (!asset) {
      next(createNotFoundError(req.params.assetId));
      return;
    }

    res.json({
      asset: { id: asset.id, symbol: asset.symbol, vsCurrency: asset.vsCurrency },
      staleness: getAssetStaleness(db, getConfiguredAssetForStaleness(req, asset), { jobScheduler: getScheduler(req), config: req.app.get('config') })
    });
  } catch (error) {
    next(error);
  }
});

router.get('/admin/assets/:assetId/gaps', (req, res, next) => {
  try {
    const db = getDatabase(req);
    const asset = getPublicAsset(db, req.params.assetId);

    if (!asset) {
      next(createNotFoundError(req.params.assetId));
      return;
    }

    const interval = normalizeChoice(req.query.interval, DEFAULT_INTERVAL, Array.from(SUPPORTED_INTERVALS), 'interval');
    const vsCurrency = String(req.query.vsCurrency || req.query.vs || asset.vsCurrency).trim().toLowerCase();
    const fromTs = parseRequiredGapTimestamp(req.query.from, 'from');
    const toTs = parseRequiredGapTimestamp(req.query.to, 'to');

    if (!vsCurrency) {
      throw createApiError(400, 'invalid_vsCurrency', 'vsCurrency must be a non-empty currency code.');
    }

    validateRange(fromTs, toTs, interval);

    const gapReport = getGapReport(asset.id, vsCurrency, interval, fromTs, toTs, { db });

    res.json({
      ...gapReport,
      gapReport
    });
  } catch (error) {
    next(error);
  }
});

router.post('/admin/assets/:assetId/fetch', (req, res, next) => {
  try {
    requireMaintenanceDisabled(req, 'Maintenance mode is active; CoinGecko fetch jobs are paused.');
    const db = getDatabase(req);
    const asset = getPublicAsset(db, req.params.assetId);

    if (!asset) {
      next(createNotFoundError(req.params.assetId));
      return;
    }

    const scheduler = getScheduler(req);
    const job = scheduler.enqueue('manual_admin_fetch', {
      assetId: asset.id,
      from: req.body.from,
      to: req.body.to,
      interval: req.body.interval,
      vsCurrency: req.body.vsCurrency,
      conflictPolicy: req.body.conflictPolicy
    });
    recordAdminEvent(req, {
      action: 'manual fetch',
      entityType: 'asset',
      entityId: asset.id,
      details: { jobId: job.id, from: req.body.from, to: req.body.to, interval: req.body.interval, vsCurrency: req.body.vsCurrency, conflictPolicy: req.body.conflictPolicy }
    });

    res.status(202).json({ job, queue: scheduler.getStatus() });
  } catch (error) {
    next(error);
  }
});


router.post('/admin/assets/:assetId/backfill/plan', (req, res, next) => {
  try {
    requireMaintenanceDisabled(req, 'Maintenance mode is active; CoinGecko backfill jobs are paused.');
    const scheduler = getScheduler(req);
    const result = enqueueBackfill(getDatabase(req), scheduler, req.params.assetId, req.body, { dryRun: true });
    const budget = getGlobalRateBudgetService().buildSnapshot({ scheduler, assets: req.app.get('assets') || [] });

    res.json({
      asset: result.asset,
      request: result.request,
      gaps: result.gaps,
      chunks: result.chunks,
      projectedCalls: result.projectedCalls,
      budget,
      warning: result.projectedCalls > budget.safeRemainingCalls || result.projectedCalls >= 10
    });
  } catch (error) {
    next(error);
  }
});

router.post('/admin/assets/:assetId/backfill', (req, res, next) => {
  try {
    requireMaintenanceDisabled(req, 'Maintenance mode is active; CoinGecko backfill jobs are paused.');
    const result = enqueueBackfill(getDatabase(req), getScheduler(req), req.params.assetId, req.body);
    recordAdminEvent(req, {
      action: 'backfill request',
      entityType: 'asset',
      entityId: req.params.assetId,
      details: { request: result.request, gapCount: result.gaps.length, chunkCount: result.chunks.length, projectedCalls: result.projectedCalls, jobs: result.enqueuedJobs.map((job) => job.id) }
    });

    res.status(202).json({
      asset: result.asset,
      request: result.request,
      gaps: result.gaps,
      chunks: result.chunks,
      projectedCalls: result.projectedCalls,
      enqueuedJobs: result.enqueuedJobs,
      queue: getScheduler(req).getStatus()
    });
  } catch (error) {
    next(error);
  }
});

router.get('/history/:assetId', (req, res, next) => {
  try {
    const request = parseHistoryRequest(req);
    const ttlMs = getHistoryCacheTtl(request.interval);
    const bypassCache = isCacheBypassed(req.query.cache);

    if (!bypassCache && ttlMs > 0) {
      const cached = getCachedResponse(request.db, request.cacheKey);

      if (cached) {
        res.status(cached.statusCode);
        res.set('X-API-Cache', 'HIT');
        sendHistoryResponse(res, JSON.parse(cached.responseJson));
        return;
      }
    }

    const payload = buildHistoryResponse(request);

    if (!bypassCache && ttlMs > 0) {
      const cachePayload = {
        ...payload,
        body: payload.format === 'csv' ? toCsv(payload.history) : null
      };
      setCachedResponse(request.db, request.cacheKey, JSON.stringify(cachePayload), ttlMs);
      res.set('X-API-Cache', 'MISS');
      sendHistoryResponse(res, cachePayload);
      return;
    }

    res.set('X-API-Cache', 'BYPASS');
    sendHistoryResponse(res, payload);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
