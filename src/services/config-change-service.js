const fs = require('fs');
const path = require('path');

const { insertConfigChange } = require('../db/queries');
const { validateAssetsPayload } = require('./asset-service');
const { loadServerConfig } = require('../utils/config');
const { ensureDirectory, resolveFromRoot } = require('../utils/files');

const CONFIG_TARGETS = {
  assets: 'config/assets.json',
  server: 'config/server.json'
};

const SERVER_STRING_FIELDS = new Set([
  'appName',
  'host',
  'adminTitle',
  'databasePath',
  'assetsConfigPath'
]);

function normalizeRelativePath(filePath) {
  return String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function getAllowedConfigFiles(config = loadServerConfig()) {
  return {
    'config/assets.json': resolveFromRoot(CONFIG_TARGETS.assets),
    'config/server.json': resolveFromRoot(path.join(config.configDir || 'config', 'server.json'))
  };
}

function resolveAllowedConfigPath(filePath, config = loadServerConfig()) {
  const normalized = normalizeRelativePath(filePath);
  const allowedFiles = getAllowedConfigFiles(config);

  if (!Object.prototype.hasOwnProperty.call(allowedFiles, normalized)) {
    const error = new Error('Only config/assets.json and config/server.json can be edited.');
    error.status = 400;
    throw error;
  }

  return {
    relativePath: normalized,
    absolutePath: allowedFiles[normalized]
  };
}

function parseJsonText(jsonText) {
  try {
    return JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error.message}`);
  }
}

function validatePositiveNumberObject(payload, objectField, fields, errors) {
  const value = payload[objectField];
  if (value === undefined) {
    return;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`server.${objectField} must be an object when provided.`);
    return;
  }

  fields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      const parsed = Number(value[field]);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        errors.push(`server.${objectField}.${field} must be a positive number.`);
      }
    }
  });
}

function validateBooleanObject(payload, objectField, fields, errors) {
  const value = payload[objectField];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return;
  }

  fields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(value, field) && typeof value[field] !== 'boolean') {
      errors.push(`server.${objectField}.${field} must be true or false.`);
    }
  });
}

function validateServerPayload(payload) {
  const errors = [];

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Server config must be a JSON object.'];
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'port')) {
    const port = Number(payload.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push('server.port must be an integer between 1 and 65535.');
    }
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'maintenanceMode') && typeof payload.maintenanceMode !== 'boolean') {
    errors.push('server.maintenanceMode must be true or false.');
  }

  validatePositiveNumberObject(payload, 'coingecko', ['maxCallsPerMinute', 'rateLimitPauseMs', 'retries', 'baseBackoffMs'], errors);
  validateBooleanObject(payload, 'coingecko', ['safeMode'], errors);
  validatePositiveNumberObject(payload, 'automation', ['recentEveryMinutes', 'maxBackfillDaysPerRun', 'failureThreshold', 'failureCooldownMinutes'], errors);
  validateBooleanObject(payload, 'automation', ['dailyBackfill', 'enable5m'], errors);

  SERVER_STRING_FIELDS.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(payload, field) && typeof payload[field] !== 'string') {
      errors.push(`server.${field} must be a string when provided.`);
    }
  });

  return errors;
}

function validateConfigPayload(relativePath, payload) {
  if (relativePath === CONFIG_TARGETS.assets) {
    const errors = validateAssetsPayload(payload);
    if (errors.length > 0) {
      throw new Error(`Invalid asset config:\n${errors.map((error) => `- ${error}`).join('\n')}`);
    }
    return;
  }

  if (relativePath === CONFIG_TARGETS.server) {
    const errors = validateServerPayload(payload);
    if (errors.length > 0) {
      throw new Error(`Invalid server config:\n${errors.map((error) => `- ${error}`).join('\n')}`);
    }
    return;
  }

  throw new Error('Unsupported config file.');
}

function makeConfigBackupPath(configPath, summary) {
  const backupDir = resolveFromRoot(path.join('data', 'config-backups'));
  ensureDirectory(backupDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeBase = path.basename(configPath).replace(/[^a-z0-9_.-]/gi, '-');
  const safeSummary = String(summary || 'edit').replace(/[^a-z0-9_-]/gi, '-').slice(0, 40) || 'edit';
  return path.join(backupDir, `${safeBase}.${stamp}.${safeSummary}.bak`);
}

function writeFileAtomically(configPath, json) {
  const directory = path.dirname(configPath);
  const tempPath = path.join(directory, `.${path.basename(configPath)}.${process.pid}.${Date.now()}.tmp`);
  const mode = fs.existsSync(configPath) ? fs.statSync(configPath).mode & 0o777 : 0o644;
  let fd = null;

  try {
    fd = fs.openSync(tempPath, 'w', mode);
    fs.writeFileSync(fd, json, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, configPath);
  } catch (error) {
    if (fd !== null) {
      fs.closeSync(fd);
    }
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
    throw error;
  }
}

function saveConfigChange(options = {}) {
  const db = options.db;
  const config = options.config || loadServerConfig();
  const target = resolveAllowedConfigPath(options.filePath, config);
  const payload = options.payload;
  const changedBy = options.changedBy || 'admin-ui';
  const summary = options.summary || 'Admin config edit';

  if (!db) {
    throw new Error('Database connection is required to record config change history.');
  }

  validateConfigPayload(target.relativePath, payload);

  if (!fs.existsSync(target.absolutePath)) {
    throw new Error(`Config file not found: ${target.relativePath}`);
  }

  const backupPath = makeConfigBackupPath(target.absolutePath, summary);
  const json = `${JSON.stringify(payload, null, 2)}\n`;

  fs.copyFileSync(target.absolutePath, backupPath);
  writeFileAtomically(target.absolutePath, json);

  try {
    return insertConfigChange(db, {
      filePath: target.relativePath,
      backupPath: path.relative(process.cwd(), backupPath),
      changedBy,
      summary,
      createdAt: Date.now()
    });
  } catch (error) {
    writeFileAtomically(target.absolutePath, fs.readFileSync(backupPath, 'utf8'));
    throw error;
  }
}

function readBackupPayload(backupPath) {
  const resolvedBackupPath = resolveFromRoot(backupPath);
  const backupsDir = resolveFromRoot(path.join('data', 'config-backups'));
  const relative = path.relative(backupsDir, resolvedBackupPath);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Config rollback backup must be inside data/config-backups.');
  }

  return parseJsonText(fs.readFileSync(resolvedBackupPath, 'utf8'));
}

function rollbackConfigChange(options = {}) {
  const change = options.change;

  if (!change) {
    throw new Error('Config change was not found.');
  }

  const payload = readBackupPayload(change.backupPath);

  return saveConfigChange({
    db: options.db,
    config: options.config,
    filePath: change.filePath,
    payload,
    changedBy: options.changedBy || 'admin-ui',
    summary: `Rollback to change #${change.id}`
  });
}

module.exports = {
  CONFIG_TARGETS,
  parseJsonText,
  resolveAllowedConfigPath,
  rollbackConfigChange,
  saveConfigChange,
  validateConfigPayload,
  validateServerPayload
};
