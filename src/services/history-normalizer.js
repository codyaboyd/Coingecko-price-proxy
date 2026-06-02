const INTERVAL_MS = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeInterval(interval) {
  if (typeof interval !== 'string') {
    throw new Error('interval must be one of: 1m, 5m, 1h, 1d.');
  }

  const normalized = interval.trim().toLowerCase();

  if (!Object.prototype.hasOwnProperty.call(INTERVAL_MS, normalized)) {
    throw new Error('interval must be one of: 1m, 5m, 1h, 1d.');
  }

  return normalized;
}

function normalizeOptionalString(value, field) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string.`);
  }

  const normalized = value.trim().toLowerCase();

  if (!normalized) {
    return null;
  }

  return normalized;
}

function normalizePointTuple(point, field, index) {
  if (!Array.isArray(point) || point.length < 2) {
    throw new Error(`${field}[${index}] must be a [timestamp, value] tuple.`);
  }

  const timestamp = Number(point[0]);
  const value = Number(point[1]);

  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new Error(`${field}[${index}][0] must be a non-negative timestamp in milliseconds.`);
  }

  if (!Number.isFinite(value)) {
    throw new Error(`${field}[${index}][1] must be a finite number.`);
  }

  return {
    ts: Math.floor(timestamp),
    value
  };
}

function normalizePointSeries(response, field) {
  const series = response[field];

  if (series === undefined || series === null) {
    return [];
  }

  if (!Array.isArray(series)) {
    throw new Error(`${field} must be an array of [timestamp, value] tuples.`);
  }

  return series
    .map((point, index) => normalizePointTuple(point, field, index))
    .sort((left, right) => left.ts - right.ts);
}

function getBucketStart(timestamp, intervalMs) {
  return Math.floor(timestamp / intervalMs) * intervalMs;
}

function buildBucketValues(points, intervalMs) {
  const valuesByBucket = new Map();

  points.forEach((point) => {
    valuesByBucket.set(getBucketStart(point.ts, intervalMs), point.value);
  });

  return valuesByBucket;
}

function createBaseCandle(bucketTs, firstPrice, options) {
  const candle = {
    ts: bucketTs,
    open: firstPrice,
    high: firstPrice,
    low: firstPrice,
    close: firstPrice,
    volume: null,
    marketCap: null,
    source: 'coingecko',
    quality: 'derived'
  };

  if (options.assetId) {
    candle.assetId = options.assetId;
  }

  if (options.vsCurrency) {
    candle.vsCurrency = options.vsCurrency;
  }

  if (options.interval) {
    candle.interval = options.interval;
  }

  return candle;
}

function normalizeMarketChartRange(response, options = {}) {
  if (!isPlainObject(response)) {
    throw new Error('response must be an object.');
  }

  const interval = normalizeInterval(options.interval || '1d');
  const intervalMs = INTERVAL_MS[interval];
  const normalizedOptions = {
    assetId: normalizeOptionalString(options.assetId, 'assetId'),
    vsCurrency: normalizeOptionalString(options.vsCurrency, 'vsCurrency'),
    interval
  };
  const prices = normalizePointSeries(response, 'prices');
  const marketCapsByBucket = buildBucketValues(normalizePointSeries(response, 'market_caps'), intervalMs);
  const volumesByBucket = buildBucketValues(normalizePointSeries(response, 'total_volumes'), intervalMs);
  const candlesByBucket = new Map();

  prices.forEach((point) => {
    const bucketTs = getBucketStart(point.ts, intervalMs);
    const existing = candlesByBucket.get(bucketTs);

    if (!existing) {
      candlesByBucket.set(bucketTs, createBaseCandle(bucketTs, point.value, normalizedOptions));
      return;
    }

    existing.high = Math.max(existing.high, point.value);
    existing.low = Math.min(existing.low, point.value);
    existing.close = point.value;
  });

  return Array.from(candlesByBucket.values())
    .sort((left, right) => left.ts - right.ts)
    .map((candle) => ({
      ...candle,
      volume: volumesByBucket.has(candle.ts) ? volumesByBucket.get(candle.ts) : null,
      marketCap: marketCapsByBucket.has(candle.ts) ? marketCapsByBucket.get(candle.ts) : null
    }));
}

module.exports = {
  INTERVAL_MS,
  normalizeMarketChartRange
};
