const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');

const { upsertAssets } = require('../db/queries');
const { loadAssets } = require('./asset-service');
const { loadServerConfig } = require('../utils/config');
const { ensureDirectory, resolveFromRoot } = require('../utils/files');
const { applyMaintenanceModeToRuntime } = require('./maintenance-service');
const logger = require('../utils/logger');
const { createAlert } = require('./alert-service');

const RESTART_REQUIRED_SERVER_FIELDS = new Set([
  'host',
  'port',
  'databasePath',
  'assetsConfigPath',
  'configDir',
  'dataDir'
]);

const SAFE_RUNTIME_SERVER_FIELDS = new Set([
  'appName',
  'adminTitle',
  'logLevel',
  'maintenanceMode'
]);

function formatError(error) {
  if (!error) {
    return null;
  }

  if (Array.isArray(error.errors) && error.errors.length > 0) {
    return error.errors.join('\n');
  }

  return error.message || String(error);
}

function cloneCandidate(candidate) {
  return {
    fileName: candidate.fileName,
    path: candidate.path,
    size: candidate.size,
    status: candidate.status,
    firstSeenAt: candidate.firstSeenAt,
    updatedAt: candidate.updatedAt
  };
}

function cloneReloadEvent(event) {
  return {
    target: event.target,
    status: event.status,
    message: event.message,
    errors: [...event.errors],
    changedSettings: [...event.changedSettings],
    restartRequiredSettings: [...event.restartRequiredSettings],
    at: event.at
  };
}

function makeInitialEvent() {
  return {
    target: 'startup',
    status: 'not-run',
    message: 'No hot reload events have run yet.',
    errors: [],
    changedSettings: [],
    restartRequiredSettings: [],
    at: null
  };
}

class HotReloadManager {
  constructor(options = {}) {
    this.app = options.app;
    this.db = options.db;
    this.config = options.config;
    this.jobScheduler = options.jobScheduler;
    this.recentRefreshScheduler = options.recentRefreshScheduler;
    this.assets = [...(options.assets || [])];
    this.importCandidates = new Map();
    this.lastReload = makeInitialEvent();
    this.events = [];
    this.watcher = null;
    this.importsDir = options.importsDir || path.join(this.config.dataDir, 'imports');
  }

