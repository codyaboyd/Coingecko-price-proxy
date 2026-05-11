require('dotenv').config();

const { initializeDatabase } = require('../src/db');
const { insertCandles } = require('../src/services/history-service');
const { loadServerConfig } = require('../src/utils/config');

function buildFakeCandles(count, interval) {
  const intervalMs = interval === '5m'
    ? 5 * 60 * 1000
    : interval === '1h'
      ? 60 * 60 * 1000
      : 24 * 60 * 60 * 1000;
  const startTs = Date.UTC(2024, 0, 1, 0, 0, 0);

  return Array.from({ length: count }, (_, index) => {
    const close = 42000 + (index * 125) + Math.round(Math.sin(index / 2) * 500);
    const open = close - 75;
    const high = close + 250;
    const low = close - 300;

    return {
      ts: startTs + (index * intervalMs),
      open,
      high,
      low,
      close,
      volume: 1000 + (index * 10),
      marketCap: close * 19600000
    };
  });
}

function main() {
  const config = loadServerConfig();
  const db = initializeDatabase(config);

  try {
    const interval = process.argv[2] || '1d';
    const count = Number.parseInt(process.argv[3] || '10', 10);

    if (!Number.isInteger(count) || count < 1) {
      throw new Error('Count must be a positive integer.');
    }

    const result = insertCandles(buildFakeCandles(count, interval), {
      db,
      assetId: 'btc',
      vsCurrency: 'usd',
      interval,
      conflictPolicy: 'overwrite_existing'
    });

    console.log(`Seeded fake BTC candles into ${config.databasePath}.`);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
