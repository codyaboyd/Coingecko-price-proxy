const fs = require('fs');
const path = require('path');

const { resolveDatabasePath } = require('../db/node-sqlite');
const { loadAssets } = require('./asset-service');
const { resolveFromRoot } = require('../utils/files');

const packageJson = require('../../package.json');

const BACKUP_BASENAME_PATTERN = /^history-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/;
const BACKUP_SQLITE_PATTERN = /^(history-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})\.sqlite$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const DEFAULT_RETENTION = {
  dailyDays: 14,
  weeklyWeeks: 8,
  monthlyMonths: 12
};

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatTimestampForBackup(date = new Date()) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}-${pad(date.getUTCHours())}-${pad(date.getUTCMinutes())}-${pad(date.getUTCSeconds())}`;
}

function parseBackupTimestamp(baseName) {
  const match = String(baseName || '').match(BACKUP_BASENAME_PATTERN);

  if (!match) {
    return null;
  }

  const timestamp = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6])
  );
  const date = new Date(timestamp);

  if (
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3]) ||
    date.getUTCHours() !== Number(match[4]) ||
    date.getUTCMinutes() !== Number(match[5]) ||
    date.getUTCSeconds() !== Number(match[6])
  ) {
    return null;
  }

  return timestamp;
}

function getIsoWeekKey(timestamp) {
  const date = new Date(timestamp);
  const day = date.getUTCDay() || 7;
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / DAY_MS) + 1) / 7);
  return `${date.getUTCFullYear()}-W${pad(week)}`;
}

function getMonthKey(timestamp) {
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

function countTableRows(db, tableName) {
  if (!db) {
    return null;
  }

  try {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get();
    return Number(row && row.count ? row.count : 0);
  } catch (error) {
    return null;
  }
}

function resolveConfiguredFile(config, configuredPath, fallbackPath) {
  return resolveFromRoot(configuredPath || fallbackPath);
}

function ensureBackupDirectory(config) {
  const backupDir = resolveFromRoot(path.join(config.dataDir || 'data', 'backups'));
  fs.mkdirSync(backupDir, { recursive: true });
  return backupDir;
}

function collectBackupFiles(backupDir, baseName) {
  return [
    `${baseName}.sqlite`,
    `${baseName}.assets.json`,
    `${baseName}.server.json`,
    `${baseName}.env.example`,
    `${baseName}.manifest.json`
  ].map((name) => ({ name, path: path.join(backupDir, name) }));
}

function toBackupEntry(backupDir, baseName) {
  const sqlitePath = path.join(backupDir, `${baseName}.sqlite`);
  const manifestPath = path.join(backupDir, `${baseName}.manifest.json`);
  const sqliteStats = safeStat(sqlitePath);
  const manifest = readJsonIfExists(manifestPath);
  const createdAtMs = manifest && manifest.createdAt ? Date.parse(manifest.createdAt) : parseBackupTimestamp(baseName);
  const files = collectBackupFiles(backupDir, baseName)
    .map((file) => {
      const stats = safeStat(file.path);
      return stats ? {
        name: file.name,
        path: file.path,
        sizeBytes: stats.size,
        updatedAt: stats.mtimeMs
      } : null;
    })
    .filter(Boolean);

  return {
    id: baseName,
    baseName,
    fileName: `${baseName}.sqlite`,
    manifestName: `${baseName}.manifest.json`,
    path: sqlitePath,
    relativePath: path.relative(process.cwd(), sqlitePath),
    createdAt: Number.isFinite(createdAtMs) ? new Date(createdAtMs).toISOString() : null,
    createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0,
    sizeBytes: sqliteStats ? sqliteStats.size : (manifest && manifest.dbSizeBytes) || 0,
    manifest,
    files
  };
}

class BackupService {
  constructor(options = {}) {
    if (!options.config) {
      throw new Error('BackupService requires server config.');
    }

    this.config = options.config;
    this.db = options.db || null;
    this.retention = { ...DEFAULT_RETENTION, ...(options.retention || {}) };
  }

  getBackupDir() {
    return ensureBackupDirectory(this.config);
  }

  getSourceDbPath() {
    return resolveDatabasePath(this.config.databasePath || 'data/history.sqlite');
  }

  getAssetCount() {
    const databaseCount = countTableRows(this.db, 'assets');

    if (databaseCount !== null) {
      return databaseCount;
    }

    try {
      return loadAssets(this.config.assetsConfigPath).length;
    } catch (error) {
      return 0;
    }
  }

  getCandleCount() {
    return countTableRows(this.db, 'candles') || 0;
  }

  copyIfExists(sourcePath, targetPath) {
    if (!fs.existsSync(sourcePath)) {
      return false;
    }

    fs.copyFileSync(sourcePath, targetPath);
    return true;
  }

  async createBackup(options = {}) {
    const now = options.now instanceof Date ? options.now : new Date();
    const backupDir = this.getBackupDir();
    const stamp = formatTimestampForBackup(now);
    const baseName = `history-${stamp}`;
    const backupPath = path.join(backupDir, `${baseName}.sqlite`);
    const sourcePath = this.getSourceDbPath();

    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Database file does not exist: ${sourcePath}`);
    }

    if (fs.existsSync(backupPath)) {
      throw new Error(`Backup already exists for timestamp: ${backupPath}`);
    }

    if (this.db && typeof this.db.backup === 'function') {
      await this.db.backup(backupPath);
    } else {
      fs.copyFileSync(sourcePath, backupPath);
    }

    const assetPath = resolveConfiguredFile(this.config, this.config.assetsConfigPath, 'config/assets.json');
    const serverPath = resolveConfiguredFile(this.config, path.join(this.config.configDir || 'config', 'server.json'), 'config/server.json');
    const envExamplePath = resolveFromRoot('.env.example');

    const copiedFiles = {
      assets: this.copyIfExists(assetPath, path.join(backupDir, `${baseName}.assets.json`)),
      server: this.copyIfExists(serverPath, path.join(backupDir, `${baseName}.server.json`)),
      envExample: this.copyIfExists(envExamplePath, path.join(backupDir, `${baseName}.env.example`))
    };
    const dbStats = fs.statSync(backupPath);
    const manifest = {
      createdAt: now.toISOString(),
      dbPath: path.relative(process.cwd(), sourcePath),
      dbSizeBytes: dbStats.size,
      assetCount: this.getAssetCount(),
      candleCount: this.getCandleCount(),
      appVersion: packageJson.version || null,
      files: {
        database: `${baseName}.sqlite`,
        assets: copiedFiles.assets ? `${baseName}.assets.json` : null,
        server: copiedFiles.server ? `${baseName}.server.json` : null,
        envExample: copiedFiles.envExample ? `${baseName}.env.example` : null
      }
    };
    const manifestPath = path.join(backupDir, `${baseName}.manifest.json`);

    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    return toBackupEntry(backupDir, baseName);
  }

  listBackups() {
    const backupDir = this.getBackupDir();
    const baseNames = new Set();

    fs.readdirSync(backupDir, { withFileTypes: true }).forEach((entry) => {
      if (!entry.isFile()) {
        return;
      }

      const sqliteMatch = entry.name.match(BACKUP_SQLITE_PATTERN);
      const manifestMatch = entry.name.match(/^(history-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})\.manifest\.json$/);

      if (sqliteMatch) {
        baseNames.add(sqliteMatch[1]);
      } else if (manifestMatch) {
        baseNames.add(manifestMatch[1]);
      }
    });

    return Array.from(baseNames)
      .map((baseName) => toBackupEntry(backupDir, baseName))
      .sort((left, right) => right.createdAtMs - left.createdAtMs || right.baseName.localeCompare(left.baseName));
  }

  resolveBackupFile(fileName) {
    const backupDir = this.getBackupDir();
    const name = path.basename(String(fileName || ''));
    const allowed = /^(history-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})\.(sqlite|assets\.json|server\.json|env\.example|manifest\.json)$/.test(name);

    if (!allowed) {
      const error = new Error('Invalid backup file name.');
      error.status = 400;
      throw error;
    }

    const filePath = path.join(backupDir, name);

    if (!fs.existsSync(filePath)) {
      const error = new Error('Backup file not found.');
      error.status = 404;
      throw error;
    }

    return filePath;
  }

  deleteBackup(baseName) {
    const normalized = String(baseName || '').replace(/\.(sqlite|manifest\.json|assets\.json|server\.json|env\.example)$/, '');

    if (!BACKUP_BASENAME_PATTERN.test(normalized)) {
      const error = new Error('Invalid backup id.');
      error.status = 400;
      throw error;
    }

    const backupDir = this.getBackupDir();
    let deleted = 0;

    collectBackupFiles(backupDir, normalized).forEach((file) => {
      try {
        fs.unlinkSync(file.path);
        deleted += 1;
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
    });

    return { baseName: normalized, deleted };
  }

  pruneBackups(options = {}) {
    const now = options.now || Date.now();
    const backups = this.listBackups();
    const keep = new Set();
    const weekly = new Set();
    const monthly = new Set();
    const dailyCutoff = now - (this.retention.dailyDays * DAY_MS);
    const weeklyCutoff = now - (this.retention.weeklyWeeks * WEEK_MS);
    const monthlyCutoffDate = new Date(now);
    monthlyCutoffDate.setUTCMonth(monthlyCutoffDate.getUTCMonth() - this.retention.monthlyMonths);
    const monthlyCutoff = monthlyCutoffDate.getTime();

    backups.forEach((backup) => {
      if (!backup.createdAtMs) {
        return;
      }

      if (backup.createdAtMs >= dailyCutoff) {
        keep.add(backup.baseName);
        return;
      }

      if (backup.createdAtMs >= weeklyCutoff) {
        const weekKey = getIsoWeekKey(backup.createdAtMs);
        if (!weekly.has(weekKey)) {
          weekly.add(weekKey);
          keep.add(backup.baseName);
          return;
        }
      }

      if (backup.createdAtMs >= monthlyCutoff) {
        const monthKey = getMonthKey(backup.createdAtMs);
        if (!monthly.has(monthKey)) {
          monthly.add(monthKey);
          keep.add(backup.baseName);
        }
      }
    });

    const pruned = backups
      .filter((backup) => !keep.has(backup.baseName))
      .map((backup) => this.deleteBackup(backup.baseName));

    return {
      kept: backups.length - pruned.length,
      pruned: pruned.length,
      deletedFiles: pruned.reduce((total, item) => total + item.deleted, 0),
      backups: pruned
    };
  }
}

function createBackupService(options) {
  return new BackupService(options);
}

module.exports = {
  BackupService,
  DEFAULT_RETENTION,
  createBackupService,
  formatTimestampForBackup,
  parseBackupTimestamp
};
