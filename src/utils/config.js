const path = require('path');
const { readJsonFile } = require('./files');
const { loadEnv } = require('./env');

const DEFAULT_COINGECKO_CONFIG = {
  baseUrl: 'https://api.coingecko.com/api/v3',
  maxCallsPerMinute: 8,
  safeMode: true,
  timeoutMs: 15000,
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

function parseBoolean(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }

  const normalized = String(value).trim().toLowerCase();

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  throw new Error(`Boolean configuration value must be true or false. Received: ${value}`);
}

function parseOptionalPositiveInteger(value, name) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be an integer greater than or equal to 1. Received: ${value}`);
  }

  return parsed;
}

function parseOptionalNonNegativeInteger(value, name) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be an integer greater than or equal to 0. Received: ${value}`);
  }

  return parsed;
}

function buildCoinGeckoConfig(fileConfig) {
  const coingecko = normalizeObjectConfig(fileConfig.coingecko, DEFAULT_COINGECKO_CONFIG);
  const safeMode = parseBoolean(process.env.COINGECKO_SAFE_MODE);
  const maxCallsPerMinute = parseOptionalPositiveInteger(process.env.COINGECKO_MAX_CALLS_PER_MINUTE, 'COINGECKO_MAX_CALLS_PER_MINUTE');
  const timeoutMs = parseOptionalPositiveInteger(process.env.COINGECKO_TIMEOUT_MS, 'COINGECKO_TIMEOUT_MS');
  const rateLimitPauseMs = parseOptionalPositiveInteger(process.env.COINGECKO_RATE_LIMIT_PAUSE_MS, 'COINGECKO_RATE_LIMIT_PAUSE_MS');
  const retries = parseOptionalNonNegativeInteger(process.env.COINGECKO_RETRIES, 'COINGECKO_RETRIES');
  const baseBackoffMs = parseOptionalPositiveInteger(process.env.COINGECKO_BACKOFF_MS, 'COINGECKO_BACKOFF_MS');

  if (process.env.COINGECKO_API_BASE) {
    coingecko.baseUrl = process.env.COINGECKO_API_BASE;
  }

  if (maxCallsPerMinute !== null) {
    coingecko.maxCallsPerMinute = maxCallsPerMinute;
  }

  if (safeMode !== null) {
    coingecko.safeMode = safeMode;
  }

  if (timeoutMs !== null) {
    coingecko.timeoutMs = timeoutMs;
  }

  if (rateLimitPauseMs !== null) {
    coingecko.rateLimitPauseMs = rateLimitPauseMs;
  }

  if (retries !== null) {
    coingecko.retries = retries;
  }

  if (baseBackoffMs !== null) {
    coingecko.baseBackoffMs = baseBackoffMs;
  }

  return coingecko;
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
    coingecko: buildCoinGeckoConfig(fileConfig),
    automation: normalizeObjectConfig(fileConfig.automation, DEFAULT_AUTOMATION_CONFIG)
  };
}

module.exports = { DEFAULT_AUTOMATION_CONFIG, DEFAULT_COINGECKO_CONFIG, loadServerConfig };
