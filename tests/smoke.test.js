const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const { createApp } = require('../src/app');
const { runMigrations, MIGRATIONS } = require('../src/db/migrations');
const { openDatabase } = require('../src/db/node-sqlite');
const { getPublicAsset, listPublicAssets, upsertAssets } = require('../src/db/queries');
const { adminEventsToCsv, insertAdminEvent, listAdminEvents } = require('../src/services/admin-activity-service');
const { createAlert, listAlerts, updateAlertStatus } = require('../src/services/alert-service');
const { getGapReport } = require('../src/services/cache-policy');
const { getAssetStaleness, STALENESS_RULES } = require('../src/services/staleness-service');
const { markStuckFetchRunsFailed, runDatabaseIntegrityCheck } = require('../src/services/db-integrity-service');
const { insertCandles } = require('../src/services/history-service');
const { convertDumpFile, listImportFiles, registerImportFile, updateImportFile } = require('../src/services/import-service');
const { validateAssetsFile } = require('../src/services/asset-service');
const { loadServerConfig } = require('../src/utils/config');
const { createScheduler } = require('../src/jobs/scheduler');
const { buildAdminDoctorReport } = require('../src/services/admin-doctor-service');
const { clearLogFile, listLogFiles, readLatestLogLines, resolveLogFile, writeLog } = require('../src/services/log-service');
const { createCleanupService } = require('../src/services/cleanup-service');

const DAY_MS = 24 * 60 * 60 * 1000;
const FIXTURE_CSV = path.join(process.cwd(), 'test-fixtures', 'sample-history.csv');
const SAMPLE_OHLCV_CSV = path.join(process.cwd(), 'test-fixtures', 'imports', 'sample-ohlcv.csv');
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


test('log service rotates, filters, clears, and rejects unsafe paths', (t) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrono-cache-logs-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));

  writeLog('server.log', 'alpha first line', { logDir, maxBytes: 40, maxFiles: 2 });
  writeLog('server.log', 'beta second line', { logDir, maxBytes: 40, maxFiles: 2 });
  writeLog('server.log', 'alpha third line forces rotation', { logDir, maxBytes: 40, maxFiles: 2 });

  const files = listLogFiles({ logDir }).map((file) => file.name);
  assert.ok(files.includes('server.log'));
  assert.ok(files.includes('server.log.1'));
  assert.deepEqual(readLatestLogLines('server.log.1', { logDir, lines: 5, filter: 'alpha' }), ['alpha first line', 'alpha third line forces rotation']);

  assert.throws(() => resolveLogFile('../server.log', { logDir }), /Invalid log file/);
  assert.throws(() => clearLogFile('server.log', 'NOPE', { logDir }), /Type CLEAR/);
  clearLogFile('server.log', 'CLEAR', { logDir });
  assert.deepEqual(readLatestLogLines('server.log', { logDir }), []);
});


test('cleanup service prunes operational data without deleting candle history', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrono-cache-cleanup-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const db = openDatabase(path.join(tempDir, 'history.sqlite'));
  t.after(() => db.close());
  runMigrations(db);
  upsertAssets(db, TEST_ASSETS, Date.UTC(2026, 0, 1));

  const now = Date.UTC(2026, 0, 20);
  insertCandles([
    { ts: Date.UTC(2026, 0, 1), open: 1, high: 2, low: 1, close: 2, volume: 10 }
  ], { db, assetId: 'btc', vsCurrency: 'usd', interval: '1d', fetchedAt: now });
  db.prepare(`
    INSERT INTO api_cache (cache_key, response_json, status_code, expires_at, created_at, updated_at)
    VALUES ('expired', '{}', 200, @expiresAt, @createdAt, @createdAt)
  `).run({ expiresAt: now - DAY_MS, createdAt: now - (2 * DAY_MS) });
  db.prepare(`
    INSERT INTO jobs (type, payload_json, priority, status, attempts, max_attempts, run_after, created_at, updated_at)
    VALUES ('noop', '{}', 100, 'completed', 1, 3, @createdAt, @createdAt, @updatedAt)
  `).run({ createdAt: now - (20 * DAY_MS), updatedAt: now - (15 * DAY_MS) });

  const importsDir = path.join(tempDir, 'imports');
  fs.mkdirSync(importsDir, { recursive: true });
  const importPath = path.join(importsDir, 'done.csv');
  fs.writeFileSync(importPath, 'ts,close\n2026-01-01,2\n');
  const importFile = registerImportFile(db, importPath, { now: now - DAY_MS });
  updateImportFile(db, importFile.id, { status: 'imported', rowsImported: 1, updatedAt: now - DAY_MS });

  const service = createCleanupService({ db, config: { dataDir: tempDir, logDir: path.join(tempDir, 'logs') } });
  const result = service.run({ now });

  assert.equal(result.status, 'completed');
  assert.equal(result.summary.apiCache.rowsDeleted, 1);
  assert.equal(result.summary.completedJobs.rowsDeleted, 1);
  assert.equal(result.summary.importedFiles.archived, 1);
  assert.equal(result.summary.historicalCandlesDeleted, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM candles').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM api_cache').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM jobs').get().count, 0);
  assert.equal(db.prepare("SELECT status FROM import_files WHERE id = ?").get(importFile.id).status, 'archived');
});

