const { normalizeMarketChartRange } = require('../src/services/history-normalizer');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message} Expected ${expected}, received ${actual}.`);
  }
}

function main() {
  const fixture = {
    prices: [
      [Date.UTC(2024, 0, 1, 0, 0), 100],
      [Date.UTC(2024, 0, 1, 0, 1), 103],
      [Date.UTC(2024, 0, 1, 0, 4), 99],
      [Date.UTC(2024, 0, 1, 0, 5), 101],
      [Date.UTC(2024, 0, 1, 0, 7), 104],
      [Date.UTC(2024, 0, 1, 1, 0), 110]
    ],
    market_caps: [
      [Date.UTC(2024, 0, 1, 0, 2), 1000],
      [Date.UTC(2024, 0, 1, 0, 4), 1200],
      [Date.UTC(2024, 0, 1, 0, 6), 1300],
      [Date.UTC(2024, 0, 1, 1, 3), 1500]
    ],
    total_volumes: [
      [Date.UTC(2024, 0, 1, 0, 3), 10],
      [Date.UTC(2024, 0, 1, 0, 4), 15],
      [Date.UTC(2024, 0, 1, 0, 8), 20],
      [Date.UTC(2024, 0, 1, 1, 4), 25]
    ]
  };

  const fiveMinuteCandles = normalizeMarketChartRange(fixture, {
    assetId: 'btc',
    vsCurrency: 'usd',
    interval: '5m'
  });

  assertEqual(fiveMinuteCandles.length, 3, 'Expected three five-minute candles.');
  assertEqual(fiveMinuteCandles[0].ts, Date.UTC(2024, 0, 1, 0, 0), 'Expected first bucket timestamp.');
  assertEqual(fiveMinuteCandles[0].open, 100, 'Expected open from first price in bucket.');
  assertEqual(fiveMinuteCandles[0].high, 103, 'Expected high from max price in bucket.');
  assertEqual(fiveMinuteCandles[0].low, 99, 'Expected low from min price in bucket.');
  assertEqual(fiveMinuteCandles[0].close, 99, 'Expected close from last price in bucket.');
  assertEqual(fiveMinuteCandles[0].volume, 15, 'Expected volume from last volume in bucket.');
  assertEqual(fiveMinuteCandles[0].marketCap, 1200, 'Expected market cap from last market cap in bucket.');
  assertEqual(fiveMinuteCandles[0].source, 'coingecko', 'Expected coingecko source.');
  assertEqual(fiveMinuteCandles[0].quality, 'derived', 'Expected derived quality.');
  assertEqual(fiveMinuteCandles[0].assetId, 'btc', 'Expected normalized asset id.');
  assertEqual(fiveMinuteCandles[0].vsCurrency, 'usd', 'Expected normalized vs currency.');
  assertEqual(fiveMinuteCandles[0].interval, '5m', 'Expected interval on candle.');

  const hourlyCandles = normalizeMarketChartRange(fixture, { interval: '1h' });
  assertEqual(hourlyCandles.length, 2, 'Expected two hourly candles.');
  assertEqual(hourlyCandles[0].open, 100, 'Expected hourly open from first price.');
  assertEqual(hourlyCandles[0].high, 104, 'Expected hourly high from max price.');
  assertEqual(hourlyCandles[0].low, 99, 'Expected hourly low from min price.');
  assertEqual(hourlyCandles[0].close, 104, 'Expected hourly close from last price.');
  assertEqual(hourlyCandles[0].volume, 20, 'Expected hourly volume from last volume.');
  assertEqual(hourlyCandles[0].marketCap, 1300, 'Expected hourly market cap from last market cap.');

  const dailyCandles = normalizeMarketChartRange(fixture, { interval: '1d' });
  assertEqual(dailyCandles.length, 1, 'Expected one daily candle.');
  assertEqual(dailyCandles[0].close, 110, 'Expected daily close from final price.');
  assertEqual(dailyCandles[0].volume, 25, 'Expected daily volume from final volume.');
  assertEqual(dailyCandles[0].marketCap, 1500, 'Expected daily market cap from final market cap.');

  assert(Array.isArray(normalizeMarketChartRange({ prices: [] }, { interval: '5m' })), 'Expected empty price series to normalize.');

  console.log('History normalizer verification passed.');
  console.log('Example normalized candle:');
  console.log(JSON.stringify(fiveMinuteCandles[0], null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
