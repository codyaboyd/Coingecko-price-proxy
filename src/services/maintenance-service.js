const fs = require('fs');
const path = require('path');

const { loadServerConfig } = require('../utils/config');
const { readJsonFile, resolveFromRoot } = require('../utils/files');

function isMaintenanceMode(config) {
  return Boolean(config && config.maintenanceMode);
}

function getServerConfigPath(config = loadServerConfig()) {
  return resolveFromRoot(path.join(config.configDir, 'server.json'));
}

function writeServerConfigPayload(configPath, payload) {
  const directory = path.dirname(configPath);
  const tempPath = path.join(directory, `${path.basename(configPath)}.${process.pid}.${Date.now()}.tmp`);
  const mode = fs.existsSync(configPath) ? fs.statSync(configPath).mode & 0o777 : 0o644;

  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode });
  fs.renameSync(tempPath, configPath);
}

function setMaintenanceMode(enabled, options = {}) {
  const config = options.config || loadServerConfig();
  const configPath = options.configPath ? resolveFromRoot(options.configPath) : getServerConfigPath(config);
  const payload = readJsonFile(configPath);

  payload.maintenanceMode = Boolean(enabled);
  writeServerConfigPayload(configPath, payload);

  if (config) {
    config.maintenanceMode = payload.maintenanceMode;
  }

  return {
    maintenanceMode: payload.maintenanceMode,
    configPath
  };
}

function applyMaintenanceModeToRuntime(app, enabled) {
  const config = app && app.get('config');

  if (config) {
    config.maintenanceMode = Boolean(enabled);
    app.set('config', config);
  }

  const scheduler = app && app.get('jobScheduler');
  if (scheduler && typeof scheduler.setMaintenanceMode === 'function') {
    scheduler.setMaintenanceMode(Boolean(enabled));
  }

  const recentRefreshScheduler = app && app.get('recentRefreshScheduler');
  if (recentRefreshScheduler && typeof recentRefreshScheduler.setMaintenanceMode === 'function') {
    recentRefreshScheduler.setMaintenanceMode(Boolean(enabled));
  }
}

function createMaintenanceError(message = 'Maintenance mode is active; this operation is paused.') {
  const error = new Error(message);
  error.status = 503;
  error.code = 'maintenance_mode';
  return error;
}

module.exports = {
  applyMaintenanceModeToRuntime,
  createMaintenanceError,
  getServerConfigPath,
  isMaintenanceMode,
  setMaintenanceMode
};
