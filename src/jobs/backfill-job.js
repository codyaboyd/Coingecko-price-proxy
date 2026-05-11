const { getPublicAsset } = require('../db/queries');
const { getMissingWindows, INTERVAL_STEPS_MS } = require('../services/cache-policy');
const { SUPPORTED_INTERVALS } = require('../services/history-service');

const DEFAULT_INTERVAL = '1d';
const DEFAULT_CONFLICT_POLICY = 'fill_only_missing';
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
  if (typeof value !== 'string' || value.trim() === '') {
    throw createValidationError(`invalid_${field}`, `${field} must be a YYYY-MM-DD date or ISO date string.`);
  }

  const text = value.trim();
  const dateOnlyMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (dateOnlyMatch) {
    const year = Number(dateOnlyMatch[1]);
    const monthIndex = Number(dateOnlyMatch[2]) - 1;
    const day = Number(dateOnlyMatch[3]);
    const timestamp = field === 'to'
      ? Date.UTC(year, monthIndex, day, 23, 59, 59, 999)
      : Date.UTC(year, monthIndex, day, 0, 0, 0, 0);
    const parsed = new Date(timestamp);

    if (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === monthIndex &&
      parsed.getUTCDate() === day
    ) {
      return timestamp;
    }
  }

  const parsed = Date.parse(text);

  if (Number.isFinite(parsed)) {
    return parsed;
  }

  throw createValidationError(`invalid_${field}`, `${field} must be a YYYY-MM-DD date or ISO date string.`);
}

function normalizeInterval(value) {
  const interval = String(value || DEFAULT_INTERVAL).trim().toLowerCase();

  if (!SUPPORTED_INTERVALS.has(interval)) {
    throw createValidationError('invalid_interval', `interval must be one of: ${Array.from(SUPPORTED_INTERVALS).join(', ')}.`);
  }

  return interval;
}

function normalizeRequest(body = {}, asset) {
  const fromTs = parseDate(body.from, 'from');
  const toTs = parseDate(body.to, 'to');
  const interval = normalizeInterval(body.interval);
  const vsCurrency = String(body.vsCurrency || asset.vsCurrency).trim().toLowerCase();

  if (!vsCurrency) {
    throw createValidationError('invalid_vsCurrency', 'vsCurrency must be a non-empty currency code.');
  }

  if (toTs < fromTs) {
    throw createValidationError('invalid_range', 'to must be greater than or equal to from.');
  }

  return {
    fromTs,
    toTs,
    interval,
    vsCurrency,
    conflictPolicy: body.conflictPolicy || DEFAULT_CONFLICT_POLICY
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
