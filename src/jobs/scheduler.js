const logger = require('../utils/logger');
const { getGlobalLimiter } = require('../utils/limiter');
const { FETCH_JOB_TYPES, runFetchHistoryJob } = require('./fetch-history-job');
const { createBackupService } = require('../services/backup-service');

const JOB_TYPES = new Set([
  'recent_refresh',
  'historical_backfill',
  'gap_repair',
  'manual_admin_fetch',
  'sqlite_backup'
]);

const PRIORITIES = {
  manual_admin_fetch: 1,
  gap_repair: 2,
  recent_refresh: 3,
  historical_backfill: 4,
  sqlite_backup: 5
};

const DEFAULT_FAILURE_LIMIT = 10;

let nextJobId = 1;

function cloneJob(job) {
  if (!job) {
    return null;
  }

  return {
    id: job.id,
    type: job.type,
    priority: job.priority,
    status: job.status,
    payload: { ...job.payload },
    assetPriority: job.assetPriority,
    enqueuedAt: job.enqueuedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error || null
  };
}

function normalizeConcurrency(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

class JobScheduler {
  constructor(options = {}) {
    this.db = options.db;
    this.concurrency = normalizeConcurrency(options.concurrency || process.env.JOB_QUEUE_CONCURRENCY);
    this.queue = [];
    this.activeJobs = new Map();
    this.recentFailures = [];
    this.handlers = new Map();
    this.sequence = 0;
    this.running = false;
    this.limiter = options.limiter || getGlobalLimiter();
    this.config = options.config || null;
    this.backupService = options.backupService || (this.config ? createBackupService({ db: this.db, config: this.config }) : null);
    this.backupTimer = null;
    this.nextBackupAt = null;

    FETCH_JOB_TYPES.forEach((type) => {
      this.handlers.set(type, (job) => runFetchHistoryJob(job, { db: this.db }));
    });

    this.handlers.set('sqlite_backup', () => this.runBackupJob());
  }


  async runBackupJob() {
    if (!this.backupService) {
      throw new Error('Backup service is not configured.');
    }

    const backup = await this.backupService.createBackup();
    const pruneResult = this.backupService.pruneBackups();

    return {
      backup,
      pruneResult
    };
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

    logger.info(`Daily SQLite backup job scheduled for ${new Date(this.nextBackupAt).toISOString()}.`);
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

  register(type, handler) {
    if (!JOB_TYPES.has(type)) {
      throw new Error(`Unsupported job type: ${type}`);
    }

    if (typeof handler !== 'function') {
      throw new Error('Job handler must be a function.');
    }

    this.handlers.set(type, handler);
  }

  enqueue(type, payload = {}, options = {}) {
    if (!JOB_TYPES.has(type)) {
      throw new Error(`Unsupported job type: ${type}`);
    }

    const job = {
      id: nextJobId,
      type,
      priority: PRIORITIES[type],
      payload: { ...payload },
      assetPriority: Number.isFinite(Number(options.assetPriority)) ? Number(options.assetPriority) : Number.MAX_SAFE_INTEGER,
      status: 'queued',
      enqueuedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: null,
      sequence: this.sequence
    };

    nextJobId += 1;
    this.sequence += 1;
    this.queue.push(job);
    this.sortQueue();

    logger.info(`Queued ${type} job #${job.id} for asset ${payload.assetId || 'n/a'}.`);

    if (options.autoStart !== false) {
      this.process();
    }

    return cloneJob(job);
  }

  sortQueue() {
    this.queue.sort((left, right) => {
      if (left.priority !== right.priority) {
        return left.priority - right.priority;
      }

      if (left.assetPriority !== right.assetPriority) {
        return left.assetPriority - right.assetPriority;
      }

      return left.sequence - right.sequence;
    });
  }

  hasPendingJob(predicate) {
    return this.queue.some(predicate) || Array.from(this.activeJobs.values()).some(predicate);
  }

  removeQueuedJobs(predicate) {
    const before = this.queue.length;
    this.queue = this.queue.filter((job) => !predicate(job));
    return before - this.queue.length;
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
      while (this.queue.length > 0 && this.activeJobs.size < this.concurrency) {
        const job = this.queue.shift();
        this.runJob(job);
      }
    } finally {
      this.running = false;

      if (this.queue.length > 0 && this.activeJobs.size < this.concurrency) {
        this.process();
      }
    }
  }

  async runJob(job) {
    const handler = this.handlers.get(job.type);

    if (!handler) {
      job.status = 'failed';
      job.error = `No handler registered for ${job.type}.`;
      job.finishedAt = Date.now();
      this.recordFailure(job);
      return;
    }

    job.status = 'running';
    job.startedAt = Date.now();
    this.activeJobs.set(job.id, job);
    logger.info(`Starting ${job.type} job #${job.id}.`);

    try {
      const result = await handler(job, this);
      job.status = 'success';
      job.result = result;
      logger.info(`Finished ${job.type} job #${job.id}.`);
    } catch (error) {
      job.status = 'failed';
      job.error = error.message;
      job.finishedAt = Date.now();
      this.recordFailure(job);
      logger.error(`Failed ${job.type} job #${job.id}: ${error.message}`);
    } finally {
      if (!job.finishedAt) {
        job.finishedAt = Date.now();
      }
      this.activeJobs.delete(job.id);
      this.process();
    }
  }

  recordFailure(job) {
    this.recentFailures.unshift(cloneJob(job));
    this.recentFailures = this.recentFailures.slice(0, DEFAULT_FAILURE_LIMIT);
  }

  getStatus() {
    const limiterStatus = typeof this.limiter.getStatus === 'function'
      ? this.limiter.getStatus()
      : { callsUsedThisMinute: null };

    return {
      depth: this.queue.length,
      activeJob: cloneJob(this.activeJobs.values().next().value),
      activeJobs: Array.from(this.activeJobs.values()).map(cloneJob),
      recentFailures: this.recentFailures.map(cloneJob),
      callsUsedThisMinute: limiterStatus.callsUsedThisMinute,
      limiter: limiterStatus,
      nextBackupAt: this.nextBackupAt
    };
  }
}

function createScheduler(options = {}) {
  return new JobScheduler(options);
}

module.exports = {
  JOB_TYPES,
  PRIORITIES,
  JobScheduler,
  createScheduler
};
