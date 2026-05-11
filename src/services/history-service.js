const { openDatabase } = require('../db/node-sqlite');
const { loadServerConfig } = require('../utils/config');
const { invalidateHistoryCacheForAsset } = require('./api-cache');

const SUPPORTED_INTERVALS = new Set(['5m', '1h', '1d']);
const CONFLICT_POLICIES = new Set([
  'skip_existing',
  'overwrite_existing',
  'fill_only_missing',
  'prefer_import_if_older',
  'prefer_coingecko_if_newer'
]);
const DEFAULT_VS_CURRENCY = 'usd';
const DEFAULT_INTERVAL = '1d';
const DEFAULT_CONFLICT_POLICY = 'fill_only_missing';
const OPTIONAL_NUMERIC_FIELDS = ['open', 'high', 'low', 'volume', 'marketCap'];

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

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeTimestamp(value, location) {
  if (value instanceof Date) {
    const timestamp = value.getTime();

    if (!Number.isFinite(timestamp)) {
      throw new Error(`${location}.ts must be a valid timestamp.`);
    }

    return timestamp;
  }

  if (Number.isInteger(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);

    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }

  throw new Error(`${location}.ts must be an integer timestamp in milliseconds.`);
}

function normalizeNumber(value, location, field, required) {
  if (value === null || value === undefined) {
    if (required) {
      throw new Error(`${location}.${field} is required.`);
    }

    return null;
  }

  if (isFiniteNumber(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  throw new Error(`${location}.${field} must be a finite number.`);
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

function normalizeConflictPolicy(policy) {
  const normalized = policy || DEFAULT_CONFLICT_POLICY;

  if (!CONFLICT_POLICIES.has(normalized)) {
    throw new Error(`conflictPolicy must be one of: ${Array.from(CONFLICT_POLICIES).join(', ')}.`);
  }

  return normalized;
}

function normalizePositiveInteger(value, field) {
  if (value === undefined || value === null) {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }

  return parsed;
}

function normalizeOptionalTimestamp(value, field) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  return normalizeTimestamp(value, field);
}

function normalizeCandle(candle, index, defaults) {
  const location = `candles[${index}]`;

  if (!isPlainObject(candle)) {
    throw new Error(`${location} must be an object.`);
  }

  const assetId = candle.assetId || candle.asset_id || defaults.assetId;
  const vsCurrency = candle.vsCurrency || candle.vs_currency || defaults.vsCurrency;
  const interval = candle.interval || defaults.interval;

  const normalized = {
    assetId: normalizeRequiredString(assetId, `${location}.assetId`),
    vsCurrency: normalizeRequiredString(vsCurrency, `${location}.vsCurrency`),
    interval: normalizeInterval(interval),
    ts: normalizeTimestamp(candle.ts, location),
    close: normalizeNumber(candle.close, location, 'close', true),
    open: null,
    high: null,
    low: null,
    volume: null,
    marketCap: null,
    fetchedAt: normalizeOptionalTimestamp(candle.fetchedAt || candle.fetched_at || defaults.fetchedAt, `${location}.fetchedAt`) || Date.now()
  };

  OPTIONAL_NUMERIC_FIELDS.forEach((field) => {
    normalized[field] = normalizeNumber(candle[field], location, field, false);
  });

  return normalized;
}

function validateCandles(candles, defaults) {
  if (!Array.isArray(candles)) {
    throw new Error('candles must be an array.');
  }

  return candles.map((candle, index) => normalizeCandle(candle, index, defaults));
}

function buildInsertStatement(db, conflictPolicy) {
  const baseSql = `
    INSERT INTO candles (
      asset_id,
      vs_currency,
      interval,
      ts,
      open,
      high,
      low,
      close,
      volume,
      market_cap,
      fetched_at
    ) VALUES (
      @assetId,
      @vsCurrency,
      @interval,
      @ts,
      @open,
      @high,
      @low,
      @close,
      @volume,
      @marketCap,
      @fetchedAt
    )`;

  if (conflictPolicy === 'skip_existing') {
    return db.prepare(`${baseSql} ON CONFLICT(asset_id, vs_currency, interval, ts) DO NOTHING`);
  }

  if (conflictPolicy === 'overwrite_existing') {
    return db.prepare(`
      ${baseSql}
      ON CONFLICT(asset_id, vs_currency, interval, ts) DO UPDATE SET
        open = excluded.open,
        high = excluded.high,
        low = excluded.low,
        close = excluded.close,
        volume = excluded.volume,
        market_cap = excluded.market_cap,
        fetched_at = excluded.fetched_at
    `);
  }

  if (conflictPolicy === 'prefer_import_if_older') {
    return db.prepare(`
      ${baseSql}
      ON CONFLICT(asset_id, vs_currency, interval, ts) DO UPDATE SET
        open = excluded.open,
        high = excluded.high,
        low = excluded.low,
        close = excluded.close,
        volume = excluded.volume,
        market_cap = excluded.market_cap,
        fetched_at = excluded.fetched_at
      WHERE excluded.fetched_at < candles.fetched_at
    `);
  }

  if (conflictPolicy === 'prefer_coingecko_if_newer') {
    return db.prepare(`
      ${baseSql}
      ON CONFLICT(asset_id, vs_currency, interval, ts) DO UPDATE SET
        open = excluded.open,
        high = excluded.high,
        low = excluded.low,
        close = excluded.close,
        volume = excluded.volume,
        market_cap = excluded.market_cap,
        fetched_at = excluded.fetched_at
      WHERE candles.fetched_at <= excluded.fetched_at
    `);
  }

  return db.prepare(`
    ${baseSql}
    ON CONFLICT(asset_id, vs_currency, interval, ts) DO UPDATE SET
      open = COALESCE(candles.open, excluded.open),
      high = COALESCE(candles.high, excluded.high),
      low = COALESCE(candles.low, excluded.low),
      volume = COALESCE(candles.volume, excluded.volume),
      market_cap = COALESCE(candles.market_cap, excluded.market_cap),
      fetched_at = CASE
        WHEN candles.open IS NULL AND excluded.open IS NOT NULL THEN excluded.fetched_at
        WHEN candles.high IS NULL AND excluded.high IS NOT NULL THEN excluded.fetched_at
        WHEN candles.low IS NULL AND excluded.low IS NOT NULL THEN excluded.fetched_at
        WHEN candles.volume IS NULL AND excluded.volume IS NOT NULL THEN excluded.fetched_at
        WHEN candles.market_cap IS NULL AND excluded.market_cap IS NOT NULL THEN excluded.fetched_at
        ELSE candles.fetched_at
      END
  `);
}

function toCandle(row) {
  return {
    assetId: row.asset_id,
    vsCurrency: row.vs_currency,
    interval: row.interval,
    ts: row.ts,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    marketCap: row.market_cap,
    fetchedAt: row.fetched_at
  };
}

function insertCandles(candles, options = {}) {
  const db = getDatabase(options);
  const conflictPolicy = normalizeConflictPolicy(options.conflictPolicy || options.conflict_policy);
  const defaults = {
    assetId: options.assetId || options.asset_id,
    vsCurrency: options.vsCurrency || options.vs_currency || DEFAULT_VS_CURRENCY,
    interval: options.interval || DEFAULT_INTERVAL,
    fetchedAt: options.fetchedAt || options.fetched_at
  };
  const normalizedCandles = validateCandles(candles, defaults);

  if (normalizedCandles.length === 0) {
    return {
      received: 0,
      changed: 0,
      conflictPolicy
    };
  }

  const statement = buildInsertStatement(db, conflictPolicy);
  const writeCandles = db.transaction((rows) => {
    let changed = 0;

    rows.forEach((row) => {
      changed += statement.run(row).changes;
    });

    return changed;
  });

  const changed = writeCandles(normalizedCandles);

  if (changed > 0) {
    Array.from(new Set(normalizedCandles.map((candle) => candle.assetId)))
      .forEach((assetId) => invalidateHistoryCacheForAsset(db, assetId));
  }

  return {
    received: normalizedCandles.length,
    changed,
    conflictPolicy
  };
}

function getHistory(assetId, options = {}) {
  const db = getDatabase(options);
  const normalizedAssetId = normalizeRequiredString(assetId, 'assetId');
  const vsCurrency = normalizeRequiredString(options.vsCurrency || options.vs_currency || DEFAULT_VS_CURRENCY, 'vsCurrency');
  const interval = normalizeInterval(options.interval || DEFAULT_INTERVAL);
  const fromTs = normalizeOptionalTimestamp(options.fromTs || options.from_ts, 'fromTs');
  const toTs = normalizeOptionalTimestamp(options.toTs || options.to_ts, 'toTs');
  const limit = normalizePositiveInteger(options.limit, 'limit');
  const order = String(options.order || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const params = { assetId: normalizedAssetId, vsCurrency, interval };
  const where = ['asset_id = @assetId', 'vs_currency = @vsCurrency', 'interval = @interval'];

  if (fromTs !== null) {
    params.fromTs = fromTs;
    where.push('ts >= @fromTs');
  }

  if (toTs !== null) {
    params.toTs = toTs;
    where.push('ts <= @toTs');
  }

  if (limit !== null) {
    params.limit = limit;
  }

  const limitSql = limit === null ? '' : 'LIMIT @limit';

  return db
    .prepare(`
      SELECT asset_id, vs_currency, interval, ts, open, high, low, close, volume, market_cap, fetched_at
      FROM candles
      WHERE ${where.join(' AND ')}
      ORDER BY ts ${order}
      ${limitSql}
    `)
    .all(params)
    .map(toCandle);
}

function getHistoryRange(assetId, vsCurrency = DEFAULT_VS_CURRENCY, interval = DEFAULT_INTERVAL, options = {}) {
  const db = getDatabase(options);
  const row = db
    .prepare(`
      SELECT MIN(ts) AS earliestTs, MAX(ts) AS latestTs
      FROM candles
      WHERE asset_id = @assetId
        AND vs_currency = @vsCurrency
        AND interval = @interval
    `)
    .get({
      assetId: normalizeRequiredString(assetId, 'assetId'),
      vsCurrency: normalizeRequiredString(vsCurrency, 'vsCurrency'),
      interval: normalizeInterval(interval)
    });

  return row && row.earliestTs !== null
    ? { earliestTs: row.earliestTs, latestTs: row.latestTs }
    : null;
}

function getEarliestLatest(assetId, vsCurrency = DEFAULT_VS_CURRENCY, interval = DEFAULT_INTERVAL, options = {}) {
  return getHistoryRange(assetId, vsCurrency, interval, options);
}

function countCandles(assetId, vsCurrency = DEFAULT_VS_CURRENCY, interval = DEFAULT_INTERVAL, options = {}) {
  const db = getDatabase(options);
  const row = db
    .prepare(`
      SELECT COUNT(*) AS count
      FROM candles
      WHERE asset_id = @assetId
        AND vs_currency = @vsCurrency
        AND interval = @interval
    `)
    .get({
      assetId: normalizeRequiredString(assetId, 'assetId'),
      vsCurrency: normalizeRequiredString(vsCurrency, 'vsCurrency'),
      interval: normalizeInterval(interval)
    });

  return row.count;
}

module.exports = {
  CONFLICT_POLICIES,
  DEFAULT_CONFLICT_POLICY,
  SUPPORTED_INTERVALS,
  countCandles,
  getEarliestLatest,
  getHistory,
  getHistoryRange,
  insertCandles
};
