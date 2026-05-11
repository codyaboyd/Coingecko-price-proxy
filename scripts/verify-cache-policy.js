const Database = require('better-sqlite3');
const { runMigrations } = require('../src/db/migrations');
const { upsertAssets } = require('../src/db/queries');
const { insertCandles } = require('../src/services/history-service');
const { getExpectedTimestamps, getGapReport, getMissingWindows } = require('../src/services/cache-policy');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function createTestDatabase() {
  const db = new Database(':memory:');
  runMigrations(db);
  upsertAssets(db, [{
    id: 'bitcoin',
    symbol: 'BTC',
    name: 'Bitcoin',
    coingeckoId: 'bitcoin',
    vsCurrency: 'usd',
    enabled: true,
    priority: 1
  }], 1);
  return db;
}

function verifyHourlyGaps() {
  const db = createTestDatabase();
  const start = Date.UTC(2024, 0, 1, 0, 0, 0, 0);
  const hour = 60 * 60 * 1000;

  insertCandles([
    { ts: start, close: 1 },
    { ts: start + hour, close: 2 },
    { ts: start + (3 * hour), close: 4 }
  ], { db, assetId: 'bitcoin', vsCurrency: 'usd', interval: '1h' });

  const expected = Array.from(getExpectedTimestamps('1h', start + 1, start + (3 * hour) + 1));
  assert(expected.length === 4, '1h expected timestamp count should include boundary buckets.');
  assert(expected[0] === start, '1h expected timestamps should floor fromMs to the UTC hour.');
  assert(expected[3] === start + (3 * hour), '1h expected timestamps should floor toMs to the UTC hour.');

  const report = getGapReport('bitcoin', 'usd', '1h', start + 1, start + (3 * hour) + 1, { db });
  assert(report.expectedCount === 4, '1h report expected count mismatch.');
  assert(report.foundCount === 3, '1h report found count mismatch.');
  assert(report.missingCount === 1, '1h report missing count mismatch.');
  assert(report.gaps.length === 1, '1h report should compact adjacent missing buckets.');
  assert(report.gaps[0].from === start + (2 * hour), '1h missing gap starts at unexpected timestamp.');
  assert(getMissingWindows('bitcoin', 'usd', '1h', start, start + (3 * hour), { db }).length === 1, 'missing windows should mirror gap report ranges.');

  db.close();
}

function verifyDailyAndFiveMinuteBoundaries() {
  const dayStart = Date.UTC(2024, 0, 2, 0, 0, 0, 0);
  const fiveMinuteStart = Date.UTC(2024, 0, 2, 3, 10, 0, 0);

  assert(Array.from(getExpectedTimestamps('1d', dayStart + 1234, dayStart + 25 * 60 * 60 * 1000)).length === 2, '1d buckets should use UTC day boundaries.');
  assert(Array.from(getExpectedTimestamps('5m', fiveMinuteStart + 1, fiveMinuteStart + (10 * 60 * 1000) + 1)).join(',') === [
    fiveMinuteStart,
    fiveMinuteStart + (5 * 60 * 1000),
    fiveMinuteStart + (10 * 60 * 1000)
  ].join(','), '5m buckets should use five-minute UTC boundaries.');
}

verifyHourlyGaps();
verifyDailyAndFiveMinuteBoundaries();
console.log('cache-policy verification passed');
