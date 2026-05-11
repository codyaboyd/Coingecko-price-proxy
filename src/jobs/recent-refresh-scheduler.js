const { getMissingWindows, floorToUtcBoundary, INTERVAL_STEPS_MS } = require('../services/cache-policy');
const logger = require('../utils/logger');

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DEFAULT_RECENT_EVERY_MINUTES = 60;
const DEFAULT_RECENT_WINDOW_DAYS = {
  '5m': 1,
  '1h': 2,
  '1d': 10
};
const DEFAULT_MAX_BACKFILL_DAYS_PER_RUN = 30;
const DAILY_BACKFILL_EVERY_MS = DAY_MS;

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function normalizePositiveNumber(value, defaultValue) {
  const parsed = Number(value);
  return isPositiveNumber(parsed) ? parsed : defaultValue;
}

function isFiveMinuteEnabled(fetchPolicy) {
  if (fetchPolicy.enable5m === true || fetchPolicy.fiveMinute === true) {
    return true;
  }

  if (Array.isArray(fetchPolicy.intervals)) {
    return fetchPolicy.intervals.map((interval) => String(interval).toLowerCase()).includes('5m');
  }

  return false;
}

function normalizeFetchPolicy(asset) {
  const fetchPolicy = asset && asset.fetchPolicy && typeof asset.fetchPolicy === 'object'
    ? asset.fetchPolicy
    : {};
  const recentEveryMinutes = normalizePositiveNumber(
    fetchPolicy.recentEveryMinutes,
    DEFAULT_RECENT_EVERY_MINUTES
  );
  const maxBackfillDaysPerRun = normalizePositiveNumber(
    fetchPolicy.maxBackfillDaysPerRun,
    DEFAULT_MAX_BACKFILL_DAYS_PER_RUN
  );
  const intervals = ['1h'];

  if (isFiveMinuteEnabled(fetchPolicy)) {
    intervals.unshift('5m');
  }

  if (fetchPolicy.dailyBackfill === true) {
    intervals.push('1d');
  }

  return {
    recentEveryMinutes,
    dailyBackfill: fetchPolicy.dailyBackfill === true,
    maxBackfillDaysPerRun,
    intervals
  };
}

function getIntervalEveryMs(interval, policy) {
  return interval === '1d' ? DAILY_BACKFILL_EVERY_MS : policy.recentEveryMinutes * MINUTE_MS;
}

function getIntervalWindow(interval, policy, now) {
  const stepMs = INTERVAL_STEPS_MS[interval];
  const defaultWindowDays = DEFAULT_RECENT_WINDOW_DAYS[interval];
  const windowDays = Math.min(defaultWindowDays, policy.maxBackfillDaysPerRun);
  const latestCompleteBucket = floorToUtcBoundary(interval, now - stepMs);
  const earliestBucket = floorToUtcBoundary(interval, latestCompleteBucket - (windowDays * DAY_MS));

  return {
    from: earliestBucket,
    to: latestCompleteBucket,
    fromIso: new Date(earliestBucket).toISOString(),
    toIso: new Date(latestCompleteBucket).toISOString()
  };
}

function getStaleWindow(db, asset, interval, from, to, staleCutoff) {
  const row = db
    .prepare(`
      SELECT MIN(ts) AS fromTs, MAX(ts) AS toTs
      FROM candles
      WHERE asset_id = @assetId
        AND vs_currency = @vsCurrency
        AND interval = @interval
        AND ts >= @from
        AND ts <= @to
        AND fetched_at < @staleCutoff
    `)
    .get({
      assetId: asset.id,
      vsCurrency: asset.vsCurrency,
      interval,
      from,
      to,
      staleCutoff
    });

  if (!row || row.fromTs === null || row.toTs === null) {
    return null;
  }

  return {
    from: row.fromTs,
    to: row.toTs,
    reason: 'stale'
  };
}

function mergeWindows(windows, interval) {
  const stepMs = INTERVAL_STEPS_MS[interval];
  const sorted = windows
    .filter((window) => window && Number.isSafeInteger(window.from) && Number.isSafeInteger(window.to))
    .sort((left, right) => left.from - right.from || left.to - right.to);
  const merged = [];

  sorted.forEach((window) => {
    const last = merged[merged.length - 1];

    if (!last || window.from > last.to + stepMs) {
      merged.push({ ...window, stale: window.reason === 'stale' });
      return;
    }

    last.to = Math.max(last.to, window.to);
    last.stale = last.stale || window.reason === 'stale';
  });

  return merged;
}

