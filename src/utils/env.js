const path = require('path');
const dotenv = require('dotenv');

let cachedEnv = null;

function parsePort(value, fallback) {
  const rawValue = value === undefined || value === null || value === '' ? fallback : value;
  const port = Number(rawValue);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535. Received: ${rawValue}`);
  }

  return port;
}

function readString(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return value;
}

function validateRequiredStrings(env) {
  const required = [
    'appName',
    'nodeEnv',
    'host',
    'adminTitle',
    'configDir',
    'dataDir',
    'logDir',
    'databasePath',
    'assetsConfigPath',
    'logLevel'
  ];

  const missing = required.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing environment configuration: ${missing.join(', ')}`);
  }
}

function validateLogLevel(logLevel) {
  const allowedLevels = ['debug', 'info', 'warn', 'error'];
  if (!allowedLevels.includes(logLevel)) {
    throw new Error(`LOG_LEVEL must be one of: ${allowedLevels.join(', ')}. Received: ${logLevel}`);
  }
}

function loadEnv(options = {}) {
  if (cachedEnv && !options.reload) {
    return cachedEnv;
  }

  dotenv.config({ path: options.envPath || path.resolve(process.cwd(), '.env') });

  const configDir = readString('CONFIG_DIR', './config');
  const dataDir = readString('DATA_DIR', './data');
  const defaultDatabasePath = path.join(dataDir, 'history.sqlite');
  const defaultAssetsConfigPath = path.join(configDir, 'assets.json');

  const env = {
    appName: readString('APP_NAME', 'chrono-cache'),
    nodeEnv: readString('NODE_ENV', 'development'),
    host: readString('HOST', '127.0.0.1'),
    port: parsePort(process.env.PORT, 3000),
    adminTitle: readString('ADMIN_TITLE', 'Chrono Cache Admin'),
    configDir,
    dataDir,
    logDir: readString('LOG_DIR', './logs'),
    databasePath: readString('DB_PATH', readString('DATABASE_PATH', defaultDatabasePath)),
    assetsConfigPath: readString('ASSETS_CONFIG_PATH', defaultAssetsConfigPath),
    logLevel: readString('LOG_LEVEL', 'info').toLowerCase()
  };

  validateRequiredStrings(env);
  validateLogLevel(env.logLevel);

  cachedEnv = env;
  return env;
}

module.exports = { loadEnv };
