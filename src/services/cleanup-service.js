const fs = require('fs');
const path = require('path');

const { createBackupService } = require('./backup-service');
const { LOG_FILES, rotateLogFile } = require('./log-service');
const { buildSystemHealth } = require('./system-health');
const { createAlertsFromHealthReport, resolveActiveAlert } = require('./alert-service');
const { resolveFromRoot } = require('../utils/files');
const logger = require('../utils/logger');

const DAY_MS = 24 * 60 * 60 * 1000;
const COMPLETED_JOB_RETENTION_DAYS = 14;

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function toIso(value) {
  return value === null || value === undefined ? null : new Date(value).toISOString();
}

function countChanges(result) {
  return Number(result && result.changes ? result.changes : 0);
}

function readSummary(row) {
  if (!row || !row.summary_json) {
    return null;
  }

  try {
    return JSON.parse(row.summary_json);
  } catch (error) {
    return { parseError: error.message };
  }
}

function normalizeCleanupRun(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    startedAt: row.started_at,
    startedAtIso: toIso(row.started_at),
    finishedAt: row.finished_at,
    finishedAtIso: toIso(row.finished_at),
    status: row.status,
    summary: readSummary(row),
    error: row.error
  };
}

function getImportsDirectory(config) {
  return resolveFromRoot(path.join(config.dataDir || 'data', 'imports'));
}

function getImportArchiveDirectory(config) {
  return path.join(getImportsDirectory(config), 'archive');
}

function isInsideDirectory(baseDir, candidatePath) {
  const base = path.resolve(baseDir);
  const candidate = path.resolve(candidatePath);
  return candidate === base || candidate.startsWith(`${base}${path.sep}`);
}

function isArchivableImportPath(config, filePath) {
  if (!filePath) {
    return false;
  }

  const importsDir = getImportsDirectory(config);
  const archiveDir = getImportArchiveDirectory(config);
  const resolved = path.resolve(filePath);

  if (!isInsideDirectory(importsDir, resolved) || isInsideDirectory(archiveDir, resolved)) {
    return false;
  }

  const relative = path.relative(importsDir, resolved);
  const firstPart = relative.split(path.sep)[0];
  return !['archive', 'failed'].includes(firstPart);
}

function uniqueArchivePath(archiveDir, importFile) {
  const safeBase = path.basename(importFile.filename || importFile.fullPath || `import-${importFile.id}`) || `import-${importFile.id}`;
  const prefix = `${Date.now()}-${importFile.id}`;
  let targetPath = path.join(archiveDir, `${prefix}-${safeBase}`);
  let index = 1;

  while (fs.existsSync(targetPath)) {
    targetPath = path.join(archiveDir, `${prefix}-${index}-${safeBase}`);
    index += 1;
  }

  return targetPath;
}

class CleanupService {
  constructor(options = {}) {
    if (!options.db) {
      throw new Error('CleanupService requires a database connection.');
    }

    this.db = options.db;
    this.config = options.config || {};
    this.backupService = options.backupService || createBackupService({ db: this.db, config: this.config });
    this.app = options.app || null;
  }

  getLastRun() {
    const row = this.db.prepare('SELECT * FROM cleanup_runs ORDER BY finished_at DESC, id DESC LIMIT 1').get();
    return normalizeCleanupRun(row);
  }

  pruneExpiredApiCache(now) {
    const result = this.db.prepare('DELETE FROM api_cache WHERE expires_at < @now').run({ now });
    return { rowsDeleted: countChanges(result) };
  }

  clearCompletedJobs(now) {
    const cutoff = now - (COMPLETED_JOB_RETENTION_DAYS * DAY_MS);
    const result = this.db.prepare("DELETE FROM jobs WHERE status = 'completed' AND updated_at < @cutoff").run({ cutoff });
    return {
      rowsDeleted: countChanges(result),
      retentionDays: COMPLETED_JOB_RETENTION_DAYS,
      cutoff,
      cutoffIso: toIso(cutoff)
    };
  }

  rotateLogs() {
    const logDir = resolveFromRoot(this.config.logDir || 'logs');
    ensureDirectory(logDir);
    const rotated = [];

    LOG_FILES.forEach((fileName) => {
      const filePath = path.join(logDir, fileName);
      fs.closeSync(fs.openSync(filePath, 'a'));
      if (rotateLogFile(filePath)) {
        rotated.push(fileName);
      }
    });

    return { rotatedFiles: rotated, checkedFiles: LOG_FILES.length };
  }

  pruneBackups() {
    const result = this.backupService.pruneBackups();
    return {
      kept: result.kept,
      pruned: result.pruned,
      deletedFiles: result.deletedFiles,
      backups: result.backups
    };
  }

