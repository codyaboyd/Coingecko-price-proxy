const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const { initializeDatabase, runMigrations } = require('../db');
const { resolveDatabasePath } = require('../db/node-sqlite');
const { createRecentRefreshScheduler } = require('../jobs/recent-refresh-scheduler');
const { createScheduler } = require('../jobs/scheduler');
const { loadAssets } = require('./asset-service');
const { createBackupService, formatTimestampForBackup } = require('./backup-service');
const { resolveFromRoot } = require('../utils/files');
const logger = require('../utils/logger');

const RESTORE_CONFIRMATION_PHRASE = 'RESTORE BACKUP';
const EXPECTED_TABLES = ['assets', 'candles', 'fetch_runs', 'import_runs', 'api_cache'];
const SQLITE_HEADER = 'SQLite format 3\u0000';

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function getBackupDirectory(config) {
  return ensureDirectory(resolveFromRoot(path.join(config.dataDir || 'data', 'backups')));
}

function getEmergencyDirectory(config) {
  return ensureDirectory(path.join(getBackupDirectory(config), 'emergency'));
}

function getRestoreLogPath(config) {
  return path.join(getBackupDirectory(config), 'restore-attempts.log');
}

function appendRestoreAttempt(config, attempt) {
  const entry = {
    at: new Date().toISOString(),
    ...attempt
  };

  fs.appendFileSync(getRestoreLogPath(config), `${JSON.stringify(entry)}\n`);
}

function isInsideDirectory(baseDir, candidatePath) {
  const relative = path.relative(baseDir, candidatePath);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveBackupPath(config, requestedPath) {
  if (!requestedPath || String(requestedPath).trim() === '') {
    const error = new Error('Backup path is required.');
    error.status = 400;
    throw error;
  }

  const backupDir = getBackupDirectory(config);
  const candidate = path.resolve(process.cwd(), String(requestedPath));
  const fileName = path.basename(candidate);
  const backupNamePattern = /^history-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.sqlite$/;

  if (!backupNamePattern.test(fileName)) {
    const error = new Error('Backup file name must match history-YYYY-MM-DD-HH-mm-ss.sqlite.');
    error.status = 400;
    throw error;
  }

  if (!fs.existsSync(candidate)) {
    const error = new Error(`Backup file does not exist: ${requestedPath}`);
    error.status = 404;
    throw error;
  }

  const backupDirReal = fs.realpathSync(backupDir);
  const candidateReal = fs.realpathSync(candidate);

  if (!isInsideDirectory(backupDirReal, candidateReal)) {
    const error = new Error('Backup restore source must be inside data/backups.');
    error.status = 400;
    throw error;
  }

  const stats = fs.statSync(candidateReal);

  if (!stats.isFile()) {
    const error = new Error('Backup restore source must be a regular file.');
    error.status = 400;
    throw error;
  }

  return candidateReal;
}

function validateConfirmation(backupPath, confirmation) {
  const expectedFileName = path.basename(backupPath);
  const typed = String(confirmation || '').trim();

  if (typed !== expectedFileName && typed !== RESTORE_CONFIRMATION_PHRASE) {
    const error = new Error(`Type ${expectedFileName} or ${RESTORE_CONFIRMATION_PHRASE} to confirm restore.`);
    error.status = 400;
    throw error;
  }
}

function validateSQLiteHeader(backupPath) {
  const fd = fs.openSync(backupPath, 'r');
  const buffer = Buffer.alloc(16);

  try {
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);

    if (bytesRead !== buffer.length || buffer.toString('binary') !== SQLITE_HEADER) {
      throw new Error('Backup is not a valid SQLite database file.');
    }
  } finally {
    fs.closeSync(fd);
  }
}

