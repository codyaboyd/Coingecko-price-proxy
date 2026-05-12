const { getPublicAsset } = require('../db/queries');
const { getMissingWindows, INTERVAL_STEPS_MS } = require('../services/cache-policy');
const { SUPPORTED_INTERVALS, CONFLICT_POLICIES } = require('../services/history-service');
const { assertTimestampRange, DAY_MS, parseDateInput } = require('../utils/date');

const DEFAULT_INTERVAL = '1d';
const DEFAULT_CONFLICT_POLICY = 'fill_only_missing';
const MAX_BACKFILL_RANGE_MS = 20 * 366 * DAY_MS;
const MAX_BACKFILL_CHUNKS = 500;
const DEFAULT_CHUNK_DAYS_BY_INTERVAL = {
  '5m': 1,
  '1h': 30,
  '1d': 90
};

function createValidationError(code, message) {
  const error = new Error(message);
  error.status = 400;
  error.code = code;
  return error;
}

function parseDate(value, field) {
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

function normalizeInterval(value) {
  return normalizeChoice(value, DEFAULT_INTERVAL, Array.from(SUPPORTED_INTERVALS), 'interval');
}

function normalizeRequest(body = {}, asset) {
  const fromTs = parseDate(body.from, 'from');
  const toTs = parseDate(body.to, 'to');
  const interval = normalizeInterval(body.interval);
  const vsCurrency = String(body.vsCurrency || asset.vsCurrency).trim().toLowerCase();

  if (!vsCurrency) {
    throw createValidationError('invalid_vsCurrency', 'vsCurrency must be a non-empty currency code.');
  }

  try {
    assertTimestampRange(fromTs, toTs, {
      maxSpanMs: MAX_BACKFILL_RANGE_MS,
      maxSpanMessage: 'Backfill range must be 20 years or less.'
    });
  } catch (error) {
    throw createValidationError(error.code || 'invalid_range', error.message);
  }

  return {
    fromTs,
    toTs,
    interval,
    vsCurrency,
    conflictPolicy: normalizeChoice(body.conflictPolicy, DEFAULT_CONFLICT_POLICY, Array.from(CONFLICT_POLICIES), 'conflictPolicy')
  };
}

function chunkMissingWindow(window, interval, options = {}) {
  const stepMs = INTERVAL_STEPS_MS[interval];
  const chunkDays = Number(options.chunkDays || DEFAULT_CHUNK_DAYS_BY_INTERVAL[interval]);
  const maxChunkMs = chunkDays * 24 * 60 * 60 * 1000;
  const chunks = [];
  let from = window.from;

  while (from <= window.to) {
    const to = Math.min(window.to, from + maxChunkMs - stepMs);
    chunks.push({
      from,
      to,
      fromIso: new Date(from).toISOString(),
      toIso: new Date(to).toISOString()
    });
    from = to + stepMs;
  }

  return chunks;
}

function enqueueBackfill(db, scheduler, assetId, body = {}, options = {}) {
  if (!scheduler || typeof scheduler.enqueue !== 'function') {
    throw new Error('Backfill requires a job scheduler.');
  }

  const asset = getPublicAsset(db, assetId);

  if (!asset) {
    const error = new Error(`Asset '${assetId}' was not found.`);
    error.status = 404;
    error.code = 'asset_not_found';
    throw error;
  }

  if (!asset.coingeckoId) {
    throw createValidationError('missing_coingecko_id', `Asset '${assetId}' does not have a CoinGecko ID.`);
  }

  const request = normalizeRequest(body, asset);
  const gaps = getMissingWindows(asset.id, request.vsCurrency, request.interval, request.fromTs, request.toTs, { db });
  const chunks = gaps.flatMap((gap) => chunkMissingWindow(gap, request.interval, options));
  if (chunks.length > MAX_BACKFILL_CHUNKS) {
    throw createValidationError('too_many_backfill_chunks', `Backfill would enqueue ${chunks.length} jobs; narrow the range or use a coarser interval.`);
  }

  const enqueuedJobs = chunks.map((chunk) => scheduler.enqueue('historical_backfill', {
    assetId: asset.id,
    from: new Date(chunk.from).toISOString(),
    to: new Date(chunk.to + INTERVAL_STEPS_MS[request.interval]).toISOString(),
    interval: request.interval,
    vsCurrency: request.vsCurrency,
    conflictPolicy: request.conflictPolicy,
    missingFrom: chunk.from,
    missingTo: chunk.to
  }));

  return {
    asset,
    request: {
      from: request.fromTs,
      to: request.toTs,
      fromIso: new Date(request.fromTs).toISOString(),
      toIso: new Date(request.toTs).toISOString(),
      interval: request.interval,
      vsCurrency: request.vsCurrency
    },
    gaps,
    chunks,
    enqueuedJobs
  };
}

module.exports = {
  chunkMissingWindow,
  enqueueBackfill,
  normalizeRequest
};