function buildRecentRefreshJobs(db, asset, interval, policy, now = Date.now()) {
  const window = getIntervalWindow(interval, policy, now);

  if (window.to < window.from) {
    return [];
  }

  const missingWindows = getMissingWindows(
    asset.id,
    asset.vsCurrency,
    interval,
    window.from,
    window.to,
    { db }
  ).map((gap) => ({ from: gap.from, to: gap.to, reason: 'missing' }));
  const staleCutoff = now - getIntervalEveryMs(interval, policy);
  const staleWindow = getStaleWindow(db, asset, interval, window.from, window.to, staleCutoff);
  const windows = mergeWindows([...missingWindows, staleWindow], interval);
  const stepMs = INTERVAL_STEPS_MS[interval];

  return windows.map((refreshWindow) => ({
    assetId: asset.id,
    assetSymbol: asset.symbol,
    assetPriority: asset.priority,
    from: new Date(refreshWindow.from).toISOString(),
    to: new Date(refreshWindow.to + stepMs).toISOString(),
    interval,
    vsCurrency: asset.vsCurrency,
    conflictPolicy: refreshWindow.stale ? 'overwrite_existing' : 'fill_only_missing',
    recentWindowFrom: window.from,
    recentWindowTo: window.to,
    missingOrStaleFrom: refreshWindow.from,
    missingOrStaleTo: refreshWindow.to,
    reason: refreshWindow.stale ? 'stale_or_missing' : 'missing'
  }));
}

function cloneAssetState(state) {
  return {
    assetId: state.asset.id,
    symbol: state.asset.symbol,
    priority: state.asset.priority,
    enabled: state.asset.enabled,
    policy: { ...state.policy, intervals: [...state.policy.intervals] },
    intervals: Object.fromEntries(Object.entries(state.intervals).map(([interval, intervalState]) => [
      interval,
      { ...intervalState }
    ])),
    lastRunAt: state.lastRunAt,
    lastRunJobCount: state.lastRunJobCount,
    lastError: state.lastError
  };
}

class RecentRefreshScheduler {
  constructor(options = {}) {
    this.db = options.db;
    this.jobScheduler = options.jobScheduler;
    this.assets = (options.assets || [])
      .filter((asset) => asset.enabled)
      .sort((left, right) => left.priority - right.priority || left.symbol.localeCompare(right.symbol));
    this.assetStates = new Map();
    this.paused = false;
    this.timer = null;
    this.startedAt = null;
    this.lastRunAt = null;
    this.nextRunAt = null;
    this.lastError = null;
    this.runCount = 0;
  }

  buildAssetState(asset, now) {
    const policy = normalizeFetchPolicy(asset);
    const intervals = {};

    policy.intervals.forEach((interval) => {
      intervals[interval] = {
        nextRunAt: now,
        lastRunAt: null,
        lastJobCount: 0
      };
    });

    return {
      asset,
      policy,
      intervals,
      lastRunAt: null,
      lastRunJobCount: 0,
      lastError: null
    };
  }

  reloadAssets(assets) {
    const now = Date.now();
    const enabledAssets = (assets || [])
      .filter((asset) => asset.enabled)
      .sort((left, right) => left.priority - right.priority || left.symbol.localeCompare(right.symbol));
    const enabledAssetIds = new Set(enabledAssets.map((asset) => asset.id));

    this.assets = enabledAssets;
    this.assetStates = new Map(enabledAssets.map((asset) => [asset.id, this.buildAssetState(asset, now)]));

    if (this.jobScheduler && typeof this.jobScheduler.removeQueuedJobs === 'function') {
      const removedJobs = this.jobScheduler.removeQueuedJobs((job) => (
        job.type === 'recent_refresh' && !enabledAssetIds.has(job.payload.assetId)
      ));

      if (removedJobs > 0) {
        logger.info(`Removed ${removedJobs} queued recent refresh job(s) for disabled or removed asset(s).`);
      }
    }

    if (this.startedAt !== null) {
      this.scheduleNext(0);
    }

    logger.info(`Recent refresh scheduler reloaded for ${this.assetStates.size} enabled asset(s).`);
    return this.getStatus();
  }

  start() {
    if (this.startedAt !== null) {
      return this.getStatus();
    }

    const now = Date.now();
    this.startedAt = now;
    this.assetStates = new Map(this.assets.map((asset) => [asset.id, this.buildAssetState(asset, now)]));
    this.scheduleNext(0);

    logger.info(`Recent refresh scheduler started for ${this.assetStates.size} enabled asset(s).`);
    return this.getStatus();
  }

  stopTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  scheduleNext(delayMs) {
    this.stopTimer();

    if (this.paused || this.startedAt === null) {
      this.nextRunAt = null;
      return;
    }

    const now = Date.now();
    const delay = Math.max(0, delayMs);
    this.nextRunAt = now + delay;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.runDue().catch((error) => {
        this.lastError = error.message;
        logger.error(`Recent refresh scheduler failed: ${error.message}`);
        this.scheduleFromStates();
      });
    }, delay);

    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  scheduleFromStates() {
    if (this.paused || this.startedAt === null) {
      this.nextRunAt = null;
      return;
    }

    const now = Date.now();
    const nextDue = this.getNextDueAt();

    if (nextDue === null) {
      this.stopTimer();
      this.nextRunAt = null;
      return;
    }

    this.scheduleNext(nextDue - now);
  }

  getNextDueAt() {
    let nextDue = null;

    this.assetStates.forEach((state) => {
      Object.values(state.intervals).forEach((intervalState) => {
        if (nextDue === null || intervalState.nextRunAt < nextDue) {
          nextDue = intervalState.nextRunAt;
        }
      });
    });

    return nextDue;
  }

  pause() {
    this.paused = true;
    this.stopTimer();
    this.nextRunAt = null;
    logger.info('Recent refresh scheduler paused.');
    return this.getStatus();
  }

  resume() {
    this.paused = false;
    this.scheduleFromStates();
    logger.info('Recent refresh scheduler resumed.');
    return this.getStatus();
  }

  getDueWork(now) {
    const work = [];

    this.assetStates.forEach((state) => {
      Object.entries(state.intervals).forEach(([interval, intervalState]) => {
        if (intervalState.nextRunAt <= now) {
          work.push({ state, interval, intervalState });
        }
      });
    });

    return work.sort((left, right) => left.state.asset.priority - right.state.asset.priority);
  }

  enqueueJobsForWork(work, now) {
    let jobCount = 0;

    work.forEach(({ state, interval, intervalState }) => {
      const jobs = buildRecentRefreshJobs(this.db, state.asset, interval, state.policy, now);
      const everyMs = getIntervalEveryMs(interval, state.policy);

      jobs.forEach((payload) => {
        if (typeof this.jobScheduler.hasPendingJob === 'function' && this.jobScheduler.hasPendingJob((job) => (
          job.type === 'recent_refresh' &&
          job.payload.assetId === payload.assetId &&
          job.payload.interval === payload.interval &&
          job.payload.from === payload.from &&
          job.payload.to === payload.to
        ))) {
          return;
        }

        this.jobScheduler.enqueue('recent_refresh', payload, { assetPriority: state.asset.priority });
        jobCount += 1;
      });

      intervalState.lastRunAt = now;
      intervalState.nextRunAt = now + everyMs;
      intervalState.lastJobCount = jobs.length;
      state.lastRunAt = now;
      state.lastRunJobCount += jobs.length;
      state.lastError = null;
    });

    return jobCount;
  }

  async runDue() {
    const now = Date.now();
    const work = this.getDueWork(now);

    if (work.length > 0) {
      const jobCount = this.enqueueJobsForWork(work, now);
      this.lastRunAt = now;
      this.runCount += 1;
      this.lastError = null;
      logger.info(`Recent refresh scheduler enqueued ${jobCount} job(s).`);
    }

    this.scheduleFromStates();
    return this.getStatus();
  }

  runNow() {
    const now = Date.now();
    const work = [];

    this.assetStates.forEach((state) => {
      Object.entries(state.intervals).forEach(([interval, intervalState]) => {
        work.push({ state, interval, intervalState });
      });
    });

    const jobCount = this.enqueueJobsForWork(work, now);
    this.lastRunAt = now;
    this.runCount += 1;
    this.lastError = null;
    this.scheduleFromStates();
    logger.info(`Recent refresh run-now enqueued ${jobCount} job(s).`);

    return {
      jobCount,
      status: this.getStatus()
    };
  }

  getStatus() {
    return {
      enabled: this.startedAt !== null,
      paused: this.paused,
      startedAt: this.startedAt,
      lastRunAt: this.lastRunAt,
      nextRunAt: this.nextRunAt,
      runCount: this.runCount,
      lastError: this.lastError,
      configuredAssets: this.assetStates.size,
      assets: Array.from(this.assetStates.values()).map(cloneAssetState)
    };
  }
}

function createRecentRefreshScheduler(options = {}) {
  return new RecentRefreshScheduler(options);
}

module.exports = {
  DEFAULT_RECENT_WINDOW_DAYS,
  RecentRefreshScheduler,
  buildRecentRefreshJobs,
  createRecentRefreshScheduler,
  normalizeFetchPolicy
};