test('import page keeps the file selector synchronized with the selected import id', () => {
  const view = fs.readFileSync(path.join(process.cwd(), 'views', 'admin-imports.ejs'), 'utf8');
  const script = fs.readFileSync(path.join(process.cwd(), 'public', 'js', 'admin-imports.js'), 'utf8');

  assert.match(view, /data-import-form/);
  assert.match(view, /data-preview-on-change="true"/);
  assert.match(view, /data-import-file-id="<%= file\.id %>"/);
  assert.match(view, /data-import-upload-form/);
  assert.match(view, /data-import-upload-button/);
  assert.match(view, /data-import-upload-name/);
  assert.match(script, /syncSelectedImportFileId/);
  assert.match(script, /window\.location\.assign/);
  assert.match(script, /fileInput\.click/);
  assert.match(script, /fileNameInput\.value = selectedFile \? selectedFile\.name : ''/);
});


test('admin views share the complete admin navigation partial', () => {
  const adminViewDirectory = path.join(process.cwd(), 'views');
  const excludedViews = new Set([
    'admin-alert-bell.ejs',
    'admin-login.ejs',
    'admin-maintenance-banner.ejs',
    'admin-nav.ejs'
  ]);
  const adminViews = fs.readdirSync(adminViewDirectory)
    .filter((fileName) => fileName.startsWith('admin') && fileName.endsWith('.ejs') && !excludedViews.has(fileName));

  assert.ok(adminViews.length > 0);
  adminViews.forEach((fileName) => {
    const view = fs.readFileSync(path.join(adminViewDirectory, fileName), 'utf8');
    assert.match(view, /include\('admin-nav'\)/, `${fileName} should render the shared admin navigation`);
  });

  const nav = fs.readFileSync(path.join(adminViewDirectory, 'admin-nav.ejs'), 'utf8');
  [
    'Dashboard',
    'Settings',
    'Assets',
    'Imports',
    'Backups',
    'Cleanup',
    'Activity',
    'Doctor',
    'Reload Status',
    'System Health',
    'DB Integrity',
    'Rate Budget',
    'Logs',
    'API Test',
    'Config History',
    'Runbook'
  ].forEach((label) => assert.match(nav, new RegExp(`label: '${label}'`)));
});


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
  assert.ok(tables.includes('jobs'));
  assert.ok(tables.includes('import_runs'));
  assert.ok(tables.includes('import_files'));
  assert.ok(tables.includes('config_changes'));
  assert.ok(tables.includes('admin_events'));
  assert.ok(tables.includes('alerts'));
  assert.deepEqual(versions, MIGRATIONS.map((migration) => migration.version));
});


test('admin activity events can be inserted, filtered, and exported as CSV', (t) => {
  const db = seedDatabase(t);
  insertAdminEvent(db, {
    actor: 'alice',
    action: 'manual fetch',
    entityType: 'asset',
    entityId: 'btc',
    details: { jobId: 123, range: '2026-01-01/2026-01-02' },
    ipAddress: '127.0.0.1',
    userAgent: 'node-test',
    createdAt: Date.UTC(2026, 0, 2)
  });
  insertAdminEvent(db, {
    actor: 'alice',
    action: 'config edit',
    entityType: 'config',
    entityId: 'config/assets.json',
    createdAt: Date.UTC(2026, 0, 3)
  });

  const filtered = listAdminEvents(db, {
    action: 'manual fetch',
    entityType: 'asset',
    from: '2026-01-01',
    to: '2026-01-02'
  });

  assert.equal(filtered.events.length, 1);
  assert.equal(filtered.events[0].action, 'manual fetch');
  assert.equal(filtered.events[0].details.jobId, 123);

  const csv = adminEventsToCsv(filtered.events);
  assert.match(csv, /id,created_at,actor,action,entity_type,entity_id,details_json,ip_address,user_agent/);
  assert.match(csv, /manual fetch/);
  assert.match(csv, /node-test/);
});