  start() {
    ensureDirectory(this.importsDir);
    this.scanImportsDirectory();

    const watchPaths = [
      resolveFromRoot(this.config.assetsConfigPath),
      resolveFromRoot(path.join(this.config.configDir, 'server.json')),
      resolveFromRoot(this.importsDir)
    ];

    this.watcher = chokidar.watch(watchPaths, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 250,
        pollInterval: 50
      }
    });

    this.watcher
      .on('change', (changedPath) => this.handlePathChange(changedPath))
      .on('add', (changedPath) => this.handlePathChange(changedPath))
      .on('error', (error) => this.recordReload({
        target: 'watcher',
        status: 'error',
        message: 'Hot reload watcher failed.',
        errors: [formatError(error)]
      }));

    logger.info(`Hot reload watching ${watchPaths.join(', ')}.`);
    return this.getStatus();
  }

  async stop() {
    if (!this.watcher) {
      return;
    }

    const watcher = this.watcher;
    this.watcher = null;
    await watcher.close();
  }

  handlePathChange(changedPath) {
    const resolvedPath = path.resolve(changedPath);
    const assetsPath = resolveFromRoot(this.config.assetsConfigPath);
    const serverPath = resolveFromRoot(path.join(this.config.configDir, 'server.json'));
    const importsPath = resolveFromRoot(this.importsDir);

    if (resolvedPath === assetsPath) {
      this.reloadAssetsConfig();
      return;
    }

    if (resolvedPath === serverPath) {
      this.reloadServerConfig();
      return;
    }

    if (resolvedPath.startsWith(`${importsPath}${path.sep}`)) {
      this.detectImportCandidate(resolvedPath);
    }
  }

  reloadAssetsConfig() {
    try {
      const assets = loadAssets(this.config.assetsConfigPath);
      upsertAssets(this.db, assets);
      this.assets = [...assets];

      if (this.app) {
        this.app.set('assets', this.assets);
      }

      if (this.recentRefreshScheduler && typeof this.recentRefreshScheduler.reloadAssets === 'function') {
        this.recentRefreshScheduler.reloadAssets(assets);
      }

      this.recordReload({
        target: 'config/assets.json',
        status: 'success',
        message: `Reloaded ${assets.length} asset(s), synced database rows, and refreshed scheduler state.`
      });
    } catch (error) {
      this.recordReload({
        target: 'config/assets.json',
        status: 'error',
        message: 'Asset reload failed. Keeping the last valid asset config in memory.',
        errors: [formatError(error)]
      });
      logger.error(`Asset hot reload failed: ${formatError(error)}`);
    }

    return this.getStatus();
  }

  reloadServerConfig() {
    try {
      const nextConfig = loadServerConfig();
      const changedSettings = [];
      const restartRequiredSettings = [];

      Object.keys(nextConfig).forEach((key) => {
        if (this.config[key] === nextConfig[key]) {
          return;
        }

        changedSettings.push(key);

        if (SAFE_RUNTIME_SERVER_FIELDS.has(key)) {
          this.config[key] = nextConfig[key];

          if (key === 'maintenanceMode' && this.app) {
            applyMaintenanceModeToRuntime(this.app, nextConfig.maintenanceMode);
          }
        } else if (RESTART_REQUIRED_SERVER_FIELDS.has(key)) {
          restartRequiredSettings.push(key);
        } else {
          restartRequiredSettings.push(key);
        }
      });

      if (this.app) {
        this.app.set('config', this.config);
      }

      if (restartRequiredSettings.length > 0) {
        logger.warn(`Server config changed but requires restart for: ${restartRequiredSettings.join(', ')}.`);
      }

      this.recordReload({
        target: 'config/server.json',
        status: 'success',
        message: changedSettings.length === 0
          ? 'Server config file changed but no runtime settings changed.'
          : 'Reloaded safe server settings; restart-only settings were left unchanged.',
        changedSettings,
        restartRequiredSettings
      });
    } catch (error) {
      this.recordReload({
        target: 'config/server.json',
        status: 'error',
        message: 'Server config reload failed. Keeping the last valid runtime config.',
        errors: [formatError(error)]
      });
      logger.error(`Server config hot reload failed: ${formatError(error)}`);
    }

    return this.getStatus();
  }

  scanImportsDirectory() {
    const importsPath = resolveFromRoot(this.importsDir);

    if (!fs.existsSync(importsPath)) {
      return;
    }

    fs.readdirSync(importsPath, { withFileTypes: true }).forEach((entry) => {
      if (entry.isFile()) {
        this.detectImportCandidate(path.join(importsPath, entry.name), { silent: true });
      }
    });
  }

  detectImportCandidate(candidatePath, options = {}) {
    const resolvedPath = path.resolve(candidatePath);
    const fileName = path.basename(resolvedPath);

    if (fileName.startsWith('.')) {
      return null;
    }

    let stats;

    try {
      stats = fs.statSync(resolvedPath);
    } catch (error) {
      return null;
    }

    if (!stats.isFile()) {
      return null;
    }

    const now = Date.now();
    const existing = this.importCandidates.get(resolvedPath);
    const candidate = {
      fileName,
      path: resolvedPath,
      size: stats.size,
      status: 'pending',
      firstSeenAt: existing ? existing.firstSeenAt : now,
      updatedAt: now
    };

    this.importCandidates.set(resolvedPath, candidate);

    if (!options.silent) {
      this.recordReload({
        target: 'data/imports',
        status: 'success',
        message: `Detected pending import candidate: ${fileName}.`
      });
    }

    return candidate;
  }

  recordReload(event) {
    const normalized = {
      target: event.target,
      status: event.status,
      message: event.message,
      errors: (event.errors || []).filter(Boolean),
      changedSettings: event.changedSettings || [],
      restartRequiredSettings: event.restartRequiredSettings || [],
      at: Date.now()
    };

    this.lastReload = normalized;
    this.events.unshift(normalized);
    this.events = this.events.slice(0, 20);

    if (normalized.status === 'success') {
      logger.info(normalized.message);
    } else if (normalized.status === 'error') {
      createAlert(this.db, {
        severity: 'critical',
        type: 'config_reload_failed',
        title: `Config reload failed: ${normalized.target}`,
        message: [normalized.message, ...normalized.errors].filter(Boolean).join(' '),
        entityType: 'config',
        entityId: normalized.target
      });
    }
  }

  getStatus() {
    return {
      lastReload: cloneReloadEvent(this.lastReload),
      events: this.events.map(cloneReloadEvent),
      importCandidates: Array.from(this.importCandidates.values())
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map(cloneCandidate)
    };
  }

  getAssets() {
    return [...this.assets];
  }
}

function createHotReloadManager(options = {}) {
  return new HotReloadManager(options);
}

module.exports = {
  HotReloadManager,
  createHotReloadManager
};
