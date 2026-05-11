const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDatabase } = require('../src/db/node-sqlite');
const { runMigrations } = require('../src/db/migrations');
const { upsertAssets } = require('../src/db/queries');
const {
  countCandles,
  getEarliestLatest,
  getHistory,
  getHistoryRange,
  insertCandles
} = require('../src/services/history-service');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-service-'));
  const dbPath = path.join(tempDir, 'history.sqlite');
  const db = openDatabase(dbPath);

  try {
    runMigrations(db);
    upsertAssets(db, [{
      id: 'btc',
      symbol: 'BTC',
      name: 'Bitcoin',
      coingeckoId: 'bitcoin',
      vsCurrency: 'usd',
      enabled: true,
      priority: 1
    }]);

    const firstInsert = insertCandles([
      { ts: 1704067200000, close: 42000 },
      { ts: 1704153600000, open: 42100, high: 43000, low: 41900, close: 42500, volume: 1200, marketCap: 833000000000 }
    ], { db, assetId: 'btc', vsCurrency: 'usd', interval: '1d' });

    assert(firstInsert.changed === 2, 'Expected initial insert to write two candles.');

    const fillResult = insertCandles([
      { ts: 1704067200000, open: 41900, high: 42250, low: 41850, close: 99999, volume: 1000 }
    ], { db, assetId: 'btc', vsCurrency: 'usd', interval: '1d', conflictPolicy: 'fill_only_missing' });

    assert(fillResult.changed === 1, 'Expected fill_only_missing to update missing optional fields.');

    const skipResult = insertCandles([
      { ts: 1704067200000, close: 1 }
    ], { db, assetId: 'btc', vsCurrency: 'usd', interval: '1d', conflictPolicy: 'skip_existing' });

    assert(skipResult.changed === 0, 'Expected skip_existing to leave existing candle untouched.');

    const overwriteResult = insertCandles([
      { ts: 1704153600000, close: 43000 }
    ], { db, assetId: 'btc', vsCurrency: 'usd', interval: '1d', conflictPolicy: 'overwrite_existing' });

    assert(overwriteResult.changed === 1, 'Expected overwrite_existing to update existing candle.');

    const history = getHistory('btc', { db, vsCurrency: 'usd', interval: '1d' });
    assert(history.length === 2, 'Expected two history rows.');
    assert(history[0].close === 42000, 'Expected fill_only_missing to keep the original close.');
    assert(history[0].open === 41900, 'Expected fill_only_missing to populate missing open.');
    assert(history[1].close === 43000, 'Expected overwrite_existing to replace close.');

    const range = getHistoryRange('btc', 'usd', '1d', { db });
    const earliestLatest = getEarliestLatest('btc', 'usd', '1d', { db });
    assert(range.earliestTs === 1704067200000, 'Expected range earliest timestamp.');
    assert(range.latestTs === 1704153600000, 'Expected range latest timestamp.');
    assert(earliestLatest.latestTs === range.latestTs, 'Expected getEarliestLatest to match getHistoryRange.');
    assert(countCandles('btc', 'usd', '1d', { db }) === 2, 'Expected countCandles to return two.');

    console.log('History service verification passed.');
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
