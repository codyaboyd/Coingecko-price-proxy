#!/usr/bin/env node

require('dotenv').config();

const path = require('path');

const { runMigrations } = require('../src/db/migrations');
const { openDatabase } = require('../src/db/node-sqlite');
const { importNormalizedHistoryFile, readNormalizedHistoryFile } = require('../src/services/import-service');
const { loadServerConfig } = require('../src/utils/config');

const SAMPLE_HISTORY_PATH = path.join(process.cwd(), 'test-fixtures', 'history', 'btc-sample.json');
const SAMPLE_ASSET = {
  id: 'btc',
  symbol: 'BTC',
  name: 'Sample Bitcoin',
  coingeckoId: 'sample-bitcoin',
  vsCurrency: 'usd',
  enabled: 1,
  priority: 999
};

function ensureSampleAsset(db, sample) {
  const assetId = String(sample.assetId || sample.asset_id || SAMPLE_ASSET.id).trim().toLowerCase();
  const vsCurrency = String(sample.vsCurrency || sample.vs_currency || SAMPLE_ASSET.vsCurrency).trim().toLowerCase();
  const existing = db.prepare('SELECT id, enabled FROM assets WHERE id = ?').get(assetId);
  const now = Date.now();

  if (existing) {
    if (!existing.enabled) {
      db.prepare('UPDATE assets SET enabled = 1, updated_at = ? WHERE id = ?').run(now, assetId);
    }

    return { created: false, enabled: true, changedEnabled: !existing.enabled };
  }

  db.prepare(`
    INSERT INTO assets (id, symbol, name, coingecko_id, vs_currency, enabled, priority, created_at, updated_at)
    VALUES (@id, @symbol, @name, @coingeckoId, @vsCurrency, @enabled, @priority, @createdAt, @updatedAt)
  `).run({
    ...SAMPLE_ASSET,
    id: assetId,
    vsCurrency,
    createdAt: now,
    updatedAt: now
  });

  return { created: true, enabled: true };
}

function main() {
  const config = loadServerConfig();
  const db = openDatabase(config.databasePath);

  try {
    runMigrations(db);
    const sample = readNormalizedHistoryFile(SAMPLE_HISTORY_PATH);
    const asset = ensureSampleAsset(db, sample);
    const result = importNormalizedHistoryFile(SAMPLE_HISTORY_PATH, {
      db,
      policy: 'overwrite_existing'
    });

    console.log(JSON.stringify({
      ok: true,
      fixture: path.relative(process.cwd(), SAMPLE_HISTORY_PATH),
      asset,
      result
    }, null, 2));
  } finally {
    db.close();
  }
}

main();
