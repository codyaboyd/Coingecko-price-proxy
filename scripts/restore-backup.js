#!/usr/bin/env node

require('dotenv').config();

const path = require('path');

const { restoreBackup } = require('../src/services/restore-service');
const { loadServerConfig } = require('../src/utils/config');

async function main(argv = process.argv.slice(2)) {
  const [backupPath] = argv;

  if (!backupPath) {
    console.error('Usage: npm run restore -- ./data/backups/history-YYYY-MM-DD-HH-mm-ss.sqlite');
    process.exitCode = 1;
    return;
  }

  const config = loadServerConfig();
  const result = await restoreBackup(config, {
    backupPath,
    confirmation: path.basename(backupPath),
    actor: 'cli'
  });

  console.log(`Restored ${result.backupFileName} to ${result.restoredDatabasePath}.`);
  console.log(`Emergency backup: ${result.emergencyBackupPath || 'none'}.`);
  console.log(`Moved database files: ${result.movedDatabaseFiles.length}.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { main };
