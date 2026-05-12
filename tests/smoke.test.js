const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createApp } = require('../src/app');
const { runMigrations, MIGRATIONS } = require('../src/db/migrations');
const { openDatabase } = require('../src/db/node-sqlite');
const { upsertAssets } = require('../src/db/queries');
const { getGapReport } = require('../src/services/cache-policy');
const { insertCandles } = require('../src/services/history-service');
const { convertDumpFile } = require('../src/services/import-service');
const { validateAssetsFile } = require('../src/services/asset-service');
const { loadServerConfig } = require('../src/utils/config');

const DAY_MS = 24 * 60 * 60 * 1000;
const FIXTURE_CSV = path.join(process.cwd(), 'test-fixtures', 'sample-history.csv');
const TEST_ASSETS = [
  {
    id: 'btc',
    symbol: 'BTC',
    name: 'Bitcoin',
    coingeckoId: 'bitcoin',
    vsCurrency: 'usd',
    enabled: true,
    priority: 10
  }
];

function createTempDatabase(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrono-cache-smoke-'));
  const databasePath = path.join(tempDir, 'history.sqlite');
  const db = openDatabase(databasePath);

  t.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  return db;
}

function seedDatabase(t) {
  const db = createTempDatabase(t);
  runMigrations(db);
  upsertAssets(db, TEST_ASSETS, Date.UTC(2026, 0, 1));
  return db;
}

test('config loads from the default server config', () => {
  const config = loadServerConfig();

  assert.equal(config.appName, 'chrono-cache');
  assert.equal(typeof config.host, 'string');
  assert.ok(config.host.length > 0);
  assert.equal(Number.isInteger(config.port), true);
  assert.ok(config.port >= 1 && config.port <= 65535);
  assert.equal(typeof config.databasePath, 'string');
  assert.ok(config.databasePath.length > 0);
  assert.equal(typeof config.assetsConfigPath, 'string');
  assert.ok(config.assetsConfigPath.length > 0);
});

test('migrations run on an empty database', (t) => {
  const db = createTempDatabase(t);
  const applied = runMigrations(db);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
  const versions = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version ASC')
    .all()
    .map((row) => row.version);

  assert.deepEqual(applied.map((migration) => migration.version), MIGRATIONS.map((migration) => migration.version));
  assert.ok(tables.includes('assets'));
  assert.ok(tables.includes('candles'));
  assert.ok(tables.includes('import_runs'));
  assert.deepEqual(versions, MIGRATIONS.map((migration) => migration.version));
});

test('assets validate from config/assets.json', () => {
  const assets = validateAssetsFile('./config/assets.json');

  assert.ok(assets.length >= 2);
  assert.ok(assets.some((asset) => asset.id === 'btc'));
  assert.ok(assets.every((asset) => asset.enabled === true || asset.enabled === false));
});

test('fake candles insert and history API returns candles while invalid asset returns 404', async (t) => {
  const db = seedDatabase(t);
  const firstDay = Date.UTC(2026, 0, 1);
  const insertResult = insertCandles([
    { ts: firstDay, open: 42000, high: 43000, low: 41000, close: 42500, volume: 123.45, marketCap: 850000000000 },
    { ts: firstDay + DAY_MS, open: 42500, high: 44000, low: 42000, close: 43500, volume: 234.56, marketCap: 870000000000 }
  ], {
    db,
    assetId: 'btc',
    vsCurrency: 'usd',
    interval: '1d',
    fetchedAt: Date.UTC(2026, 0, 4)
  });

  assert.equal(insertResult.received, 2);
  assert.equal(insertResult.changed, 2);

  const app = createApp({ appName: 'chrono-cache-test' });
  app.set('db', db);

  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const historyResponse = await fetch(`${baseUrl}/api/v1/history/btc?interval=1d&from=2026-01-01&to=2026-01-02`);
  const history = await historyResponse.json();

  assert.equal(historyResponse.status, 200);
  assert.equal(history.asset.id, 'btc');
  assert.equal(history.count, 2);
  assert.deepEqual(history.candles.map((candle) => candle.close), [42500, 43500]);

  const missingResponse = await fetch(`${baseUrl}/api/v1/history/not-a-real-asset`);
  const missingBody = await missingResponse.json();

  assert.equal(missingResponse.status, 404);
  assert.equal(missingBody.error.code, 'asset_not_found');
});

test('import converter handles a sample CSV fixture', () => {
  const { output, report } = convertDumpFile(FIXTURE_CSV, {
    asset: 'btc',
    symbol: 'BTC',
    vs: 'usd',
    interval: '1d',
    source: 'fixture'
  });

  assert.equal(report.detectedFormat, 'csv:columns');
  assert.equal(report.rowsSeen, 3);
  assert.equal(report.rowsConverted, 3);
  assert.equal(report.rowsSkipped, 0);
  assert.equal(output.assetId, 'btc');
  assert.equal(output.candles[0].ts, Date.UTC(2026, 0, 1));
  assert.equal(output.candles[2].close, 44500);
});

test('gap detector finds missing candles', (t) => {
  const db = seedDatabase(t);
  const firstDay = Date.UTC(2026, 0, 1);
  insertCandles([
    { ts: firstDay, close: 42500 },
    { ts: firstDay + (2 * DAY_MS), close: 44500 }
  ], {
    db,
    assetId: 'btc',
    vsCurrency: 'usd',
    interval: '1d',
    fetchedAt: Date.UTC(2026, 0, 4)
  });

  const report = getGapReport('btc', 'usd', '1d', firstDay, firstDay + (2 * DAY_MS), { db });

  assert.equal(report.expectedCount, 3);
  assert.equal(report.foundCount, 2);
  assert.equal(report.missingCount, 1);
  assert.deepEqual(report.gaps, [{
    from: firstDay + DAY_MS,
    to: firstDay + DAY_MS,
    fromIso: '2026-01-02T00:00:00.000Z',
    toIso: '2026-01-02T00:00:00.000Z',
    count: 1
  }]);
});