test('alerts can be created, listed, acknowledged, and resolved', (t) => {
  const db = seedDatabase(t);
  const alert = createAlert(db, {
    severity: 'critical',
    type: 'disk_space_low',
    title: 'Disk space low',
    message: 'Only 100MB free.',
    entityType: 'system',
    entityId: 'project_disk'
  });

  assert.equal(alert.status, 'open');
  assert.equal(listAlerts(db, { status: 'open' }).length, 1);

  const duplicate = createAlert(db, {
    severity: 'critical',
    type: 'disk_space_low',
    title: 'Disk space low',
    message: 'Still low.',
    entityType: 'system',
    entityId: 'project_disk'
  });
  assert.equal(duplicate.id, alert.id);

  const acknowledged = updateAlertStatus(db, alert.id, 'acknowledged');
  assert.equal(acknowledged.status, 'acknowledged');
  assert.ok(acknowledged.acknowledgedAt);

  const resolved = updateAlertStatus(db, alert.id, 'resolved');
  assert.equal(resolved.status, 'resolved');
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

  const from = Math.floor(firstDay / 1000);
  const to = Math.floor((firstDay + DAY_MS) / 1000);
  const marketChartResponse = await fetch(`${baseUrl}/api/v3/coins/bitcoin/market_chart/range?vs_currency=usd&from=${from}&to=${to}&interval=daily`);
  const marketChart = await marketChartResponse.json();

  assert.equal(marketChartResponse.status, 200);
  assert.deepEqual(marketChart.prices, [[firstDay, 42500], [firstDay + DAY_MS, 43500]]);
  assert.deepEqual(marketChart.market_caps, [[firstDay, 850000000000], [firstDay + DAY_MS, 870000000000]]);
  assert.deepEqual(marketChart.total_volumes, [[firstDay, 123.45], [firstDay + DAY_MS, 234.56]]);

  const chartResponse = await fetch(`${baseUrl}/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=max&interval=daily`);
  const chart = await chartResponse.json();

  assert.equal(chartResponse.status, 200);
  assert.deepEqual(chart.prices, marketChart.prices);

  const simplePriceResponse = await fetch(`${baseUrl}/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_last_updated_at=true`);
  const simplePrice = await simplePriceResponse.json();

  assert.equal(simplePriceResponse.status, 200);
  assert.equal(simplePrice.bitcoin.usd, 43500);
  assert.equal(simplePrice.bitcoin.usd_market_cap, 870000000000);
  assert.equal(simplePrice.bitcoin.usd_24h_vol, 234.56);
  assert.equal(simplePrice.bitcoin.last_updated_at, to);
});



test('local API docs render and OpenAPI JSON uses current assets', async (t) => {
  const db = seedDatabase(t);
  const app = createApp({ appName: 'chrono-cache-test' });
  app.set('db', db);
  app.set('assets', TEST_ASSETS);

  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const docsResponse = await fetch(`${baseUrl}/docs`);
  const docsHtml = await docsResponse.text();
  const openApiResponse = await fetch(`${baseUrl}/api/v1/openapi.json`);
  const openApi = await openApiResponse.json();

  assert.equal(docsResponse.status, 200);
  assert.match(docsHtml, /Local API Docs/);
  assert.match(docsHtml, /api\/v1\/history\/:assetId/);
  assert.match(docsHtml, /Copy/);
  assert.equal(openApiResponse.status, 200);
  assert.equal(openApi.openapi, '3.0.3');
  assert.equal(openApi.paths['/assets/{assetId}'].get.parameters[0].example, 'btc');
  assert.equal(openApi.paths['/assets'].get.responses[200].content['application/json'].example.assets[0].id, 'btc');
});


test('asset sync hides disabled and removed assets from public API lookups', (t) => {
  const db = createTempDatabase(t);
  runMigrations(db);

  upsertAssets(db, [
    TEST_ASSETS[0],
    {
      id: 'paused',
      symbol: 'PAUSE',
      name: 'Paused Asset',
      coingeckoId: 'bitcoin',
      vsCurrency: 'usd',
      enabled: false,
      priority: 20
    }
  ], Date.UTC(2026, 0, 1));

  assert.deepEqual(listPublicAssets(db).map((asset) => asset.id), ['btc']);
  assert.equal(getPublicAsset(db, 'paused'), null);

  upsertAssets(db, [], Date.UTC(2026, 0, 2));

  assert.deepEqual(listPublicAssets(db), []);
  assert.equal(getPublicAsset(db, 'btc'), null);
});

