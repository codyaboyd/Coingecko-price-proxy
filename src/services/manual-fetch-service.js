const { fetchMarketChartRange } = require('./coingecko');
const { normalizeMarketChartRange } = require('./history-normalizer');
const { countCandles, insertCandles, SUPPORTED_INTERVALS, CONFLICT_POLICIES } = require('./history-service');
const { createFetchRun, getPublicAsset, updateFetchRun } = require('../db/queries');
const { assertTimestampRange, DAY_MS, parseDateInput } = require('../utils/date');

const DEFAULT_INTERVAL = '1h';
const DEFAULT_CONFLICT_POLICY = 'fill_only_missing';
const DEFAULT_SOURCE = 'coingecko';
const MAX_FETCH_RANGE_MS = 366 * DAY_MS;

function createValidationError(code, message) {
  const error = new Error(message);
  error.status = 400;
  error.code = code;
  return error;
}

function createNotFoundError(assetId) {
  const error = new Error(`Asset '${assetId}' was not found.`);
  error.status = 404;
  error.code = 'asset_not_found';
  return error;
}

function normalizeRequiredDate(value, field) {
  try {
    return parseDateInput(value, field, { required: true });
  } catch (error) {
    throw createValidationError(error.code || `invalid_${field}`, error.message);
  }
}


function normalizeChoice(value, defaultValue, allowedValues, field) {
  const normalized = String(value || defaultValue).trim().toLowerCase();

  if (!allowedValues.includes(normalized)) {
    throw createValidationError(`invalid_${field}`, `${field} must be one of: ${allowedValues.join(', ')}.`);
  }

  return normalized;
}

function normalizeFetchRequest(body = {}, asset) {
  const fromTs = normalizeRequiredDate(body.from, 'from');
  const toTs = normalizeRequiredDate(body.to, 'to');
  const interval = normalizeChoice(body.interval, DEFAULT_INTERVAL, Array.from(SUPPORTED_INTERVALS), 'interval');
  const vsCurrency = String(body.vsCurrency || asset.vsCurrency).trim().toLowerCase();
  const conflictPolicy = normalizeChoice(
    body.conflictPolicy,
    DEFAULT_CONFLICT_POLICY,
    Array.from(CONFLICT_POLICIES),
    'conflictPolicy'
  );

  if (!vsCurrency) {
    throw createValidationError('invalid_vsCurrency', 'vsCurrency must be a non-empty currency code.');
  }

  try {
    assertTimestampRange(fromTs, toTs, {
      maxSpanMs: MAX_FETCH_RANGE_MS,
      maxSpanMessage: 'Manual CoinGecko fetch range must be 366 days or less.'
    });
  } catch (error) {
    throw createValidationError(error.code || 'invalid_range', error.message);
  }

  if (toTs <= fromTs) {
    throw createValidationError('invalid_range', 'to must be greater than from.');
  }

  return { fromTs, toTs, interval, vsCurrency, conflictPolicy };
}

function countCandlesInRange(db, assetId, vsCurrency, interval, fromTs, toTs) {
  return db
    .prepare(`
      SELECT COUNT(*) AS count
      FROM candles
      WHERE asset_id = @assetId
        AND vs_currency = @vsCurrency
        AND interval = @interval
        AND ts >= @fromTs
        AND ts <= @toTs
    `)
    .get({ assetId, vsCurrency, interval, fromTs, toTs })
    .count;
}

async function runManualFetch(db, assetId, body = {}, options = {}) {
  const asset = getPublicAsset(db, assetId);

  if (!asset) {
    throw createNotFoundError(assetId);
  }

  if (!asset.coingeckoId) {
    throw createValidationError('missing_coingecko_id', `Asset '${assetId}' does not have a CoinGecko ID.`);
  }

  const request = normalizeFetchRequest(body, asset);
  const startedAt = Date.now();
  const runId = createFetchRun(db, {
    assetId: asset.id,
    vsCurrency: request.vsCurrency,
    rangeFrom: request.fromTs,
    rangeTo: request.toTs,
    interval: request.interval,
    status: 'running',
    source: DEFAULT_SOURCE,
    pointsInserted: 0,
    error: null,
    startedAt,
    finishedAt: null
  });

  try {
    const fetchRange = options.fetchMarketChartRange || fetchMarketChartRange;
    const response = await fetchRange(asset.coingeckoId, request.vsCurrency, request.fromTs, request.toTs);
    const fetchedAt = Date.now();
    const candles = normalizeMarketChartRange(response, {
      assetId: asset.id,
      vsCurrency: request.vsCurrency,
      interval: request.interval
    });
    const beforeCount = countCandlesInRange(db, asset.id, request.vsCurrency, request.interval, request.fromTs, request.toTs);
    const insertResult = insertCandles(candles, {
      db,
      assetId: asset.id,
      vsCurrency: request.vsCurrency,
      interval: request.interval,
      conflictPolicy: request.conflictPolicy,
      fetchedAt
    });
    const afterCount = countCandlesInRange(db, asset.id, request.vsCurrency, request.interval, request.fromTs, request.toTs);
    const pointsInserted = Math.max(0, afterCount - beforeCount);
    const finishedAt = Date.now();

    updateFetchRun(db, runId, {
      status: 'success',
      pointsInserted,
      error: null,
      finishedAt
    });

    return {
      run: {
        id: runId,
        assetId: asset.id,
        vsCurrency: request.vsCurrency,
        rangeFrom: request.fromTs,
        rangeTo: request.toTs,
        interval: request.interval,
        status: 'success',
        source: DEFAULT_SOURCE,
        pointsInserted,
        error: null,
        startedAt,
        finishedAt
      },
      asset,
      candlesNormalized: candles.length,
      candlesChanged: insertResult.changed,
      conflictPolicy: insertResult.conflictPolicy,
      totalCandles: countCandles(asset.id, request.vsCurrency, request.interval, { db })
    };
  } catch (error) {
    const finishedAt = Date.now();

    updateFetchRun(db, runId, {
      status: 'failed',
      pointsInserted: 0,
      error: error.message,
      finishedAt
    });

    error.fetchRunId = runId;
    throw error;
  }
}

module.exports = {
  DEFAULT_CONFLICT_POLICY,
  DEFAULT_INTERVAL,
  DEFAULT_SOURCE,
  normalizeFetchRequest,
  runManualFetch
};
