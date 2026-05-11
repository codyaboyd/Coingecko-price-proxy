#!/usr/bin/env node

const { convertDumpFile } = require('../src/services/import-service');

function printUsage() {
  console.log('Usage:');
  console.log('  npm run convert -- ./data/imports/file.csv --asset btc --vs usd --interval 1d');
  console.log('Options:');
  console.log('  --asset <id>              Required asset id for output metadata.');
  console.log('  --symbol <symbol>         Optional symbol; defaults to --asset.');
  console.log('  --vs <currency>           Quote currency; defaults to usd.');
  console.log('  --interval <interval>     Candle interval; defaults to 1d.');
  console.log('  --timestamp-unit <unit>   ms, s, or auto; defaults to auto.');
  console.log('  --timezone <timezone>     utc only; defaults to utc.');
  console.log('  --source <source>         Output source; defaults to import.');
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

  return { inputPath, options };
}

function printReport(report) {
  console.error('Conversion report:');
  console.error(`  rows seen: ${report.rowsSeen}`);
  console.error(`  rows converted: ${report.rowsConverted}`);
  console.error(`  rows skipped: ${report.rowsSkipped}`);
  console.error(`  detected format: ${report.detectedFormat}`);
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.help) {
    printUsage();
    return;
  }

  const { output, report } = convertDumpFile(parsed.inputPath, parsed.options);
  printReport(report);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  printUsage();
  process.exit(1);
}
