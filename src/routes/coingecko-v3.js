const express = require('express');

const { listPublicAssets } = require('../db/queries');
const { getHistory, SUPPORTED_INTERVALS } = require('../services/history-service');
const { DAY_MS, parseDateInput } = require('../utils/date');

const router = express.Router();

const COINGECKO_INTERVALS = {
  '1m': '1m',
  minutely: '1m',
  '5m': '5m',
  hourly: '1h',
  daily: '1d'
};
const SIMPLE_PRICE_INTERVALS = ['1m', '5m', '1h', '1d'];
const DEFAULT_RANGE_LIMIT = 5000;
const MAX_RANGE_LIMIT = 5000;

function getDatabase(req) {
  const db = req.app.get('db');

  if (!db) {
    const error = new Error('Database connection is not available.');
    error.status = 503;
    throw error;
  }

  return db;
}

function createCoinGeckoError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.code = 'coingecko_compatible_error';
  error.exposeAsCoinGecko = true;
  return error;
}

function normalizeCsv(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw createCoinGeckoError(400, `${field} is required`);
  }

  return value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function isTruthyQueryValue(value) {
  return value === true || String(value).trim().toLowerCase() === 'true';
}

function getAssetsByCoinGeckoId(req) {
  const assets = listPublicAssets(getDatabase(req));
  const byId = new Map();

  assets.forEach((asset) => {
    if (asset.coingeckoId) {
      byId.set(asset.coingeckoId.toLowerCase(), asset);
    }

    byId.set(asset.id.toLowerCase(), asset);
  });

  return byId;
}

function getAssetByCoinGeckoId(req, coingeckoId) {
  const asset = getAssetsByCoinGeckoId(req).get(String(coingeckoId || '').trim().toLowerCase());

  if (!asset) {
    throw createCoinGeckoError(404, `Could not find coin with the given id ${coingeckoId}`);
  }

  return asset;
}

function parseUnixOrDateInput(value, field) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw createCoinGeckoError(400, `${field} is required`);
  }

  const text = String(value).trim();
  const numeric = Number(text);

  if (Number.isFinite(numeric)) {
    return Math.floor(numeric * 1000);
  }

  try {
    const timestamp = parseDateInput(text, field, { endOfDay: field === 'to' });

    if (timestamp === null) {
      throw new Error(`${field} is required`);
    }

    return timestamp;
  } catch (error) {
    throw createCoinGeckoError(400, error.message);
  }
}

function parseDays(days) {
  if (days === undefined || days === null || String(days).trim() === '') {
    throw createCoinGeckoError(400, 'days is required');
  }

  const normalized = String(days).trim().toLowerCase();

  if (normalized === 'max') {
    return { fromTs: null, toTs: null };
  }

  const numeric = Number(normalized);

  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw createCoinGeckoError(400, 'days must be a positive number or max');
  }

  const toTs = Date.now();
  return {
    fromTs: Math.floor(toTs - (numeric * DAY_MS)),
    toTs
  };
}

function normalizeCoinGeckoInterval(value, spanMs) {
  if (value !== undefined && value !== null && String(value).trim() !== '') {
    const normalized = String(value).trim().toLowerCase();
    const interval = COINGECKO_INTERVALS[normalized];

    if (!interval || !SUPPORTED_INTERVALS.has(interval)) {
      throw createCoinGeckoError(400, 'interval must be one of: 1m, minutely, 5m, hourly, daily');
    }

    return interval;
  }

  if (spanMs !== null && spanMs <= DAY_MS) {
    return '5m';
  }

  if (spanMs !== null && spanMs <= 90 * DAY_MS) {
    return '1h';
  }

  return '1d';
}

function normalizePrecision(value) {
  if (value === undefined || value === null || String(value).trim() === '' || String(value).trim().toLowerCase() === 'full') {
    return null;
  }

  const precision = Number(value);

  if (!Number.isInteger(precision) || precision < 0 || precision > 18) {
    throw createCoinGeckoError(400, 'precision must be full or an integer from 0 to 18');
  }

  return precision;
}

function applyPrecision(value, precision) {
  if (value === null || value === undefined || precision === null) {
    return value;
  }

  return Number(value.toFixed(precision));
}

function candlesToMarketChart(candles, precision = null) {
  return {
    prices: candles.map((candle) => [candle.ts, applyPrecision(candle.close, precision)]),
    market_caps: candles.map((candle) => [candle.ts, applyPrecision(candle.marketCap, precision)]),
    total_volumes: candles.map((candle) => [candle.ts, applyPrecision(candle.volume, precision)])
  };
}

