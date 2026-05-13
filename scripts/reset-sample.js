#!/usr/bin/env node

require('dotenv').config();

const path = require('path');

const { runMigrations } = require('../src/db/migrations');
const { openDatabase } = require('../src/db/node-sqlite');
const { readNormalizedHistoryFile } = require('../src/services/import-service');
const { loadServerConfig } = require('../src/utils/config');

const SAMPLE_HISTORY_PATH = path.join(process.cwd(), 'test-fixtures', 'history', 'btc-sample.json');
const SAMPLE_ASSET_COINGECKO_ID = 'sample-bitcoin';

function main() {
  const config = loadServerConfig();
  const db = openDatabase(config.databasePath);

  try {
    runMigrations(db);
    const sample = readNormalizedHistoryFile(SAMPLE_HISTORY_PATH);
    const assetId = String(sample.assetId || sample.asset_id || 'btc').trim().toLowerCase();
    const vsCurrency = String(sample.vsCurrency || sample.vs_currency || 'usd').trim().toLowerCase();
    const interval = String(sample.interval || '1d').trim().toLowerCase();
    const timestamps = sample.candles.map((candle) => candle.ts);
    const deleteSample = db.transaction(() => {
      const deleteCandle = db.prepare(`
        DELETE FROM candles
        WHERE asset_id = @assetId
          AND vs_currency = @vsCurrency
          AND interval = @interval
          AND ts = @ts
      `);
      let deletedCandles = 0;

      timestamps.forEach((ts) => {
        deletedCandles += deleteCandle.run({ assetId, vsCurrency, interval, ts }).changes;
      });

      const deletedImportRuns = db.prepare('DELETE FROM import_runs WHERE filename = ?').run(path.basename(SAMPLE_HISTORY_PATH)).changes;
      db.prepare('DELETE FROM api_cache WHERE cache_key LIKE ?').run(`%${assetId}%`);

      const remainingCandles = db.prepare('SELECT COUNT(*) AS count FROM candles WHERE asset_id = ?').get(assetId).count;
      const sampleAsset = db.prepare('SELECT coingecko_id FROM assets WHERE id = ?').get(assetId);
      const deletedAssets = sampleAsset && sampleAsset.coingecko_id === SAMPLE_ASSET_COINGECKO_ID && remainingCandles === 0
        ? db.prepare('DELETE FROM assets WHERE id = ?').run(assetId).changes
        : 0;

      return { deletedCandles, deletedImportRuns, deletedAssets };
    });

    const result = deleteSample();

    console.log(JSON.stringify({
      ok: true,
      fixture: path.relative(process.cwd(), SAMPLE_HISTORY_PATH),
      assetId,
      vsCurrency,
      interval,
      ...result
    }, null, 2));
  } finally {
    db.close();
  }
}

main();