  archiveImportedFiles() {
    const importsDir = getImportsDirectory(this.config);
    const archiveDir = getImportArchiveDirectory(this.config);
    ensureDirectory(importsDir);
    ensureDirectory(archiveDir);

    const rows = this.db.prepare(`
      SELECT id, filename, full_path, rows_imported, updated_at
      FROM import_files
      WHERE status = 'imported'
      ORDER BY updated_at ASC, id ASC
    `).all();
    const archived = [];
    let skipped = 0;

    rows.forEach((row) => {
      const sourcePath = path.resolve(row.full_path || path.join(importsDir, row.filename || ''));
      if (!isArchivableImportPath(this.config, sourcePath) || !fs.existsSync(sourcePath)) {
        skipped += 1;
        return;
      }

      const stats = fs.lstatSync(sourcePath);
      if (!stats.isFile()) {
        skipped += 1;
        return;
      }

      const targetPath = uniqueArchivePath(archiveDir, row);
      fs.renameSync(sourcePath, targetPath);
      const relativeName = path.relative(importsDir, targetPath);
      this.db.prepare(`
        UPDATE import_files
        SET status = 'archived', full_path = @targetPath, filename = @filename, updated_at = @now, last_error = NULL
        WHERE id = @id
      `).run({ id: row.id, targetPath, filename: relativeName, now: Date.now() });
      archived.push({ id: row.id, filename: relativeName, rowsImported: row.rows_imported });
    });

    return { archived: archived.length, skipped, files: archived };
  }

  resolveStaleAlerts(now) {
    if (!this.app) {
      return { resolved: 0, skipped: true, reason: 'No app context available.' };
    }

    const report = buildSystemHealth(this.app, { now });
    createAlertsFromHealthReport(this.db, report);

    let resolved = 0;
    const resolve = (type, entityType, entityId) => {
      const before = this.db.prepare(`
        SELECT COUNT(*) AS count FROM alerts
        WHERE type = @type
          AND COALESCE(entity_type, '') = COALESCE(@entityType, '')
          AND COALESCE(entity_id, '') = COALESCE(@entityId, '')
          AND status IN ('open', 'acknowledged')
      `).get({ type, entityType, entityId }).count;
      resolveActiveAlert(this.db, type, entityType, entityId);
      resolved += Number(before || 0);
    };

    const byId = new Map(report.checks.map((check) => [check.id, check]));
    const backup = byId.get('latest_backup_time');
    if (backup && backup.status === 'ok') {
      resolve('backup_overdue', 'backup', 'sqlite');
    }

    const disk = byId.get('project_free_disk_space');
    if (disk && disk.status === 'ok') {
      resolve('disk_space_low', 'system', 'project_disk');
    }

    const scheduler = byId.get('scheduler_state');
    if (scheduler && (scheduler.status === 'ok' || scheduler.value === 'paused')) {
      resolve('scheduler_stopped_unexpectedly', 'scheduler', 'recent-refresh');
    }

    const stale = byId.get('assets_with_stale_data');
    if (stale && Array.isArray(stale.details)) {
      const staleAssetIds = new Set(stale.details.map((asset) => asset.assetId));
      const activeRows = this.db.prepare(`
        SELECT entity_id AS entityId
        FROM alerts
        WHERE type = 'asset_stale_too_long'
          AND entity_type = 'asset'
          AND status IN ('open', 'acknowledged')
      `).all();
      activeRows.forEach((row) => {
        if (!staleAssetIds.has(row.entityId)) {
          resolve('asset_stale_too_long', 'asset', row.entityId);
        }
      });
    }

    return { resolved, checkedAt: now, checkedAtIso: toIso(now) };
  }

  run(options = {}) {
    const startedAt = options.now || Date.now();
    const insert = this.db.prepare(`
      INSERT INTO cleanup_runs (started_at, finished_at, status, summary_json, error)
      VALUES (@startedAt, NULL, 'running', NULL, NULL)
    `).run({ startedAt });
    const runId = insert.lastInsertRowid;

    try {
      const summary = {
        apiCache: this.pruneExpiredApiCache(startedAt),
        completedJobs: this.clearCompletedJobs(startedAt),
        logs: this.rotateLogs(),
        backups: this.pruneBackups(),
        importedFiles: this.archiveImportedFiles(),
        alerts: this.resolveStaleAlerts(startedAt),
        historicalCandlesDeleted: 0
      };
      const finishedAt = Date.now();
      this.db.prepare(`
        UPDATE cleanup_runs
        SET finished_at = @finishedAt, status = 'completed', summary_json = @summaryJson, error = NULL
        WHERE id = @id
      `).run({ id: runId, finishedAt, summaryJson: JSON.stringify(summary) });
      logger.jobInfo(`Cleanup completed: ${JSON.stringify(summary)}`);
      return normalizeCleanupRun({ id: runId, started_at: startedAt, finished_at: finishedAt, status: 'completed', summary_json: JSON.stringify(summary), error: null });
    } catch (error) {
      const finishedAt = Date.now();
      this.db.prepare(`
        UPDATE cleanup_runs
        SET finished_at = @finishedAt, status = 'failed', error = @error
        WHERE id = @id
      `).run({ id: runId, finishedAt, error: error.stack || error.message });
      logger.jobError(`Cleanup failed: ${error.message}`);
      throw error;
    }
  }
}

function createCleanupService(options) {
  return new CleanupService(options);
}

module.exports = {
  CleanupService,
  COMPLETED_JOB_RETENTION_DAYS,
  createCleanupService
};