function getRangeHistory(req, asset, options) {
  const candles = getHistory(asset.id, {
    db: getDatabase(req),
    vsCurrency: options.vsCurrency,
    interval: options.interval,
    fromTs: options.fromTs,
    toTs: options.toTs,
    limit: options.limit || DEFAULT_RANGE_LIMIT
  });

  return candlesToMarketChart(candles, options.precision);
}

function findLatestCandle(req, asset, vsCurrency) {
  for (const interval of SIMPLE_PRICE_INTERVALS) {
    const candles = getHistory(asset.id, {
      db: getDatabase(req),
      vsCurrency,
      interval,
      order: 'desc',
      limit: 1
    });

    if (candles.length > 0) {
      return candles[0];
    }
  }

  return null;
}

router.get('/ping', (req, res) => {
  res.json({ gecko_says: '(V3) To the Moon!' });
});

router.get('/simple/price', (req, res, next) => {
  try {
    const ids = normalizeCsv(req.query.ids, 'ids');
    const vsCurrencies = normalizeCsv(req.query.vs_currencies, 'vs_currencies');
    const includeMarketCap = isTruthyQueryValue(req.query.include_market_cap);
    const includeVolume = isTruthyQueryValue(req.query.include_24hr_vol);
    const includeLastUpdated = isTruthyQueryValue(req.query.include_last_updated_at);
    const precision = normalizePrecision(req.query.precision);
    const assetsByCoinGeckoId = getAssetsByCoinGeckoId(req);
    const response = {};

    ids.forEach((id) => {
      const asset = assetsByCoinGeckoId.get(id);

      if (!asset) {
        return;
      }

      response[id] = {};

      vsCurrencies.forEach((vsCurrency) => {
        const candle = findLatestCandle(req, asset, vsCurrency);

        if (!candle) {
          return;
        }

        response[id][vsCurrency] = applyPrecision(candle.close, precision);

        if (includeMarketCap) {
          response[id][`${vsCurrency}_market_cap`] = applyPrecision(candle.marketCap, precision);
        }

        if (includeVolume) {
          response[id][`${vsCurrency}_24h_vol`] = applyPrecision(candle.volume, precision);
        }

        if (includeLastUpdated) {
          response[id].last_updated_at = Math.floor(candle.ts / 1000);
        }
      });
    });

    res.json(response);
  } catch (error) {
    next(error);
  }
});

router.get('/coins/:id/market_chart/range', (req, res, next) => {
  try {
    const asset = getAssetByCoinGeckoId(req, req.params.id);
    const vsCurrency = String(req.query.vs_currency || asset.vsCurrency).trim().toLowerCase();
    const fromTs = parseUnixOrDateInput(req.query.from, 'from');
    const toTs = parseUnixOrDateInput(req.query.to, 'to');
    const spanMs = toTs - fromTs;
    const interval = normalizeCoinGeckoInterval(req.query.interval, spanMs);
    const precision = normalizePrecision(req.query.precision);

    if (spanMs < 0) {
      throw createCoinGeckoError(400, 'from must be before to');
    }

    res.json(getRangeHistory(req, asset, { vsCurrency, interval, fromTs, toTs, precision, limit: MAX_RANGE_LIMIT }));
  } catch (error) {
    next(error);
  }
});

router.get('/coins/:id/market_chart', (req, res, next) => {
  try {
    const asset = getAssetByCoinGeckoId(req, req.params.id);
    const vsCurrency = String(req.query.vs_currency || asset.vsCurrency).trim().toLowerCase();
    const range = parseDays(req.query.days);
    const spanMs = range.fromTs !== null && range.toTs !== null ? range.toTs - range.fromTs : null;
    const interval = normalizeCoinGeckoInterval(req.query.interval, spanMs);
    const precision = normalizePrecision(req.query.precision);

    res.json(getRangeHistory(req, asset, { vsCurrency, interval, fromTs: range.fromTs, toTs: range.toTs, precision, limit: MAX_RANGE_LIMIT }));
  } catch (error) {
    next(error);
  }
});

router.use((error, req, res, next) => {
  if (!error.exposeAsCoinGecko) {
    next(error);
    return;
  }

  res.status(error.status || 500).json({ error: error.message });
});

module.exports = router;
