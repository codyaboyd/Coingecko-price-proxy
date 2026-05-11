const { loadAssets } = require('../services/asset-service');
const { runMigrations } = require('./migrations');
const { openDatabase } = require('./node-sqlite');
const { upsertAssets } = require('./queries');

function isAutoMigrationDisabled() {
  const disabled = String(process.env.DISABLE_AUTO_MIGRATE || '').toLowerCase();
  const autoMigrate = String(process.env.AUTO_MIGRATE || 'true').toLowerCase();

  return ['true', '1', 'yes'].includes(disabled) || ['false', '0', 'no'].includes(autoMigrate);
}

function initializeDatabase(config, options = {}) {
  const db = openDatabase(config.databasePath);
  const shouldRunMigrations = options.runMigrations !== false && !isAutoMigrationDisabled();

  if (shouldRunMigrations) {
    runMigrations(db);
  }

  if (options.syncAssets !== false) {
    const assets = loadAssets(config.assetsConfigPath);
    upsertAssets(db, assets);
  }

  return db;
}

module.exports = {
  initializeDatabase,
  openDatabase,
  runMigrations,
  upsertAssets
};
