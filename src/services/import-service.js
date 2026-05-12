const fs = require('fs');
const path = require('path');

const TIMESTAMP_UNITS = new Set(['auto', 'ms', 's']);
const SUPPORTED_TIMEZONES = new Set(['utc']);

const COLUMN_ALIASES = {
  timestamp: ['timestamp', 'ts', 'date', 'time', 'datetime', 'open_time', 'opentime', 'start_time', 'starttime'],
  open: ['open', 'o'],
  high: ['high', 'h'],
  low: ['low', 'l'],
  close: ['close', 'price', 'c'],
  volume: ['volume', 'vol', 'total_volume', 'totalvolume', 'v'],
  marketCap: ['marketcap', 'market_cap', 'market capitalization', 'marketcapitalization']
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRequiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string.`);
  }

  return value.trim().toLowerCase();
}

function normalizeOptionalString(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }

  return String(value).trim().toLowerCase();
}

function normalizeTimestampUnit(value) {
  const normalized = value === undefined || value === null ? 'auto' : String(value).trim().toLowerCase();

  if (!TIMESTAMP_UNITS.has(normalized)) {
    throw new Error('--timestamp-unit must be one of: ms, s, auto.');
  }

  return normalized;
}

function normalizeTimezone(value) {
  const normalized = value === undefined || value === null ? 'utc' : String(value).trim().toLowerCase();

  if (!SUPPORTED_TIMEZONES.has(normalized)) {
    throw new Error('--timezone currently supports only utc.');
  }

  return normalized;
}

function normalizeHeader(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function buildAliasLookup() {
  const lookup = new Map();

  Object.entries(COLUMN_ALIASES).forEach(([field, aliases]) => {
    aliases.forEach((alias) => {
      lookup.set(normalizeHeader(alias), field);
    });
  });

  return lookup;
}

const ALIAS_LOOKUP = buildAliasLookup();

function detectColumns(headers) {
  const columns = {};

  headers.forEach((header, index) => {
    const field = ALIAS_LOOKUP.get(normalizeHeader(header));

    if (field && columns[field] === undefined) {
      columns[field] = index;
    }
  });

  return columns;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') {
        index += 1;
      }
      row.push(cell);
      if (row.some((value) => value.trim() !== '')) {
        rows.push(row);
      }
      row = [];
      cell = '';
      continue;
    }

    cell += char;
  }

  if (cell !== '' || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.trim() !== '')) {
      rows.push(row);
    }
  }

  return rows;
}

function parseNumber(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  const normalized = String(value).trim().replace(/,/g, '');

  if (normalized === '') {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTimestamp(value, options) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  if (typeof value === 'number' || String(value).trim() !== '') {
    const numeric = Number(value);

    if (Number.isFinite(numeric)) {
      if (options.timestampUnit === 's') {
        return Math.floor(numeric * 1000);
      }

      if (options.timestampUnit === 'ms') {
        return Math.floor(numeric);
      }

      return Math.floor(Math.abs(numeric) < 100000000000 ? numeric * 1000 : numeric);
    }
  }

  const parsed = Date.parse(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function getObjectValue(row, field) {
  const normalizedAliases = COLUMN_ALIASES[field].map(normalizeHeader);
  const entry = Object.entries(row).find(([key]) => normalizedAliases.includes(normalizeHeader(key)));
  return entry ? entry[1] : undefined;
}

function hasObjectColumns(row) {
  return getObjectValue(row, 'timestamp') !== undefined && getObjectValue(row, 'close') !== undefined;
}

function createCandleFromValues(values, options) {
  const ts = parseTimestamp(values.timestamp, options);
  const close = parseNumber(values.close);

  if (ts === null || close === null) {
    return null;
  }

  return {
    ts,
    open: parseNumber(values.open),
    high: parseNumber(values.high),
    low: parseNumber(values.low),
    close,
    volume: parseNumber(values.volume),
    marketCap: parseNumber(values.marketCap),
    source: options.source
  };
}

function convertObjectRow(row, options) {
  return createCandleFromValues({
    timestamp: getObjectValue(row, 'timestamp'),
    open: getObjectValue(row, 'open'),
    high: getObjectValue(row, 'high'),
    low: getObjectValue(row, 'low'),
    close: getObjectValue(row, 'close'),
    volume: getObjectValue(row, 'volume'),
    marketCap: getObjectValue(row, 'marketCap')
  }, options);
}

function convertCsv(text, options) {
  const rows = parseCsv(text);
  const headers = rows[0] || [];
  const columns = detectColumns(headers);
  const candles = [];
  let skipped = 0;

  if (columns.timestamp === undefined || columns.close === undefined) {
    throw new Error('CSV input must contain timestamp/date/time and close/price columns.');
  }

  rows.slice(1).forEach((row) => {
    const candle = createCandleFromValues({
      timestamp: row[columns.timestamp],
      open: row[columns.open],
      high: row[columns.high],
      low: row[columns.low],
      close: row[columns.close],
      volume: row[columns.volume],
      marketCap: row[columns.marketCap]
    }, options);

    if (candle) {
      candles.push(candle);
    } else {
      skipped += 1;
    }
  });

  return {
    detectedFormat: 'csv:columns',
    rowsSeen: Math.max(rows.length - 1, 0),
    rowsSkipped: skipped,
    candles
  };
}

function isPointTuple(value) {
  return Array.isArray(value) && value.length >= 2;
}

function isCoinGeckoMarketChart(data) {
  return isPlainObject(data) && Array.isArray(data.prices) && data.prices.every(isPointTuple);
}

function lastPointByTimestamp(points, options) {
  const map = new Map();

  if (!Array.isArray(points)) {
    return map;
  }

  points.forEach((point) => {
    const ts = parseTimestamp(point[0], options);
    const value = parseNumber(point[1]);

    if (ts !== null && value !== null) {
      map.set(ts, value);
    }
  });

  return map;
}

function convertCoinGecko(data, options) {
  const marketCaps = lastPointByTimestamp(data.market_caps, options);
  const volumes = lastPointByTimestamp(data.total_volumes, options);
  const candles = [];
  let skipped = 0;

  data.prices.forEach((point) => {
    const ts = parseTimestamp(point[0], options);
    const price = parseNumber(point[1]);

    if (ts === null || price === null) {
      skipped += 1;
      return;
    }

    candles.push({
      ts,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: volumes.has(ts) ? volumes.get(ts) : null,
      marketCap: marketCaps.has(ts) ? marketCaps.get(ts) : null,
      source: options.source
    });
  });

  return {
    detectedFormat: 'json:coingecko-market-chart',
    rowsSeen: data.prices.length,
    rowsSkipped: skipped,
    candles
  };
}

function isBinanceKline(row) {
  return Array.isArray(row) && row.length >= 6 && parseNumber(row[1]) !== null && parseNumber(row[4]) !== null;
}

function extractArrayData(data) {
  if (Array.isArray(data)) {
    return data;
  }

  if (isPlainObject(data)) {
    if (Array.isArray(data.klines)) {
      return data.klines;
    }

    if (Array.isArray(data.data)) {
      return data.data;
    }

    if (Array.isArray(data.candles)) {
      return data.candles;
    }
  }

  return null;
}

function convertBinanceKlines(rows, options) {
  const candles = [];
  let skipped = 0;

  rows.forEach((row) => {
    const candle = createCandleFromValues({
      timestamp: row[0],
      open: row[1],
      high: row[2],
      low: row[3],
      close: row[4],
      volume: row[5]
    }, options);

    if (candle) {
      candles.push(candle);
    } else {
      skipped += 1;
    }
  });

  return {
    detectedFormat: 'json:binance-klines',
    rowsSeen: rows.length,
    rowsSkipped: skipped,
    candles
  };
}

function convertJsonRows(rows, options) {
  const candles = [];
  let skipped = 0;

  rows.forEach((row) => {
    const candle = isPlainObject(row) ? convertObjectRow(row, options) : null;

    if (candle) {
      candles.push(candle);
    } else {
      skipped += 1;
    }
  });

  return {
    detectedFormat: 'json:rows',
    rowsSeen: rows.length,
    rowsSkipped: skipped,
    candles
  };
}

function convertJson(text, options) {
  const data = JSON.parse(text);

  if (isCoinGeckoMarketChart(data)) {
    return convertCoinGecko(data, options);
  }

  const rows = extractArrayData(data);

  if (!rows) {
    throw new Error('JSON input must be CoinGecko market chart data, Binance klines, or an array/object containing rows.');
  }

  if (rows.length === 0) {
    return {
      detectedFormat: 'json:rows',
      rowsSeen: 0,
      rowsSkipped: 0,
      candles: []
    };
  }

  if (rows.some(isBinanceKline)) {
    return convertBinanceKlines(rows, options);
  }

  if (rows.some((row) => isPlainObject(row) && hasObjectColumns(row))) {
    return convertJsonRows(rows, options);
  }

  throw new Error('Could not detect JSON row format.');
}

function sortCandles(candles) {
  return candles.slice().sort((left, right) => left.ts - right.ts);
}

function buildOutput(candles, options) {
  return {
    assetId: options.assetId,
    symbol: options.symbol,
    vsCurrency: options.vsCurrency,
    interval: options.interval,
    source: options.source,
    candles: sortCandles(candles)
  };
}

function normalizeOptions(options = {}) {
  const assetId = normalizeRequiredString(options.assetId || options.asset, 'assetId');

  return {
    assetId,
    symbol: normalizeOptionalString(options.symbol, assetId),
    vsCurrency: normalizeRequiredString(options.vsCurrency || options.vs || 'usd', 'vsCurrency'),
    interval: normalizeRequiredString(options.interval || '1d', 'interval'),
    source: normalizeOptionalString(options.source, 'import'),
    timestampUnit: normalizeTimestampUnit(options.timestampUnit || options.timestamp_unit),
    timezone: normalizeTimezone(options.timezone)
  };
}

function convertDumpText(text, inputPath, options = {}) {
  const normalizedOptions = normalizeOptions(options);
  const extension = path.extname(inputPath || '').toLowerCase();
  const trimmed = text.trimStart();
  const conversion = extension === '.json' || trimmed.startsWith('{') || trimmed.startsWith('[')
    ? convertJson(text, normalizedOptions)
    : convertCsv(text, normalizedOptions);
  const output = buildOutput(conversion.candles, normalizedOptions);

  return {
    output,
    report: {
      rowsSeen: conversion.rowsSeen,
      rowsConverted: output.candles.length,
      rowsSkipped: conversion.rowsSkipped,
      detectedFormat: conversion.detectedFormat
    }
  };
}

function convertDumpFile(inputPath, options = {}) {
  if (!inputPath) {
    throw new Error('An input CSV or JSON path is required.');
  }

  const text = fs.readFileSync(inputPath, 'utf8');
  return convertDumpText(text, inputPath, options);
}

const IMPORT_RUN_COLUMNS = [
  'filename',
  'asset_id',
  'vs_currency',
  'detected_format',
  'status',
  'rows_seen',
  'rows_imported',
  'error',
  'created_at'
];

function isNormalizedHistory(data) {
  return isPlainObject(data) && Array.isArray(data.candles);
}

function readNormalizedHistoryFile(inputPath) {
  if (!inputPath) {
    throw new Error('A normalized JSON input path is required.');
  }

  const text = fs.readFileSync(inputPath, 'utf8');
  const data = JSON.parse(text);

  if (!isNormalizedHistory(data)) {
    throw new Error('Normalized JSON input must contain a candles array.');
  }

  return data;
}

function normalizeImportPolicy(policy) {
  const { CONFLICT_POLICIES, DEFAULT_CONFLICT_POLICY } = require('./history-service');
  const normalized = String(policy || DEFAULT_CONFLICT_POLICY).trim().toLowerCase();

  if (!CONFLICT_POLICIES.has(normalized)) {
    throw new Error(`policy must be one of: ${Array.from(CONFLICT_POLICIES).join(', ')}.`);
  }

  return normalized;
}

function recordImportRun(db, run) {
  const row = {
    filename: run.filename,
    asset_id: run.assetId || null,
    vs_currency: run.vsCurrency || null,
    detected_format: run.detectedFormat || null,
    status: run.status,
    rows_seen: run.rowsSeen || 0,
    rows_imported: run.rowsImported || 0,
    error: run.error || null,
    created_at: run.createdAt || Date.now()
  };

  const availableColumns = new Set(db.prepare('PRAGMA table_info(import_runs)').all().map((column) => column.name));
  const columns = IMPORT_RUN_COLUMNS.filter((column) => availableColumns.has(column));
  const placeholders = columns.map((column) => `@${column}`).join(', ');

  return db.prepare(`
    INSERT INTO import_runs (${columns.join(', ')})
    VALUES (${placeholders})
  `).run(row).lastInsertRowid;
}

function detectedFormatForNormalized(data) {
  return data.detectedFormat || data.detected_format || (data.source ? `normalized-json:${data.source}` : 'normalized-json');
}

function importNormalizedHistoryFile(inputPath, options = {}) {
  const { insertCandles } = require('./history-service');
  const data = readNormalizedHistoryFile(inputPath);
  const db = options.db;

  if (!db) {
    throw new Error('importNormalizedHistoryFile requires a database connection.');
  }

  const policy = normalizeImportPolicy(options.policy || options.conflictPolicy || options.conflict_policy);
  const assetId = normalizeRequiredString(options.assetId || options.asset || data.assetId || data.asset_id, 'assetId');
  const vsCurrency = normalizeRequiredString(options.vsCurrency || options.vs || data.vsCurrency || data.vs_currency || 'usd', 'vsCurrency');
  const interval = normalizeRequiredString(options.interval || data.interval || '1d', 'interval');
  const filename = path.basename(inputPath);
  const detectedFormat = detectedFormatForNormalized(data);
  const createdAt = Date.now();

  try {
    const importCandles = data.candles.map((candle) => ({
      ...candle,
      assetId,
      vsCurrency,
      interval
    }));
    let result;
    let runId;
    const writeImport = db.transaction(() => {
      result = insertCandles(importCandles, {
        db,
        assetId,
        vsCurrency,
        interval,
        conflictPolicy: policy,
        fetchedAt: createdAt
      });

      runId = recordImportRun(db, {
        filename,
        assetId,
        vsCurrency,
        detectedFormat,
        status: 'success',
        rowsSeen: result.received,
        rowsImported: result.changed,
        createdAt
      });
    });

    writeImport();

    return {
      runId,
      filename,
      assetId,
      vsCurrency,
      interval,
      detectedFormat,
      status: 'success',
      rowsSeen: result.received,
      rowsImported: result.changed,
      policy
    };
  } catch (error) {
    const runId = recordImportRun(db, {
      filename,
      assetId,
      vsCurrency,
      detectedFormat,
      status: 'error',
      rowsSeen: Array.isArray(data.candles) ? data.candles.length : 0,
      rowsImported: 0,
      error: error.message,
      createdAt
    });

    error.importRunId = runId;
    throw error;
  }
}

function previewNormalizedHistoryFile(inputPath, limit = 25) {
  const data = readNormalizedHistoryFile(inputPath);
  return {
    assetId: data.assetId || data.asset_id || null,
    symbol: data.symbol || null,
    vsCurrency: data.vsCurrency || data.vs_currency || null,
    interval: data.interval || null,
    source: data.source || null,
    detectedFormat: detectedFormatForNormalized(data),
    rowsSeen: data.candles.length,
    candles: data.candles.slice(0, limit)
  };
}

module.exports = {
  convertDumpFile,
  convertDumpText,
  importNormalizedHistoryFile,
  parseCsv,
  previewNormalizedHistoryFile,
  readNormalizedHistoryFile
};
