const logger = require('./logger');
const { getGlobalRateBudgetService } = require('../services/rate-budget-service');

const DEFAULT_MAX_CALLS_PER_MINUTE = 20;
const ONE_MINUTE_MS = 60 * 1000;
const GLOBAL_LIMITER_KEY = Symbol.for('chrono-cache.coingeckoLimiter');

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }

  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RateLimiter {
  constructor(options = {}) {
    this.maxCallsPerMinute = parsePositiveInteger(options.maxCallsPerMinute, DEFAULT_MAX_CALLS_PER_MINUTE);
    this.windowMs = parsePositiveInteger(options.windowMs, ONE_MINUTE_MS);
    this.calls = [];
    this.queue = [];
    this.timer = null;
    this.processing = false;
    this.pausedUntil = 0;
    this.rateBudget = options.rateBudget || getGlobalRateBudgetService({ maxCallsPerMinute: this.maxCallsPerMinute });
  }

  configure(options = {}) {
    if (options.maxCallsPerMinute !== undefined) {
      this.maxCallsPerMinute = parsePositiveInteger(options.maxCallsPerMinute, this.maxCallsPerMinute);
    }

    if (this.rateBudget && typeof this.rateBudget.configure === 'function') {
      this.rateBudget.configure(options);
    }

    this.processQueue();
    return this.getStatus();
  }

  getStatus(now = Date.now()) {
    this.removeExpiredCalls(now);

    return {
      callsUsedThisMinute: this.calls.length,
      maxCallsPerMinute: this.maxCallsPerMinute,
      effectiveMaxCallsPerMinute: this.getEffectiveMaxCallsPerMinute(now),
      queuedTasks: this.queue.length,
      pausedUntil: this.pausedUntil > now ? this.pausedUntil : null
    };
  }

  schedule(task) {
    if (typeof task !== 'function') {
      return Promise.reject(new Error('Limiter task must be a function.'));
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.processQueue();
    });
  }

  pause(ms) {
    const pauseMs = parsePositiveInteger(ms, 0);

    if (pauseMs < 1) {
      return;
    }

    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + pauseMs);
    this.scheduleNext(pauseMs);
  }

  processQueue() {
    if (this.processing) {
      return;
    }

    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const waitMs = this.getWaitMs();

        if (waitMs > 0) {
          this.scheduleNext(waitMs);
          return;
        }

        const item = this.queue.shift();
        this.recordCall();
        this.runTask(item);
      }
    } finally {
      this.processing = false;
    }
  }

  runTask(item) {
    Promise.resolve()
      .then(item.task)
      .then(item.resolve, item.reject)
      .finally(() => this.processQueue());
  }

  getWaitMs() {
    const now = Date.now();

    if (this.pausedUntil > now) {
      return this.pausedUntil - now;
    }

    this.removeExpiredCalls(now);

    if (this.calls.length < this.getEffectiveMaxCallsPerMinute(now)) {
      return 0;
    }

    return Math.max(1, this.windowMs - (now - this.calls[0]));
  }

  recordCall() {
    const now = Date.now();
    this.removeExpiredCalls(now);
    this.calls.push(now);

    if (this.rateBudget && typeof this.rateBudget.recordCall === 'function') {
      this.rateBudget.recordCall();
    }
  }

  getEffectiveMaxCallsPerMinute(now = Date.now()) {
    if (this.rateBudget && typeof this.rateBudget.getEffectiveMaxCallsPerMinute === 'function') {
      return this.rateBudget.getEffectiveMaxCallsPerMinute(now);
    }

    return this.maxCallsPerMinute;
  }

  removeExpiredCalls(now) {
    const cutoff = now - this.windowMs;

    while (this.calls.length > 0 && this.calls[0] <= cutoff) {
      this.calls.shift();
    }
  }

  scheduleNext(waitMs) {
    if (this.timer) {
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      this.processQueue();
    }, Math.max(1, waitMs));
  }
}

function createLimiter(options = {}) {
  return new RateLimiter(options);
}

function getGlobalLimiter(options = {}) {
  if (!globalThis[GLOBAL_LIMITER_KEY]) {
    const maxCallsPerMinute = parsePositiveInteger(
      options.maxCallsPerMinute || process.env.COINGECKO_MAX_CALLS_PER_MINUTE,
      DEFAULT_MAX_CALLS_PER_MINUTE
    );

    globalThis[GLOBAL_LIMITER_KEY] = createLimiter({ maxCallsPerMinute });
    logger.debug(`Created shared CoinGecko limiter with ${maxCallsPerMinute} calls per minute.`);
  }

  return globalThis[GLOBAL_LIMITER_KEY];
}

module.exports = {
  DEFAULT_MAX_CALLS_PER_MINUTE,
  RateLimiter,
  createLimiter,
  getGlobalLimiter,
  sleep
};