function validateSQLiteBackup(backupPath, expectedTables = EXPECTED_TABLES) {
  validateSQLiteHeader(backupPath);

  const db = new Database(backupPath, { readonly: true, fileMustExist: true });

  try {
    const integrity = db.pragma('integrity_check');
    const integrityOk = Array.isArray(integrity) && integrity.length === 1 && integrity[0].integrity_check === 'ok';

    if (!integrityOk) {
      throw new Error('Backup failed SQLite integrity_check.');
    }

    const rows = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
    `).all();
    const tableNames = new Set(rows.map((row) => row.name));
    const missingTables = expectedTables.filter((tableName) => !tableNames.has(tableName));

    if (missingTables.length > 0) {
      throw new Error(`Backup is missing expected table(s): ${missingTables.join(', ')}.`);
    }

    return {
      ok: true,
      tables: expectedTables
    };
  } finally {
    db.close();
  }
}

async function createEmergencyBackup(config, db, now = new Date()) {
  const emergencyDir = getEmergencyDirectory(config);
  const stamp = formatTimestampForBackup(now);
  const emergencyPath = path.join(emergencyDir, `pre-restore-${stamp}.sqlite`);
  const sourcePath = resolveDatabasePath(config.databasePath || 'data/history.sqlite');

  if (!fs.existsSync(sourcePath)) {
    return null;
  }

  if (db && typeof db.backup === 'function') {
    await db.backup(emergencyPath);
  } else {
    fs.copyFileSync(sourcePath, emergencyPath);
  }

  return emergencyPath;
}

function moveCurrentDatabaseFiles(config, now = new Date()) {
  const sourcePath = resolveDatabasePath(config.databasePath || 'data/history.sqlite');

  if (!fs.existsSync(sourcePath)) {
    return [];
  }

  const emergencyDir = getEmergencyDirectory(config);
  const stamp = formatTimestampForBackup(now);
  const basename = path.basename(sourcePath);
  const moved = [];

  [sourcePath, `${sourcePath}-wal`, `${sourcePath}-shm`].forEach((filePath) => {
    if (!fs.existsSync(filePath)) {
      return;
    }

    const suffix = filePath === sourcePath ? '' : path.basename(filePath).slice(basename.length);
    const destination = path.join(emergencyDir, `moved-current-${stamp}${suffix}-${basename}`);
    fs.renameSync(filePath, destination);
    moved.push(destination);
  });

  return moved;
}

function copyBackupIntoDatabase(config, backupPath) {
  const targetPath = resolveDatabasePath(config.databasePath || 'data/history.sqlite');
  ensureDirectory(path.dirname(targetPath));
  fs.copyFileSync(backupPath, targetPath);
  return targetPath;
}

function closeDatabase(db) {
  if (db && typeof db.close === 'function' && db.open !== false) {
    db.close();
  }
}

function stopSchedulers(app) {
  const jobScheduler = app && app.get('jobScheduler');
  const recentRefreshScheduler = app && app.get('recentRefreshScheduler');

  if (jobScheduler && jobScheduler.activeJobs && jobScheduler.activeJobs.size > 0) {
    const error = new Error('Cannot restore while scheduler jobs are active. Wait for active jobs to finish and retry.');
    error.status = 409;
    throw error;
  }

  if (recentRefreshScheduler) {
    if (typeof recentRefreshScheduler.pause === 'function') {
      recentRefreshScheduler.pause();
    } else if (typeof recentRefreshScheduler.stopTimer === 'function') {
      recentRefreshScheduler.stopTimer();
    }
  }

  if (jobScheduler) {
    if (typeof jobScheduler.stopDailyBackupJob === 'function') {
      jobScheduler.stopDailyBackupJob();
    }

    if (Array.isArray(jobScheduler.queue)) {
      jobScheduler.queue = [];
    }
  }

  return { jobScheduler, recentRefreshScheduler };
}

function restartAppState(app, config) {
  const assets = loadAssets(config.assetsConfigPath);
  const db = initializeDatabase(config);
  const jobScheduler = createScheduler({ db, config });
  const recentRefreshScheduler = createRecentRefreshScheduler({ db, jobScheduler, assets });
  const hotReloadManager = app.get('hotReloadManager');

  app.set('db', db);
  app.set('assets', assets);
  app.set('jobScheduler', jobScheduler);
  app.set('recentRefreshScheduler', recentRefreshScheduler);

  if (hotReloadManager) {
    hotReloadManager.db = db;
    hotReloadManager.jobScheduler = jobScheduler;
    hotReloadManager.recentRefreshScheduler = recentRefreshScheduler;
    hotReloadManager.assets = [...assets];
  }

  recentRefreshScheduler.start();
  jobScheduler.startDailyBackupJob();
  jobScheduler.process();

  return { db, assets, jobScheduler, recentRefreshScheduler };
}

async function restoreBackup(config, options = {}) {
  const actor = options.actor || 'unknown';
  let backupPath = null;

  try {
    backupPath = resolveBackupPath(config, options.backupPath);
    validateConfirmation(backupPath, options.confirmation || path.basename(backupPath));
    validateSQLiteBackup(backupPath);

    const now = options.now instanceof Date ? options.now : new Date();
    const existingDb = options.db || null;

    if (options.app) {
      stopSchedulers(options.app);
    }

    const emergencyBackupPath = await createEmergencyBackup(config, existingDb, now);

    closeDatabase(existingDb);

    const movedDatabaseFiles = moveCurrentDatabaseFiles(config, now);
    const restoredDatabasePath = copyBackupIntoDatabase(config, backupPath);
    const restoredDb = options.app ? null : initializeDatabase(config, { syncAssets: false });

    if (restoredDb) {
      try {
        runMigrations(restoredDb);
      } finally {
        restoredDb.close();
      }
    }

    let restarted = null;

    if (options.app) {
      restarted = restartAppState(options.app, config);
    }

    const result = {
      backupPath,
      backupFileName: path.basename(backupPath),
      restoredDatabasePath,
      emergencyBackupPath,
      movedDatabaseFiles,
      restarted: Boolean(restarted)
    };

    appendRestoreAttempt(config, {
      actor,
      status: 'success',
      backupPath,
      emergencyBackupPath,
      restoredDatabasePath
    });
    logger.warn(`Restored database from ${backupPath}; emergency backup: ${emergencyBackupPath || 'none'}.`);

    return result;
  } catch (error) {
    appendRestoreAttempt(config, {
      actor,
      status: 'failed',
      backupPath: backupPath || String(options.backupPath || ''),
      error: error.message
    });
    logger.error(`Restore attempt failed for ${backupPath || options.backupPath || 'unknown backup'}: ${error.message}`);
    throw error;
  }
}

function listRestoreBackups(config) {
  return createBackupService({ config }).listBackups();
}

module.exports = {
  EXPECTED_TABLES,
  RESTORE_CONFIRMATION_PHRASE,
  appendRestoreAttempt,
  getRestoreLogPath,
  listRestoreBackups,
  resolveBackupPath,
  restoreBackup,
  validateConfirmation,
  validateSQLiteBackup
};
