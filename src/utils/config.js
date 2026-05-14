const path = require('path');
const { readJsonFile } = require('./files');
const { loadEnv } = require('./env');

const DEFAULT_COINGECKO_CONFIG = {
  maxCallsPerMinute: 8,
  safeMode: true,
  rateLimitPauseMs: 120000,
  retries: 1,
  baseBackoffMs: 3000
};

const DEFAULT_AUTOMATION_CONFIG = {
  recentEveryMinutes: 120,
  dailyBackfill: false,
  maxBackfillDaysPerRun: 3,
  enable5m: false,
  failureThreshold: 3,
  failureCooldownMinutes: 60
};

function parseConfiguredPort(value) {
  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Server port must be an integer between 1 and 65535. Received: ${value}`);
  }

  return port;
}

function normalizeObjectConfig(value, defaults) {
  return {
    ...defaults,
    ...(value && typeof value === 'object' && !Array.isArray(value) ? value : {})
  };
}

function loadServerConfig() {
  const env = loadEnv();
  const serverConfigPath = path.join(env.configDir, 'server.json');
  const fileConfig = readJsonFile(serverConfigPath);

  return {
    appName: process.env.APP_NAME || fileConfig.appName || env.appName,
    nodeEnv: env.nodeEnv,
    host: process.env.HOST || fileConfig.host || env.host,
    port: process.env.PORT ? env.port : parseConfiguredPort(fileConfig.port || env.port),
    adminTitle: process.env.ADMIN_TITLE || fileConfig.adminTitle || env.adminTitle,
    adminAuth: {
      username: env.adminUsername,
      password: env.adminPassword,
      sessionSecret: env.adminSessionSecret
    },
    configDir: env.configDir,
    dataDir: env.dataDir,
    logDir: env.logDir,
    logLevel: env.logLevel,
    databasePath: process.env.DB_PATH || process.env.DATABASE_PATH || fileConfig.databasePath || env.databasePath,
    assetsConfigPath: process.env.ASSETS_CONFIG_PATH || fileConfig.assetsConfigPath || env.assetsConfigPath,
    maintenanceMode: fileConfig.maintenanceMode === true,
    profile: fileConfig.profile || 'conservative',
    coingecko: normalizeObjectConfig(fileConfig.coingecko, DEFAULT_COINGECKO_CONFIG),
    automation: normalizeObjectConfig(fileConfig.automation, DEFAULT_AUTOMATION_CONFIG)
  };
}

module.exports = { DEFAULT_AUTOMATION_CONFIG, DEFAULT_COINGECKO_CONFIG, loadServerConfig };
