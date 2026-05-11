const { openDatabase } = require('../db/node-sqlite');
const { loadServerConfig } = require('../utils/config');

const SUPPORTED_INTERVALS = new Set(['5m', '1h', '1d']);
const INTERVAL_STEPS_MS = {
  '5m': 5 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000
};

let defaultDb;

function getDefaultDatabase() {
  if (!defaultDb) {
    const config = loadServerConfig();
    defaultDb = openDatabase(config.databasePath);
  }

  return defaultDb;
}

function getDatabase(options = {}) {
  return options.db || getDefaultDatabase();
}

function normalizeRequiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string.`);
  }

  return value.trim().toLowerCase();
}

function normalizeInterval(interval) {
  const normalized = normalizeRequiredString(interval, 'interval');

  if (!SUPPORTED_INTERVALS.has(normalized)) {
    throw new Error(`interval must be one of: ${Array.from(SUPPORTED_INTERVALS).join(', ')}.`);
  }

  return normalized;
}

function normalizeTimestamp(value, field) {
  const timestamp = Number(value);

  if (!Number.isSafeInteger(timestamp)) {
    throw new Error(`${field} must be a safe millisecond timestamp.`);
  }

  return timestamp;
}

function floorToUtcBoundary(interval, timestamp) {
  const normalizedInterval = normalizeInterval(interval);
  const normalizedTimestamp = normalizeTimestamp(timestamp, 'timestamp');
  const stepMs = INTERVAL_STEPS_MS[normalizedInterval];

  return Math.floor(normalizedTimestamp / stepMs) * stepMs;
}

function getExpectedCount(interval, fromMs, toMs) {
  const normalizedInterval = normalizeInterval(interval);
  const fromBoundary = floorToUtcBoundary(normalizedInterval, fromMs);
  const toBoundary = floorToUtcBoundary(normalizedInterval, toMs);

  if (toBoundary < fromBoundary) {
    return 0;
  }

  return Math.floor((toBoundary - fromBoundary) / INTERVAL_STEPS_MS[normalizedInterval]) + 1;
}

function* getExpectedTimestamps(interval, fromMs, toMs) {
  const normalizedInterval = normalizeInterval(interval);
  const stepMs = INTERVAL_STEPS_MS[normalizedInterval];
  const fromBoundary = floorToUtcBoundary(normalizedInterval, fromMs);
  const toBoundary = floorToUtcBoundary(normalizedInterval, toMs);

  for (let timestamp = fromBoundary; timestamp <= toBoundary; timestamp += stepMs) {
    yield timestamp;
  }
}

function toGapRange(startTs, endTs, count) {
  return {
    from: startTs,
    to: endTs,
    fromIso: new Date(startTs).toISOString(),
    toIso: new Date(endTs).toISOString(),
    count
  };
}

function getStoredTimestamps(db, assetId, vsCurrency, interval, fromBoundary, toBoundary, stepMs) {
  return db
    .prepare(`
      SELECT ts
      FROM candles
      WHERE asset_id = @assetId
        AND vs_currency = @vsCurrency
        AND interval = @interval
        AND ts >= @fromBoundary
        AND ts <= @toBoundary
        AND (ts % @stepMs) = 0
      ORDER BY ts ASC
    `)
    .iterate({ assetId, vsCurrency, interval, fromBoundary, toBoundary, stepMs });
}

function buildGapReport(assetId, vsCurrency, interval, fromMs, toMs, options = {}) {
  const normalizedAssetId = normalizeRequiredString(assetId, 'assetId');
  const normalizedVsCurrency = normalizeRequiredString(vsCurrency, 'vsCurrency');
  const normalizedInterval = normalizeInterval(interval);
  const fromTs = normalizeTimestamp(fromMs, 'fromMs');
  const toTs = normalizeTimestamp(toMs, 'toMs');

  if (toTs < fromTs) {
    throw new Error('fromMs must be less than or equal to toMs.');
  }

  const db = getDatabase(options);
  const stepMs = INTERVAL_STEPS_MS[normalizedInterval];
  const fromBoundary = floorToUtcBoundary(normalizedInterval, fromTs);
  const toBoundary = floorToUtcBoundary(normalizedInterval, toTs);
  const expectedCount = getExpectedCount(normalizedInterval, fromBoundary, toBoundary);
  const storedRows = getStoredTimestamps(
    db,
    normalizedAssetId,
    normalizedVsCurrency,
    normalizedInterval,
    fromBoundary,
    toBoundary,
    stepMs
  );
  const storedIterator = storedRows[Symbol.iterator]();
  let storedResult = storedIterator.next();
  let foundCount = 0;
  const gaps = [];
  let currentGapStart = null;
  let currentGapEnd = null;
  let currentGapCount = 0;

  function closeGap() {
    if (currentGapStart === null) {
      return;
    }

    gaps.push(toGapRange(currentGapStart, currentGapEnd, currentGapCount));
    currentGapStart = null;
    currentGapEnd = null;
    currentGapCount = 0;
  }

  for (const expectedTs of getExpectedTimestamps(normalizedInterval, fromBoundary, toBoundary)) {
    while (!storedResult.done && storedResult.value.ts < expectedTs) {
      storedResult = storedIterator.next();
    }

    if (!storedResult.done && storedResult.value.ts === expectedTs) {
      foundCount += 1;
      closeGap();
      storedResult = storedIterator.next();
      continue;
    }

    if (currentGapStart === null) {
      currentGapStart = expectedTs;
    }

    currentGapEnd = expectedTs;
    currentGapCount += 1;
  }

  closeGap();

  return {
    assetId: normalizedAssetId,
    vsCurrency: normalizedVsCurrency,
    interval: normalizedInterval,
    from: fromBoundary,
    to: toBoundary,
    fromIso: new Date(fromBoundary).toISOString(),
    toIso: new Date(toBoundary).toISOString(),
    expectedCount,
    foundCount,
    missingCount: expectedCount - foundCount,
    gaps
  };
}

function getMissingWindows(assetId, vsCurrency, interval, fromMs, toMs, options = {}) {
  return buildGapReport(assetId, vsCurrency, interval, fromMs, toMs, options).gaps;
}

function getGapReport(assetId, vsCurrency, interval, fromMs, toMs, options = {}) {
  return buildGapReport(assetId, vsCurrency, interval, fromMs, toMs, options);
}

module.exports = {
  INTERVAL_STEPS_MS,
  floorToUtcBoundary,
  getExpectedTimestamps,
  getGapReport,
  getMissingWindows
};
