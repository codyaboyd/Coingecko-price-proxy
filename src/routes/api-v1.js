const express = require('express');

const { getPublicAsset, listPublicAssets } = require('../db/queries');
const { getHistory, SUPPORTED_INTERVALS } = require('../services/history-service');

const router = express.Router();

const DEFAULT_INTERVAL = '1d';
const DEFAULT_SOURCE = 'local';
const DEFAULT_FORMAT = 'json';
const DEFAULT_FILL = 'none';
const DEFAULT_HISTORY_LIMIT = 1000;
const MAX_HISTORY_LIMIT = 5000;
const INTERVAL_DURATIONS = {
  '5m': 5 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000
};

function getDatabase(req) {
  const db = req.app.get('db');

  if (!db) {
    const error = new Error('Database connection is not available.');
    error.status = 503;
    throw error;
  }

  return db;
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
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }

  const text = String(value).trim();

  if (/^-?\d+$/.test(text)) {
    const timestamp = Number(text);

    if (Number.isSafeInteger(timestamp)) {
      return timestamp;
    }

    throw createApiError(400, `invalid_${field}`, `${field} must be a safe millisecond timestamp.`);
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

  throw createApiError(
    400,
    `invalid_${field}`,
    `${field} must be a YYYY-MM-DD date, millisecond timestamp, or ISO date string.`
  );
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

function validateRange(fromTs, toTs) {
  if (fromTs !== null && toTs !== null && fromTs > toTs) {
    throw createApiError(400, 'invalid_range', 'from must be less than or equal to to.', {
      from: new Date(fromTs).toISOString(),
      to: new Date(toTs).toISOString()
    });
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

function buildHistoryResponse(req) {
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

  if (!vsCurrency) {
    throw createApiError(400, 'invalid_vs', 'vs must be a non-empty currency code.');
  }

  validateRange(fromTs, toTs);

  let candles = getHistory(asset.id, {
    db,
    fromTs,
    toTs,
    interval,
    limit,
    vsCurrency
  });

  if (fill === 'previous') {
    candles = fillWithPrevious(candles, {
      assetId: asset.id,
      db,
      fromTs,
      toTs,
      interval,
      limit,
      vsCurrency
    });
  }

  const effectiveRange = getEffectiveRange(candles, fromTs, toTs);

  return {
    history: {
      asset,
      vsCurrency,
      interval,
      from: effectiveRange.from,
      to: effectiveRange.to,
      source,
      count: candles.length,
      candles
    },
    format
  };
}

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

router.get('/history/:assetId', (req, res, next) => {
  try {
    const { history, format } = buildHistoryResponse(req);

    if (format === 'csv') {
      res.type('text/csv');
      res.set('Content-Disposition', `attachment; filename="${history.asset.id}-${history.interval}-history.csv"`);
      res.send(toCsv(history));
      return;
    }

    res.json(history);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
