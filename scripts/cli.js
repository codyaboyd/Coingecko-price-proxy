#!/usr/bin/env node

require('dotenv').config();

const { fetchMarketChartRange } = require('../src/services/coingecko');

function printUsage() {
  console.log('Usage:');
  console.log('  scripts/cli.js cg-test <coingecko-id> <vs-currency>');
  console.log('  npm run cg:test -- <coingecko-id> <vs-currency>');
}

function getPointCount(value) {
  return Array.isArray(value) ? value.length : 0;
}

async function runCoinGeckoTest(args) {
  const [coingeckoId, vsCurrency] = args;

  if (!coingeckoId || !vsCurrency) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const toMs = Date.now();
  const fromMs = toMs - (60 * 60 * 1000);
  const result = await fetchMarketChartRange(coingeckoId, vsCurrency, fromMs, toMs);

  console.log(`CoinGecko market chart range for ${coingeckoId}/${vsCurrency}`);
  console.log(`Range: ${new Date(fromMs).toISOString()} to ${new Date(toMs).toISOString()}`);
  console.log(`prices: ${getPointCount(result.prices)}`);
  console.log(`market_caps: ${getPointCount(result.market_caps)}`);
  console.log(`total_volumes: ${getPointCount(result.total_volumes)}`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (command === 'cg-test') {
    await runCoinGeckoTest(args);
    return;
  }

  printUsage();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
