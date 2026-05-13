const os = require('os');
const logger = require('../utils/logger');
const { getGlobalLimiter } = require('../utils/limiter');
const { FETCH_JOB_TYPES, runFetchHistoryJob } = require('./fetch-history-job');
const { createBackupService } = require('../services/backup-service');
const { createAlert } = require('../services/alert-service');

const JOB_TYPES = new Set([
  'recent_refresh',
  'historical_backfill',
  'gap_repair',
  'manual_admin_fetch',
  'sqlite_backup'
]);

const JOB_STATUSES = new Set([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'delayed'
]);

const PRIORITIES = {
  manual_admin_fetch: 1,
  gap_repair: 2,
  recent_refresh: 3,
  historical_backfill: 4,
  sqlite_backup: 5
};

const DEFAULT_FAILURE_LIMIT = 10;
const DEFAULT_MAX_ATTEMPTS = 3;
const STUCK_RUNNING_MS = 30 * 60 * 1000;

function safeParsePayload(payloadJson) {
  if (!payloadJson) {
    return {};
  }

  try {
    return JSON.parse(payloadJson);
  } catch (error) {
    return {};
  }
}

function rowToJob(row) {
  if (!row) {
    return null;
  }

  const payload = safeParsePayload(row.payload_json);

  return {
    id: row.id,
    type: row.type,
    priority: row.priority,
    status: row.status,
    payload,
    payloadJson: row.payload_json,
    assetPriority: Number.isFinite(Number(payload.assetPriority)) ? Number(payload.assetPriority) : Number.MAX_SAFE_INTEGER,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAfter: row.run_after,
    lockedAt: row.locked_at,
    lockedBy: row.locked_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastError: row.last_error,
    enqueuedAt: row.created_at,
    startedAt: row.locked_at,
    finishedAt: ['completed', 'failed', 'cancelled'].includes(row.status) ? row.updated_at : null,
    error: row.last_error || null
  };
}

function cloneJob(job) {
  if (!job) {
    return null;
  }

  return {
    id: job.id,
    type: job.type,
    priority: job.priority,
    status: job.status,
    payload: { ...(job.payload || {}) },
    assetPriority: job.assetPriority,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    runAfter: job.runAfter,
    lockedAt: job.lockedAt,
    lockedBy: job.lockedBy,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    enqueuedAt: job.enqueuedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error || job.lastError || null,
    lastError: job.lastError || job.error || null
  };
}

