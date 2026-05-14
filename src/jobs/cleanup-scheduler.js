const logger = require('../utils/logger');
const { createCleanupService } = require('../services/cleanup-service');

const DAY_MS = 24 * 60 * 60 * 1000;

class CleanupScheduler {
  constructor(options = {}) {
    this.service = options.service || createCleanupService(options);
    this.timer = null;
    this.nextRunAt = null;
    this.running = false;
  }

  getNextDailyCleanupAt(now = Date.now()) {
    const date = new Date(now);
    date.setUTCHours(3, 0, 0, 0);

    if (date.getTime() <= now) {
      date.setUTCDate(date.getUTCDate() + 1);
    }

    return date.getTime();
  }

  start(options = {}) {
    this.stop();
    const now = options.now || Date.now();
    const firstRunAt = options.firstRunAt || this.getNextDailyCleanupAt(now);
    const delay = Math.max(0, firstRunAt - now);
    this.nextRunAt = now + delay;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.runNow({ scheduled: true }).finally(() => this.start());
    }, delay);

    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }

    logger.jobInfo(`Daily cleanup job scheduled for ${new Date(this.nextRunAt).toISOString()}.`);
    return this.nextRunAt;
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    this.nextRunAt = null;
  }

  async runNow(options = {}) {
    if (this.running) {
      const error = new Error('Cleanup is already running.');
      error.status = 409;
      throw error;
    }

    this.running = true;
    try {
      return await Promise.resolve(this.service.run(options));
    } finally {
      this.running = false;
    }
  }

  getStatus() {
    return {
      running: this.running,
      nextRunAt: this.nextRunAt,
      nextRunAtIso: this.nextRunAt ? new Date(this.nextRunAt).toISOString() : null,
      lastRun: this.service.getLastRun(),
      intervalMs: DAY_MS
    };
  }
}

function createCleanupScheduler(options) {
  return new CleanupScheduler(options);
}

module.exports = { CleanupScheduler, createCleanupScheduler };
