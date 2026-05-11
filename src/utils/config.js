const path = require('path');
const { readJsonFile } = require('./files');

function loadServerConfig() {
  const configPath = path.resolve(process.cwd(), 'config/server.json');
  const fileConfig = readJsonFile(configPath);

  return {
    host: process.env.HOST || fileConfig.host || '127.0.0.1',
    port: Number(process.env.PORT || fileConfig.port || 3000),
    adminTitle: process.env.ADMIN_TITLE || fileConfig.adminTitle || 'Chrono Cache Admin',
    databasePath: process.env.DATABASE_PATH || fileConfig.databasePath || './data/chrono-cache.sqlite',
    assetsConfigPath: fileConfig.assetsConfigPath || './config/assets.json'
  };
}

module.exports = { loadServerConfig };