function normalizeConcurrency(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function normalizeMaxAttempts(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_ATTEMPTS;
}

class JobScheduler {
  constructor(options = {}) {
    this.db = options.db;
    this.concurrency = normalizeConcurrency(options.concurrency || process.env.JOB_QUEUE_CONCURRENCY);
    this.queue = [];
    this.activeJobs = new Map();
    this.recentFailures = [];
    this.handlers = new Map();
    this.running = false;
    this.limiter = options.limiter || getGlobalLimiter();
    this.config = options.config || null;
    this.maintenanceMode = Boolean(this.config && this.config.maintenanceMode);
    this.backupService = options.backupService || (this.config ? createBackupService({ db: this.db, config: this.config }) : null);
    this.backupTimer = null;
    this.wakeTimer = null;
    this.nextBackupAt = null;
    this.workerId = options.workerId || `${os.hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 10)}`;

    if (!this.db) {
      throw new Error('JobScheduler requires a SQLite database connection.');
    }

    FETCH_JOB_TYPES.forEach((type) => {
      this.handlers.set(type, (job) => runFetchHistoryJob(job, { db: this.db }));
    });

    this.handlers.set('sqlite_backup', () => this.runBackupJob());
    this.recoverStuckJobs();
  }

  recoverStuckJobs(now = Date.now()) {
    const staleBefore = now - STUCK_RUNNING_MS;
    const rows = this.db.prepare(`
      SELECT * FROM jobs
      WHERE status = 'running' AND locked_at IS NOT NULL AND locked_at < @staleBefore
      ORDER BY locked_at ASC
    `).all({ staleBefore });

    const failJob = this.db.prepare(`
      UPDATE jobs
      SET status = 'failed', locked_at = NULL, locked_by = NULL, updated_at = @now,
          last_error = COALESCE(last_error, 'Recovered stale running job that exceeded max attempts.')
      WHERE id = @id
    `);
    const requeueJob = this.db.prepare(`
      UPDATE jobs
      SET status = 'queued', locked_at = NULL, locked_by = NULL, run_after = @now,
          updated_at = @now, last_error = COALESCE(last_error, 'Recovered stale running job after restart.')
      WHERE id = @id
    `);

    rows.forEach((row) => {
      if (row.attempts >= row.max_attempts) {
        failJob.run({ id: row.id, now });
      } else {
        requeueJob.run({ id: row.id, now });
      }
    });

    if (rows.length > 0) {
      logger.jobWarn(`Recovered ${rows.length} stale running job(s) older than 30 minutes.`);
    }

    return rows.length;
  }

  async runBackupJob() {
    if (!this.backupService) {
      throw new Error('Backup service is not configured.');
    }

    const backup = await this.backupService.createBackup();
    const pruneResult = this.backupService.pruneBackups();

    return { backup, pruneResult };
  }

  startDailyBackupJob(options = {}) {
    if (!this.backupService) {
      throw new Error('Backup service is not configured.');
    }

    this.stopDailyBackupJob();

    const now = options.now || Date.now();
    const firstRunAt = options.firstRunAt || this.getNextDailyBackupAt(now);
    const delay = Math.max(0, firstRunAt - now);
    this.nextBackupAt = now + delay;
    this.backupTimer = setTimeout(() => {
      this.backupTimer = null;
      this.enqueue('sqlite_backup', { reason: 'daily' });
      this.startDailyBackupJob();
    }, delay);

    if (typeof this.backupTimer.unref === 'function') {
      this.backupTimer.unref();
    }

    logger.jobInfo(`Daily SQLite backup job scheduled for ${new Date(this.nextBackupAt).toISOString()}.`);
    return this.nextBackupAt;
  }

  getNextDailyBackupAt(now = Date.now()) {
    const date = new Date(now);
    date.setUTCHours(2, 0, 0, 0);

    if (date.getTime() <= now) {
      date.setUTCDate(date.getUTCDate() + 1);
    }

    return date.getTime();
  }

  stopDailyBackupJob() {
    if (this.backupTimer) {
      clearTimeout(this.backupTimer);
      this.backupTimer = null;
    }

    this.nextBackupAt = null;
  }

  stopQueueWakeTimer() {
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
  }

  scheduleNextDelayedJob(now = Date.now()) {
    this.stopQueueWakeTimer();
    const row = this.db.prepare("SELECT MIN(run_after) AS runAfter FROM jobs WHERE status = 'delayed' OR (status = 'queued' AND run_after > @now)").get({ now });

    if (!row || !row.runAfter) {
      return null;
    }

    const delay = Math.max(0, row.runAfter - now);
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.process();
    }, delay);

    if (typeof this.wakeTimer.unref === 'function') {
      this.wakeTimer.unref();
    }

    return row.runAfter;
  }

  register(type, handler) {
    if (!JOB_TYPES.has(type)) {
      throw new Error(`Unsupported job type: ${type}`);
    }

    if (typeof handler !== 'function') {
      throw new Error('Job handler must be a function.');
    }

    this.handlers.set(type, handler);
  }

  setMaintenanceMode(enabled) {
    this.maintenanceMode = Boolean(enabled);

    if (!this.maintenanceMode) {
      this.process();
    }

    return this.getStatus();
  }

  enqueue(type, payload = {}, options = {}) {
    if (!JOB_TYPES.has(type)) {
      throw new Error(`Unsupported job type: ${type}`);
    }

    if (this.maintenanceMode && FETCH_JOB_TYPES.has(type)) {
      const error = new Error('Maintenance mode is active; CoinGecko fetch jobs are paused.');
      error.status = 503;
      error.code = 'maintenance_mode';
      throw error;
    }

    const now = Date.now();
    const runAfter = Number.isFinite(Number(options.runAfter)) ? Number(options.runAfter) : now;
    const status = runAfter > now ? 'delayed' : 'queued';
    const payloadJson = JSON.stringify({ ...payload });
    const result = this.db.prepare(`
      INSERT INTO jobs (type, payload_json, priority, status, attempts, max_attempts, run_after, locked_at, locked_by, created_at, updated_at, last_error)
      VALUES (@type, @payloadJson, @priority, @status, 0, @maxAttempts, @runAfter, NULL, NULL, @now, @now, NULL)
    `).run({
      type,
      payloadJson,
      priority: Number.isFinite(Number(options.priority)) ? Number(options.priority) : PRIORITIES[type],
      status,
      maxAttempts: normalizeMaxAttempts(options.maxAttempts),
      runAfter,
      now
    });

    const job = this.getJob(result.lastInsertRowid);
    logger.jobInfo(`Queued ${type} job #${job.id} for asset ${payload.assetId || 'n/a'}.`);

    if (options.autoStart !== false) {
      this.process();
    } else {
      this.scheduleNextDelayedJob();
    }

    return cloneJob(job);
  }

  sortQueue() {}

  hasPendingJob(predicate) {
    return this.listJobs({ statuses: ['queued', 'delayed', 'running'], limit: 1000 }).some(predicate);
  }

  removeQueuedJobs(predicate) {
    const jobs = this.listJobs({ statuses: ['queued', 'delayed'], limit: 10000 });
    const ids = jobs.filter(predicate).map((job) => job.id);

    ids.forEach((id) => this.cancelJob(id));
    return ids.length;
  }

  hasRunnableQueuedJob() {
    return this.countRunnableJobs() > 0;
  }

  process() {
    if (this.running) {
      return;
    }

    this.running = true;
    setImmediate(() => this.drain());
  }

  async drain() {
    try {
      while (this.activeJobs.size < this.concurrency) {
        const job = this.claimNextJob();

        if (!job) {
          break;
        }

        this.runJob(job);
      }
    } finally {
      this.running = false;

      if (this.hasRunnableQueuedJob() && this.activeJobs.size < this.concurrency) {
        this.process();
      } else {
        this.scheduleNextDelayedJob();
      }
    }
  }

  claimNextJob(now = Date.now()) {
    const claim = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM jobs
        WHERE status IN ('queued', 'delayed')
          AND run_after <= @now
          ${this.maintenanceMode ? `AND type NOT IN (${Array.from(FETCH_JOB_TYPES).map((type) => `'${type}'`).join(',')})` : ''}
        ORDER BY priority ASC, id ASC
        LIMIT 1
      `).get({ now });

      if (!row) {
        return null;
      }

      this.db.prepare(`
        UPDATE jobs
        SET status = 'running', attempts = attempts + 1, locked_at = @now, locked_by = @workerId,
            updated_at = @now, last_error = NULL
        WHERE id = @id
      `).run({ id: row.id, now, workerId: this.workerId });

      return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(row.id);
    });

    return rowToJob(claim());
  }

  async runJob(job) {
    const handler = this.handlers.get(job.type);

    if (!handler) {
      this.markJobFailed(job, `No handler registered for ${job.type}.`);
      this.recordFailure({ ...job, status: 'failed', error: `No handler registered for ${job.type}.` });
      return;
    }

    this.activeJobs.set(job.id, job);
    logger.jobInfo(`Starting ${job.type} job #${job.id}.`);

    try {
      const result = await handler(job, this);
      job.result = result;
      if (!this.isJobCancelled(job.id)) {
        this.markJobCompleted(job.id);
        logger.jobInfo(`Finished ${job.type} job #${job.id}.`);
      }
    } catch (error) {
      const failedJob = this.markJobFailed(job, error.message);
      this.recordFailure(failedJob || { ...job, status: 'failed', error: error.message });
      if (failedJob && failedJob.status === 'failed' && FETCH_JOB_TYPES.has(job.type)) {
        createAlert(this.db, {
          severity: 'critical',
          type: 'asset_fetch_failing_repeatedly',
          title: `Asset fetch failing repeatedly: ${job.payload.assetId || 'unknown'}`,
          message: `${job.type} job #${job.id} failed after ${job.attempts}/${job.maxAttempts} attempts: ${error.message}`,
          entityType: 'asset',
          entityId: job.payload.assetId || null
        });
      }
      logger.jobError(`Failed ${job.type} job #${job.id}: ${error.message}`);
    } finally {
      this.activeJobs.delete(job.id);
      this.process();
    }
  }

  isJobCancelled(id) {
    const row = this.db.prepare('SELECT status FROM jobs WHERE id = ?').get(id);
    return row && row.status === 'cancelled';
  }

  markJobCompleted(id) {
    const now = Date.now();
    this.db.prepare(`
      UPDATE jobs
      SET status = 'completed', locked_at = NULL, locked_by = NULL, updated_at = @now, last_error = NULL
      WHERE id = @id AND status = 'running'
    `).run({ id, now });
    return this.getJob(id);
  }

  markJobFailed(job, message) {
    const now = Date.now();
    const status = job.attempts >= job.maxAttempts ? 'failed' : 'queued';
    const runAfter = status === 'queued' ? now + Math.min(job.attempts, 5) * 1000 : job.runAfter;

    this.db.prepare(`
      UPDATE jobs
      SET status = @status, run_after = @runAfter, locked_at = NULL, locked_by = NULL,
          updated_at = @now, last_error = @message
      WHERE id = @id AND status = 'running'
    `).run({ id: job.id, status, runAfter, now, message });

    return this.getJob(job.id);
  }

  retryJob(id) {
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE jobs
      SET status = 'queued', attempts = 0, run_after = @now, locked_at = NULL, locked_by = NULL,
          updated_at = @now, last_error = NULL
      WHERE id = @id AND status IN ('failed', 'cancelled')
    `).run({ id, now });

    if (result.changes > 0) {
      this.process();
    }

    return this.getJob(id);
  }

  retryFailedJobs() {
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE jobs
      SET status = 'queued', attempts = 0, run_after = @now, locked_at = NULL, locked_by = NULL,
          updated_at = @now, last_error = NULL
      WHERE status = 'failed'
    `).run({ now });

    if (result.changes > 0) {
      this.process();
    }

    return result.changes;
  }

  cancelJob(id) {
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE jobs
      SET status = 'cancelled', locked_at = NULL, locked_by = NULL, updated_at = @now
      WHERE id = @id AND status IN ('queued', 'delayed', 'running')
    `).run({ id, now });

    const activeJob = this.activeJobs.get(Number(id));
    if (activeJob) {
      activeJob.status = 'cancelled';
    }

    return result.changes > 0 ? this.getJob(id) : null;
  }

  clearCompletedJobs() {
    const result = this.db.prepare("DELETE FROM jobs WHERE status = 'completed'").run();
    return result.changes;
  }

  recordFailure(job) {
    this.recentFailures.unshift(cloneJob(job));
    this.recentFailures = this.recentFailures.slice(0, DEFAULT_FAILURE_LIMIT);
  }

  getJob(id) {
    return rowToJob(this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
  }

  listJobs(options = {}) {
    const limit = Number.isInteger(Number(options.limit)) ? Math.max(1, Number(options.limit)) : 50;
    const statuses = Array.isArray(options.statuses) && options.statuses.length > 0
      ? options.statuses.filter((status) => JOB_STATUSES.has(status))
      : [];
    const where = statuses.length > 0 ? `WHERE status IN (${statuses.map(() => '?').join(',')})` : '';
    const rows = this.db.prepare(`
      SELECT * FROM jobs
      ${where}
      ORDER BY
        CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'delayed' THEN 2 WHEN 'failed' THEN 3 ELSE 4 END,
        priority ASC,
        id ASC
      LIMIT ?
    `).all(...statuses, limit);

    return rows.map(rowToJob);
  }

  countRunnableJobs(now = Date.now()) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM jobs
      WHERE status IN ('queued', 'delayed') AND run_after <= @now
        ${this.maintenanceMode ? `AND type NOT IN (${Array.from(FETCH_JOB_TYPES).map((type) => `'${type}'`).join(',')})` : ''}
    `).get({ now });
    return row.count;
  }

  countJobs(statuses) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM jobs
      WHERE status IN (${statuses.map(() => '?').join(',')})
    `).get(...statuses);
    return row.count;
  }

  getStatus() {
    const limiterStatus = typeof this.limiter.getStatus === 'function'
      ? this.limiter.getStatus()
      : { callsUsedThisMinute: null };
    const queuedJobs = this.listJobs({ statuses: ['queued', 'delayed'], limit: 50 });
    const runningJobs = this.listJobs({ statuses: ['running'], limit: 50 });
    const failedJobs = this.listJobs({ statuses: ['failed'], limit: 50 });

    this.queue = queuedJobs.map(cloneJob);

    return {
      depth: this.countJobs(['queued', 'delayed']),
      activeJob: cloneJob(runningJobs[0] || this.activeJobs.values().next().value),
      activeJobs: runningJobs.map(cloneJob),
      queuedJobs: queuedJobs.map(cloneJob),
      runningJobs: runningJobs.map(cloneJob),
      failedJobs: failedJobs.map(cloneJob),
      recentFailures: failedJobs.slice(0, DEFAULT_FAILURE_LIMIT).map(cloneJob),
      callsUsedThisMinute: limiterStatus.callsUsedThisMinute,
      limiter: limiterStatus,
      nextBackupAt: this.nextBackupAt,
      maintenanceMode: this.maintenanceMode
    };
  }
}

function createScheduler(options = {}) {
  return new JobScheduler(options);
}

module.exports = {
  JOB_TYPES,
  JOB_STATUSES,
  PRIORITIES,
  JobScheduler,
  createScheduler
};
