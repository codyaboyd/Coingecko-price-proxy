#!/usr/bin/env node

require('dotenv').config();

const { initializeDatabase } = require('../src/db');
const { importNormalizedHistoryFile } = require('../src/services/import-service');
const { loadServerConfig } = require('../src/utils/config');
const { isMaintenanceMode } = require('../src/services/maintenance-service');

function printUsage() {
  console.log('Usage:');
  console.log('  npm run import -- ./data/imports/converted/btc-old.normalized.json --policy fill_only_missing');
  console.log('Options:');
  console.log('  --policy <policy>      skip_existing, overwrite_existing, fill_only_missing, prefer_import_if_older, prefer_coingecko_if_newer');
  console.log('  --asset <id>           Override asset id from normalized JSON.');
  console.log('  --vs <currency>        Override quote currency from normalized JSON.');
  console.log('  --interval <interval>  Override candle interval from normalized JSON.');
}

function toOptionKey(flag) {
  return flag
    .replace(/^--/, '')
    .replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function parseArgs(argv) {
  const options = {};
  let inputPath = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      return { help: true };
    }

    if (arg.startsWith('--')) {
      const key = toOptionKey(arg);
      const value = argv[index + 1];

      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} requires a value.`);
      }

      options[key] = value;
      index += 1;
      continue;
    }

    if (inputPath === null) {
      inputPath = arg;
      continue;
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  if (!inputPath) {
    throw new Error('A normalized JSON input path is required.');
  }

  return { inputPath, options };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.help) {
    printUsage();
    return;
  }

  const config = loadServerConfig();

  if (isMaintenanceMode(config)) {
    throw new Error('Maintenance mode is active; imports are paused.');
  }

  const db = initializeDatabase(config);

  try {
    const result = importNormalizedHistoryFile(parsed.inputPath, {
      db,
      policy: parsed.options.policy,
      assetId: parsed.options.asset,
      vsCurrency: parsed.options.vs,
      interval: parsed.options.interval
    });

    console.log(JSON.stringify(result, null, 2));
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  printUsage();
  process.exit(1);
}
