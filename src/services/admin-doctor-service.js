const fs = require('fs');
const path = require('path');

const { runDatabaseIntegrityCheck } = require('./db-integrity-service');
const { getAssetStaleness } = require('./staleness-service');
const { validateAssetsFile } = require('./asset-service');
const { loadServerConfig } = require('../utils/config');
const { resolveFromRoot } = require('../utils/files');

const DAY_MS = 24 * 60 * 60 * 1000;
const BACKUP_WARNING_MS = 2 * DAY_MS;
const BACKUP_CRITICAL_MS = 7 * DAY_MS;
const LOW_DISK_WARNING_BYTES = 2 * 1024 * 1024 * 1024;
const LOW_DISK_CRITICAL_BYTES = 512 * 1024 * 1024;

function isoOrNull(value) {
  return value === null || value === undefined ? null : new Date(value).toISOString();
}

function bytesToSummary(bytes) {
  if (bytes === null || bytes === undefined) {
    return 'Unavailable';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = Number(bytes);
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function buildIssue(id, label, severity, explanation, recommendedAction, options = {}) {
  return {
    id,
    label,
    severity,
    explanation,
    recommendedAction,
    details: options.details || [],
    safeFixes: options.safeFixes || [],
    dangerousFixes: options.dangerousFixes || []
  };
}

function buildFix(action, label, options = {}) {
  return {
    action,
    label,
    description: options.description || '',
    dangerous: options.dangerous === true,
    confirmationPhrase: options.confirmationPhrase || null
  };
}

function listFilesRecursive(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }

  const files = [];
  const scan = (currentDir, prefix = '') => {
    fs.readdirSync(currentDir, { withFileTypes: true }).forEach((entry) => {
      if (entry.name.startsWith('.')) {
        return;
      }

      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = path.join(prefix, entry.name);

      if (entry.isDirectory()) {
        scan(absolutePath, relativePath);
        return;
      }

      if (!entry.isFile()) {
        return;
      }

      const stats = fs.statSync(absolutePath);
      files.push({
        name: relativePath,
        path: path.relative(process.cwd(), absolutePath),
        sizeBytes: stats.size,
        sizeLabel: bytesToSummary(stats.size),
        updatedAt: stats.mtimeMs,
        updatedAtIso: isoOrNull(stats.mtimeMs)
      });
    });
  };

  scan(directory);
  return files.sort((left, right) => right.updatedAt - left.updatedAt);
}

function getDiskSpace(projectDir) {
  const resolvedProjectDir = path.resolve(projectDir || process.cwd());

  if (typeof fs.statfsSync !== 'function') {
    return { supported: false, path: resolvedProjectDir, availableBytes: null, totalBytes: null };
  }

  const stats = fs.statfsSync(resolvedProjectDir);
  const blockSize = Number(stats.bsize || 0);

  return {
    supported: true,
    path: resolvedProjectDir,
    availableBytes: Number(stats.bavail) * blockSize,
    totalBytes: Number(stats.blocks) * blockSize
  };
}

function summarizeIssues(issues) {
  return issues.reduce((summary, issue) => {
    summary[issue.severity] = (summary[issue.severity] || 0) + 1;
    return summary;
  }, { ok: 0, info: 0, warning: 0, critical: 0 });
}

function buildAdminDoctorReport(options = {}) {
  const app = options.app;
  const db = options.db;
  const config = options.config || app.get('config') || {};
  const assets = options.assets || app.get('assets') || [];
  const scheduler = options.scheduler || app.get('jobScheduler');
  const recentRefreshScheduler = options.recentRefreshScheduler || app.get('recentRefreshScheduler');
  const backupService = options.backupService;
  const now = options.now || Date.now();
  const issues = [];

  try {
    const startupSelfCheck = app.get('startupSelfCheck');
    if (startupSelfCheck && startupSelfCheck.degraded) {
      issues.push(buildIssue(
        'self_check_degraded',
        'Self-check',
        'warning',
        'Startup self-check reported degraded mode.',
        'Review the startup self-check details, fix the failing runtime prerequisite, then reload config or restart the app.',
        { details: startupSelfCheck.checks || [], safeFixes: [buildFix('reload-config', 'Reload config')] }
      ));
    } else {
      issues.push(buildIssue('self_check_ok', 'Self-check', 'ok', 'Startup self-check and runtime heartbeat are healthy.', 'No action needed.'));
    }
  } catch (error) {
    issues.push(buildIssue('self_check_error', 'Self-check', 'critical', error.message, 'Restart the app and inspect logs for startup failures.'));
  }

  try {
    const integrity = runDatabaseIntegrityCheck(db);
    const failedChecks = integrity.checks.filter((check) => check.status !== 'ok');
    issues.push(buildIssue(
      'database_integrity',
      'Database integrity',
      integrity.ok ? 'ok' : 'critical',
      integrity.ok ? 'SQLite integrity and schema checks passed.' : `${failedChecks.length} database integrity check(s) need attention.`,
      integrity.ok ? 'No action needed.' : 'Open the database integrity page, create a backup, and apply the safest targeted repair first.',
      {
        details: failedChecks,
        safeFixes: failedChecks.some((check) => check.id === 'fetch_runs_stuck_running')
          ? [buildFix('mark-stuck-fetch-runs-failed', 'Mark stuck fetch runs failed')]
          : []
      }
    ));
  } catch (error) {
    issues.push(buildIssue('database_integrity_error', 'Database integrity', 'critical', error.message, 'Create a backup if possible, then inspect database connectivity and migrations.'));
  }

  try {
    const validatedAssets = validateAssetsFile(config.assetsConfigPath || './config/assets.json');
    loadServerConfig();
    issues.push(buildIssue(
      'config_validation',
      'Config validation',
      'ok',
      `Server config and ${validatedAssets.length} asset definition(s) validated.`,
      'No action needed.',
      { safeFixes: [buildFix('reload-config', 'Reload config')] }
    ));
  } catch (error) {
    issues.push(buildIssue(
      'config_validation',
      'Config validation',
      'critical',
      error.message,
      'Fix the invalid config file, then use reload config to refresh runtime state.',
      { details: error.errors || [], safeFixes: [buildFix('reload-config', 'Reload config')] }
    ));
  }

  try {
    const queueStatus = scheduler && typeof scheduler.getStatus === 'function' ? scheduler.getStatus() : null;
    const refreshStatus = recentRefreshScheduler && typeof recentRefreshScheduler.getStatus === 'function' ? recentRefreshScheduler.getStatus() : null;
    const severity = !refreshStatus || !refreshStatus.enabled ? 'warning' : (refreshStatus.paused ? 'warning' : 'ok');
    const state = !refreshStatus || !refreshStatus.enabled ? 'not running' : (refreshStatus.paused ? 'paused' : 'running');
    issues.push(buildIssue(
      'scheduler_status',
      'Scheduler status',
      severity,
      `Recent refresh scheduler is ${state}; queue depth is ${queueStatus ? queueStatus.depth : 'unavailable'}.`,
      severity === 'ok' ? 'No action needed.' : 'Resume the scheduler when maintenance is complete, or pause it while making changes.',
      {
        details: { queue: queueStatus, recentRefresh: refreshStatus },
        safeFixes: [
          buildFix('pause-scheduler', 'Pause scheduler'),
          buildFix('resume-scheduler', 'Resume scheduler')
        ]
      }
    ));
  } catch (error) {
    issues.push(buildIssue('scheduler_status_error', 'Scheduler status', 'critical', error.message, 'Check scheduler logs and restart the app if the scheduler cannot be inspected.'));
  }

  try {
    const staleAssets = assets
      .filter((asset) => asset.enabled)
      .map((asset) => ({ asset, staleness: getAssetStaleness(db, asset, { jobScheduler: scheduler }) }))
      .filter((entry) => entry.staleness && ['stale', 'empty'].includes(entry.staleness.status));
    issues.push(buildIssue(
      'stale_asset_detection',
      'Stale asset detection',
      staleAssets.length > 0 ? 'warning' : 'ok',
      staleAssets.length > 0 ? `${staleAssets.length} enabled asset(s) are stale or empty.` : 'No stale enabled assets detected.',
      staleAssets.length > 0 ? 'Enqueue repair jobs for stale assets and monitor failed fetches.' : 'No action needed.',
      {
        details: staleAssets.map((entry) => ({ assetId: entry.asset.id, symbol: entry.asset.symbol, staleness: entry.staleness })),
        safeFixes: staleAssets.length > 0 ? [buildFix('repair-stale-assets', 'Repair stale assets')] : []
      }
    ));
  } catch (error) {
    issues.push(buildIssue('stale_asset_detection_error', 'Stale asset detection', 'critical', error.message, 'Check asset config and candle tables before enqueueing repairs.'));
  }

  try {
    const failedJobs = scheduler && typeof scheduler.listJobs === 'function' ? scheduler.listJobs({ statuses: ['failed'], limit: 100 }) : [];
    issues.push(buildIssue(
      'failed_job_detection',
      'Failed job detection',
      failedJobs.length > 0 ? 'warning' : 'ok',
      failedJobs.length > 0 ? `${failedJobs.length} failed job(s) found.` : 'No failed jobs found.',
      failedJobs.length > 0 ? 'Retry failed jobs after checking the latest error message.' : 'No action needed.',
      {
        details: failedJobs,
        safeFixes: failedJobs.length > 0 ? [buildFix('retry-failed-jobs', 'Retry failed jobs')] : []
      }
    ));
  } catch (error) {
    issues.push(buildIssue('failed_job_detection_error', 'Failed job detection', 'critical', error.message, 'Inspect the jobs table and scheduler state.'));
  }

  try {
    const backups = backupService ? backupService.listBackups() : [];
    const latestBackup = backups[0] || null;
    const ageMs = latestBackup && latestBackup.createdAtMs ? now - latestBackup.createdAtMs : null;
    const severity = !latestBackup || ageMs > BACKUP_CRITICAL_MS ? 'critical' : (ageMs > BACKUP_WARNING_MS ? 'warning' : 'ok');
    issues.push(buildIssue(
      'backup_freshness',
      'Backup freshness',
      severity,
      latestBackup ? `Latest backup: ${latestBackup.createdAt}.` : 'No backups found.',
      severity === 'ok' ? 'No action needed.' : 'Create a backup now before making other repairs.',
      {
        details: latestBackup ? { ...latestBackup, ageMs } : null,
        safeFixes: [buildFix('create-backup', 'Create backup now')]
      }
    ));
  } catch (error) {
    issues.push(buildIssue('backup_freshness_error', 'Backup freshness', 'critical', error.message, 'Check backup directory permissions, then create a backup.'));
  }

  try {
    const disk = getDiskSpace(process.cwd());
    let severity = 'ok';
    if (!disk.supported) {
      severity = 'warning';
    } else if (disk.availableBytes < LOW_DISK_CRITICAL_BYTES) {
      severity = 'critical';
    } else if (disk.availableBytes < LOW_DISK_WARNING_BYTES) {
      severity = 'warning';
    }
    issues.push(buildIssue(
      'disk_space_check',
      'Disk space check',
      severity,
      disk.supported ? `${bytesToSummary(disk.availableBytes)} available.` : 'Disk space check is not supported by this runtime.',
      severity === 'ok' ? 'No action needed.' : 'Free disk space, move old exports/backups off-host, or expand the volume before running imports.',
      { details: disk }
    ));
  } catch (error) {
    issues.push(buildIssue('disk_space_check_error', 'Disk space check', 'critical', error.message, 'Check filesystem access and host disk availability.'));
  }

  try {
    const importsDir = resolveFromRoot(path.join(config.dataDir || 'data', 'imports'));
    const importFiles = listFilesRecursive(importsDir);
    issues.push(buildIssue(
      'import_folder_scan',
      'Import folder scan',
      importFiles.length > 0 ? 'info' : 'ok',
      importFiles.length > 0 ? `${importFiles.length} import file(s) are waiting in data/imports.` : 'No pending import files found.',
      importFiles.length > 0 ? 'Review and import or remove pending files from the imports page.' : 'No action needed.',
      { details: importFiles.slice(0, 25) }
    ));
  } catch (error) {
    issues.push(buildIssue('import_folder_scan_error', 'Import folder scan', 'critical', error.message, 'Check data/imports permissions and file names.'));
  }

  const summary = summarizeIssues(issues);
  const overall = summary.critical > 0 ? 'critical' : (summary.warning > 0 ? 'warning' : (summary.info > 0 ? 'info' : 'ok'));

  return {
    ok: overall !== 'critical',
    status: overall,
    generatedAt: now,
    generatedAtIso: isoOrNull(now),
    summary,
    issues,
    cleanupFixes: [buildFix('clear-completed-jobs', 'Clear completed jobs older than 7 days')]
  };
}

module.exports = {
  buildAdminDoctorReport,
  bytesToSummary
};