test('convert CLI writes normalized JSON with --output', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrono-cache-convert-cli-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const outputPath = path.join(tempDir, 'sample.normalized.json');

  execFileSync(process.execPath, [
    'scripts/convert.js',
    FIXTURE_CSV,
    '--asset', 'btc',
    '--symbol', 'BTC',
    '--vs', 'usd',
    '--interval', '1d',
    '--output', outputPath
  ], { cwd: process.cwd(), encoding: 'utf8' });

  const normalized = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(normalized.assetId, 'btc');
  assert.equal(normalized.candles.length, 3);
  assert.equal(normalized.candles[0].close, 42500);
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



test('history import accepts one-minute candles', (t) => {
  const db = seedDatabase(t);
  const baseTs = Date.UTC(2026, 0, 1, 0, 0, 0);

  const result = insertCandles([
    { ts: baseTs, open: 100, high: 101, low: 99, close: 100.5, volume: 10, marketCap: 1000 },
    { ts: baseTs + 60_000, open: 100.5, high: 102, low: 100, close: 101.5, volume: 11, marketCap: 1010 }
  ], {
    db,
    assetId: 'btc',
    vsCurrency: 'usd',
    interval: '1m',
    fetchedAt: baseTs
  });

  assert.equal(result.received, 2);
  assert.equal(result.changed, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM candles WHERE interval = '1m'").get().count, 2);

  const gapReport = getGapReport('btc', 'usd', '1m', baseTs, baseTs + (2 * 60_000), { db });
  assert.equal(gapReport.expectedCount, 3);
  assert.equal(gapReport.foundCount, 2);
  assert.equal(gapReport.missingCount, 1);
});

test('built-in offline sample fixtures seed history, gaps, and admin health', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrono-cache-sample-seed-'));
  const databasePath = path.join(tempDir, 'history.sqlite');

  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const sampleCsv = convertDumpFile(SAMPLE_OHLCV_CSV, {
    asset: 'btc',
    symbol: 'BTC',
    vs: 'usd',
    interval: '1d',
    source: 'sample-fixture'
  });

  assert.equal(sampleCsv.report.detectedFormat, 'csv:columns');
  assert.equal(sampleCsv.report.rowsSeen, 3);
  assert.equal(sampleCsv.output.candles[2].ts, Date.UTC(2026, 0, 4));

  const seedOutput = execFileSync('npm', ['--silent', 'run', 'seed:sample'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_PATH: databasePath
    },
    encoding: 'utf8'
  });
  const seedResult = JSON.parse(seedOutput);

  assert.equal(seedResult.ok, true);
  assert.equal(seedResult.result.rowsImported, 3);
  assert.equal(seedResult.result.detectedFormat, 'normalized-json:sample-fixture');

  const db = openDatabase(databasePath);
  t.after(() => db.close());

  const importedRows = db.prepare('SELECT COUNT(*) AS count FROM candles WHERE asset_id = ?').get('btc');
  assert.equal(importedRows.count, 3);

  const app = createApp({
    appName: 'chrono-cache-test',
    adminTitle: 'chrono-cache-test',
    databasePath,
    dataDir: tempDir,
    assetsConfigPath: path.join(tempDir, 'missing-assets.json'),
    adminAuth: {
      username: 'admin',
      password: 'password',
      sessionSecret: 'sample-smoke-secret'
    }
  });
  app.set('db', db);
  app.set('assets', TEST_ASSETS);

  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const historyResponse = await fetch(`${baseUrl}/api/v1/history/btc?interval=1d&from=2026-01-01&to=2026-01-04&cache=bypass`);
  const history = await historyResponse.json();

  assert.equal(historyResponse.status, 200);
  assert.equal(history.asset.id, 'btc');
  assert.equal(history.count, 3);
  assert.deepEqual(history.candles.map((candle) => candle.ts), [
    Date.UTC(2026, 0, 1),
    Date.UTC(2026, 0, 2),
    Date.UTC(2026, 0, 4)
  ]);

  const loginResponse = await fetch(`${baseUrl}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'password', returnTo: '/admin' }),
    redirect: 'manual'
  });
  const sessionCookie = loginResponse.headers.get('set-cookie').split(';')[0];

  assert.equal(loginResponse.status, 302);
  assert.ok(sessionCookie.includes('chrono_cache_admin_session='));

  const gapResponse = await fetch(`${baseUrl}/api/v1/admin/assets/btc/gaps?interval=1d&from=2026-01-01&to=2026-01-04`, {
    headers: { cookie: sessionCookie }
  });
  const gapReport = await gapResponse.json();

  assert.equal(gapResponse.status, 200);
  assert.equal(gapReport.gaps.length, 1);
  assert.equal(gapReport.gaps[0].from, Date.UTC(2026, 0, 3));

  const healthResponse = await fetch(`${baseUrl}/api/v1/admin/system-health`, {
    headers: { cookie: sessionCookie }
  });
  const health = await healthResponse.json();

  assert.equal(healthResponse.status, 200);
  assert.ok(['ok', 'degraded', 'critical'].includes(health.status));
  assert.ok(Array.isArray(health.checks));
  assert.ok(health.checks.some((check) => check.id === 'database_file_size'));

  const resetOutput = execFileSync('npm', ['--silent', 'run', 'reset:sample'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_PATH: databasePath
    },
    encoding: 'utf8'
  });
  const resetResult = JSON.parse(resetOutput);

  assert.equal(resetResult.ok, true);
  assert.equal(resetResult.deletedCandles, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM candles WHERE asset_id = ?').get('btc').count, 0);
});



test('converter supports native Unix OHLCV 60s CSV format', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrono-cache-native-ohlcv-'));
  const importPath = path.join(tempDir, 'btc-1m.csv');

  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  fs.writeFileSync(importPath, [
    'Timestamp,Open,High,Low,Close,Volume',
    '1704067200,42280.12,42300.50,42190.00,42295.25,12.345',
    '1704067260,42295.25,42410.00,42280.00,42350.75,8.5'
  ].join('\n'));

  const { output, report } = convertDumpFile(importPath, {
    assetId: 'btc',
    vsCurrency: 'usd',
    inputFormat: 'unix-ohlcv-60s'
  });

  assert.equal(report.detectedFormat, 'csv:unix-ohlcv-60s');
  assert.equal(output.interval, '1m');
  assert.equal(output.source, 'unix-ohlcv-60s');
  assert.deepEqual(output.candles.map((candle) => candle.ts), [1704067200000, 1704067260000]);
  assert.deepEqual(output.candles.map((candle) => candle.volume), [12.345, 8.5]);
  assert.equal(output.candles[0].open, 42280.12);
  assert.equal(output.candles[1].close, 42350.75);
});

test('import inbox registers file hashes once and tracks states', (t) => {
  const db = seedDatabase(t);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrono-cache-import-inbox-'));
  const importPath = path.join(tempDir, 'sample.csv');

  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  fs.writeFileSync(importPath, 'time,close\n2026-01-01,42000\n');

  const first = registerImportFile(db, importPath, { filename: 'sample.csv', now: Date.UTC(2026, 0, 1) });
  const duplicate = registerImportFile(db, importPath, { filename: 'copy.csv', now: Date.UTC(2026, 0, 2) });

  assert.equal(first.id, duplicate.id);
  assert.equal(listImportFiles(db).length, 1);
  assert.equal(first.status, 'pending');
  assert.equal(first.fileHash.length, 64);

  const imported = updateImportFile(db, first.id, {
    status: 'imported',
    detectedFormat: 'csv:columns',
    assetId: 'btc',
    interval: '1d',
    rowsSeen: 1,
    rowsImported: 1
  });

  assert.equal(imported.status, 'imported');
  assert.equal(imported.detectedFormat, 'csv:columns');
  assert.equal(imported.rowsSeen, 1);
  assert.equal(imported.rowsImported, 1);
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


test('staleness service classifies fresh, stale, empty, fetching, and failed intervals', (t) => {
  const db = seedDatabase(t);
  const now = Date.UTC(2026, 0, 2, 12, 0, 0);
  const asset = {
    ...TEST_ASSETS[0],
    fetchPolicy: {
      intervals: ['5m'],
      dailyBackfill: true
    }
  };

  insertCandles([
    { ts: now - (10 * 60 * 1000), close: 42500 }
  ], {
    db,
    assetId: 'btc',
    vsCurrency: 'usd',
    interval: '5m',
    fetchedAt: now - (5 * 60 * 1000)
  });
  insertCandles([
    { ts: now - (4 * 60 * 60 * 1000), close: 42500 }
  ], {
    db,
    assetId: 'btc',
    vsCurrency: 'usd',
    interval: '1h',
    fetchedAt: now - (3 * 60 * 60 * 1000)
  });

  const staleness = getAssetStaleness(db, asset, { now });
  const byInterval = Object.fromEntries(staleness.intervals.map((intervalStatus) => [intervalStatus.interval, intervalStatus]));

  assert.equal(STALENESS_RULES['5m'], 30 * 60 * 1000);
  assert.equal(STALENESS_RULES['1h'], 3 * 60 * 60 * 1000);
  assert.equal(STALENESS_RULES['1d'], 36 * 60 * 60 * 1000);
  assert.equal(byInterval['5m'].status, 'fresh');
  assert.equal(byInterval['1h'].status, 'stale');
  assert.equal(byInterval['1d'].status, 'empty');

  const fetching = getAssetStaleness(db, asset, {
    now,
    jobScheduler: {
      hasPendingJob(predicate) {
        return predicate({ type: 'recent_refresh', payload: { assetId: 'btc', interval: '1h' } });
      }
    }
  });
  assert.equal(fetching.intervals.find((intervalStatus) => intervalStatus.interval === '1h').status, 'fetching');

  const insertRun = db.prepare(`
    INSERT INTO fetch_runs (asset_id, vs_currency, interval, started_at, ended_at, status, candles_fetched, error_message, range_from, range_to, source, points_inserted, error, finished_at)
    VALUES ('btc', 'usd', '1h', @at, @at, 'failed', 0, 'boom', @fromTs, @toTs, 'coingecko', 0, 'boom', @at)
  `);
  [1, 2, 3].forEach((index) => insertRun.run({ at: now - (index * 1000), fromTs: now - 10000, toTs: now }));

  const failed = getAssetStaleness(db, asset, { now });
  const failedInterval = failed.intervals.find((intervalStatus) => intervalStatus.interval === '1h');
  assert.equal(failedInterval.status, 'failed');
  assert.equal(failedInterval.lastError, 'boom');
  assert.equal(failedInterval.failure.inCooldown, true);
});

test('history API rejects invalid dates and excessive client request rates', async (t) => {
  const previousMax = process.env.API_RATE_LIMIT_MAX;
  const previousWindow = process.env.API_RATE_LIMIT_WINDOW_MS;
  process.env.API_RATE_LIMIT_MAX = '2';
  process.env.API_RATE_LIMIT_WINDOW_MS = '60000';

  t.after(() => {
    if (previousMax === undefined) {
      delete process.env.API_RATE_LIMIT_MAX;
    } else {
      process.env.API_RATE_LIMIT_MAX = previousMax;
    }

    if (previousWindow === undefined) {
      delete process.env.API_RATE_LIMIT_WINDOW_MS;
    } else {
      process.env.API_RATE_LIMIT_WINDOW_MS = previousWindow;
    }
  });

  const db = seedDatabase(t);
  const app = createApp({ appName: 'chrono-cache-test' });
  app.set('db', db);

  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const invalidDateResponse = await fetch(`${baseUrl}/api/v1/history/btc?from=2026-02-30&to=2026-03-01`);
  const invalidDateBody = await invalidDateResponse.json();

  assert.equal(invalidDateResponse.status, 400);
  assert.equal(invalidDateBody.error.code, 'invalid_from');

  const okResponse = await fetch(`${baseUrl}/api/v1/assets`);
  const limitedResponse = await fetch(`${baseUrl}/api/v1/assets`);
  const limitedBody = await limitedResponse.json();

  assert.equal(okResponse.status, 200);
  assert.equal(limitedResponse.status, 429);
  assert.equal(limitedBody.error.code, 'rate_limited');
  assert.ok(Number(limitedResponse.headers.get('retry-after')) >= 1);
});

test('system health builder reports dashboard checks', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrono-cache-health-'));
  const databasePath = path.join(tempDir, 'history.sqlite');
  const assetsConfigPath = path.join(tempDir, 'assets.json');
  const dataDir = path.join(tempDir, 'data');
  const db = openDatabase(databasePath);

  t.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(assetsConfigPath, `${JSON.stringify({ assets: TEST_ASSETS }, null, 2)}\n`);
  runMigrations(db);
  upsertAssets(db, TEST_ASSETS, Date.UTC(2026, 0, 1));

  const app = createApp({
    appName: 'chrono-cache-test',
    adminTitle: 'chrono-cache-test',
    databasePath,
    assetsConfigPath,
    dataDir
  });
  app.set('db', db);
  app.set('assets', TEST_ASSETS);

  const { buildSystemHealth } = require('../src/services/system-health');
  const health = buildSystemHealth(app, { now: Date.UTC(2026, 0, 5) });
  const checkIds = health.checks.map((check) => check.id);

  assert.equal(health.app.version, '0.1.0');
  assert.ok(['ok', 'warning', 'degraded', 'critical'].includes(health.status));
  assert.ok(checkIds.includes('server_uptime'));
  assert.ok(checkIds.includes('database_reachable'));
  assert.ok(checkIds.includes('coingecko_rate_limited'));
  assert.ok(checkIds.includes('latest_successful_fetch_per_asset'));
  assert.ok(checkIds.includes('latest_backup_time'));
  assert.equal(health.checks.find((check) => check.id === 'enabled_assets').value, 1);
  assert.equal(health.checks.find((check) => check.id === 'assets_config_valid').status, 'ok');
});

test('system health reports startup degraded mode', (t) => {
  const db = seedDatabase(t);
  insertCandles([
    { ts: Date.UTC(2026, 0, 4), close: 42500 }
  ], {
    db,
    assetId: 'btc',
    vsCurrency: 'usd',
    interval: '1d',
    fetchedAt: Date.UTC(2026, 0, 4)
  });
  db.prepare(`
    INSERT INTO fetch_runs (asset_id, vs_currency, interval, started_at, status, finished_at)
    VALUES ('btc', 'usd', '1d', @now, 'success', @now)
  `).run({ now: Date.UTC(2026, 0, 4) });
  const app = createApp({
    appName: 'chrono-cache-test',
    adminTitle: 'chrono-cache-test',
    databasePath: ':memory:',
    assetsConfigPath: './config/assets.json',
    dataDir: './data'
  });
  app.set('db', db);
  app.set('assets', TEST_ASSETS);
  app.set('startupSelfCheck', {
    degraded: true,
    status: 'degraded',
    generatedAtIso: '2026-01-05T00:00:00.000Z',
    checks: [
      {
        id: 'backup_directory_writable',
        label: 'Backup directory is writable',
        severity: 'non-critical',
        ok: false,
        summary: 'Permission denied',
        details: { path: '/not-writable' }
      }
    ]
  });

  const { buildSystemHealth } = require('../src/services/system-health');
  const health = buildSystemHealth(app, { now: Date.UTC(2026, 0, 5) });

  assert.equal(health.status, 'degraded');
  assert.equal(health.degraded, true);
  assert.equal(health.checks.find((check) => check.id === 'startup_mode').summary, 'Degraded mode');
  assert.equal(health.checks.find((check) => check.id === 'startup_backup_directory_writable').status, 'warning');
});

test('durable scheduler recovers stale running jobs on startup', (t) => {
  const db = seedDatabase(t);
  const oldLockedAt = Date.now() - (31 * 60 * 1000);
  const insertJob = db.prepare(`
    INSERT INTO jobs (type, payload_json, priority, status, attempts, max_attempts, run_after, locked_at, locked_by, created_at, updated_at, last_error)
    VALUES (@type, @payloadJson, 1, 'running', @attempts, @maxAttempts, @runAfter, @lockedAt, 'old-worker', @createdAt, @updatedAt, NULL)
  `);

  const retryable = insertJob.run({
    type: 'manual_admin_fetch',
    payloadJson: JSON.stringify({ assetId: 'btc' }),
    attempts: 1,
    maxAttempts: 3,
    runAfter: oldLockedAt,
    lockedAt: oldLockedAt,
    createdAt: oldLockedAt,
    updatedAt: oldLockedAt
  }).lastInsertRowid;
  const exhausted = insertJob.run({
    type: 'manual_admin_fetch',
    payloadJson: JSON.stringify({ assetId: 'btc' }),
    attempts: 3,
    maxAttempts: 3,
    runAfter: oldLockedAt,
    lockedAt: oldLockedAt,
    createdAt: oldLockedAt,
    updatedAt: oldLockedAt
  }).lastInsertRowid;

  const scheduler = createScheduler({ db });

  const retryableJob = scheduler.getJob(retryable);
  const exhaustedJob = scheduler.getJob(exhausted);
  assert.equal(retryableJob.status, 'queued');
  assert.equal(retryableJob.lockedAt, null);
  assert.equal(exhaustedJob.status, 'failed');
  assert.equal(exhaustedJob.lockedAt, null);
});



test('database integrity service reports clean migrated data and can mark stuck fetch runs failed', (t) => {
  const db = seedDatabase(t);
  const now = Date.UTC(2026, 0, 2, 12, 0, 0);

  insertCandles([
    { ts: now - DAY_MS, open: 42000, high: 43000, low: 41000, close: 42500 }
  ], {
    db,
    assetId: 'btc',
    vsCurrency: 'usd',
    interval: '1d',
    fetchedAt: now
  });

  const cleanReport = runDatabaseIntegrityCheck(db, { now });
  const primaryKeyCheck = cleanReport.checks.find((check) => check.id === 'duplicate_candles_impossible');

  assert.equal(primaryKeyCheck.status, 'ok');
  assert.equal(cleanReport.summary.critical, 0);

  const stuckRunId = db.prepare(`
    INSERT INTO fetch_runs (asset_id, vs_currency, interval, started_at, status, source)
    VALUES ('btc', 'usd', '1d', @startedAt, 'running', 'test')
  `).run({ startedAt: now - (2 * 60 * 60 * 1000) }).lastInsertRowid;

  const stuckReport = runDatabaseIntegrityCheck(db, { now });
  const stuckCheck = stuckReport.checks.find((check) => check.id === 'fetch_runs_stuck_running');

  assert.equal(stuckCheck.status, 'warning');
  assert.equal(stuckCheck.details.length, 1);
  assert.equal(stuckCheck.details[0].id, stuckRunId);

  const repairResult = markStuckFetchRunsFailed(db, { now });
  const repairedRun = db.prepare('SELECT status, finished_at, error FROM fetch_runs WHERE id = ?').get(stuckRunId);

  assert.equal(repairResult.changed, 1);
  assert.equal(repairedRun.status, 'failed');
  assert.equal(repairedRun.finished_at, now);
  assert.equal(repairedRun.error, 'Marked failed by database integrity check');
});


test('admin doctor report includes maintenance checks and safe fixes', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrono-cache-doctor-'));
  const databasePath = path.join(tempDir, 'history.sqlite');
  const assetsConfigPath = path.join(tempDir, 'assets.json');
  const dataDir = path.join(tempDir, 'data');
  const db = openDatabase(databasePath);

  t.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  fs.mkdirSync(path.join(dataDir, 'imports'), { recursive: true });
  fs.writeFileSync(assetsConfigPath, `${JSON.stringify({ assets: TEST_ASSETS }, null, 2)}\n`);
  fs.writeFileSync(path.join(dataDir, 'imports', 'pending.csv'), 'time,open,high,low,close\n');
  runMigrations(db);
  upsertAssets(db, TEST_ASSETS, Date.UTC(2026, 0, 1));

  const now = Date.UTC(2026, 0, 5);
  db.prepare(`
    INSERT INTO jobs (type, payload_json, priority, status, attempts, max_attempts, run_after, locked_at, locked_by, created_at, updated_at, last_error)
    VALUES ('recent_refresh', '{"assetId":"btc"}', 3, 'failed', 3, 3, @now, NULL, NULL, @now, @now, 'boom')
  `).run({ now });

  const app = createApp({
    appName: 'chrono-cache-test',
    adminTitle: 'chrono-cache-test',
    databasePath,
    assetsConfigPath,
    dataDir
  });
  app.set('db', db);
  app.set('assets', TEST_ASSETS);

  const scheduler = createScheduler({ db, config: app.get('config') });
  const report = buildAdminDoctorReport({
    app,
    db,
    config: app.get('config'),
    assets: TEST_ASSETS,
    scheduler,
    recentRefreshScheduler: { getStatus: () => ({ enabled: true, paused: true }) },
    backupService: { listBackups: () => [] },
    now
  });
  const issueById = Object.fromEntries(report.issues.map((issue) => [issue.id, issue]));

  assert.ok(report.issues.length >= 9);
  assert.equal(issueById.self_check_ok.severity, 'ok');
  assert.equal(issueById.failed_job_detection.severity, 'warning');
  assert.equal(issueById.backup_freshness.severity, 'critical');
  assert.equal(issueById.import_folder_scan.severity, 'info');
  assert.ok(issueById.failed_job_detection.safeFixes.some((fix) => fix.action === 'retry-failed-jobs'));
  assert.ok(issueById.backup_freshness.safeFixes.some((fix) => fix.action === 'create-backup'));
  assert.ok(report.cleanupFixes.some((fix) => fix.action === 'clear-completed-jobs'));
});
