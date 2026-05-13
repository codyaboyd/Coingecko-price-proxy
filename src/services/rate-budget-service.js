const DEFAULT_MAX_CALLS_PER_MINUTE = 20;
const ONE_MINUTE_MS = 60 * 1000;
const SAFE_MODE_RECOVERY_MS = 15 * ONE_MINUTE_MS;
const SAFE_MODE_FLOOR_FACTOR = 0.5;
const WARNING_CALL_THRESHOLD = 10;
const GLOBAL_RATE_BUDGET_KEY = Symbol.for('chrono-cache.rateBudgetService');

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }

  return parsed;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getJobAssetId(job) {
  return job && job.payload ? job.payload.assetId : null;
}

function isCoinGeckoJob(job) {
  return ['recent_refresh', 'historical_backfill', 'gap_repair', 'manual_admin_fetch'].includes(job.type);
}

function estimateAssetPolicyCost(asset) {
  const policy = asset.fetchPolicy || {};
  const intervals = ['1h'];

  if (policy.recentEveryMinutes && Number(policy.recentEveryMinutes) <= 15) {
    intervals.unshift('5m');
  }

  if (policy.dailyBackfill === true) {
    intervals.push('1d');
  }

  return Math.max(1, intervals.length);
}

class RateBudgetService {
  constructor(options = {}) {
    this.maxCallsPerMinute = parsePositiveInteger(options.maxCallsPerMinute || process.env.COINGECKO_MAX_CALLS_PER_MINUTE, DEFAULT_MAX_CALLS_PER_MINUTE);
    this.safeMode = parseBoolean(options.safeMode ?? process.env.COINGECKO_SAFE_MODE, false);
    this.windowMs = parsePositiveInteger(options.windowMs, ONE_MINUTE_MS);
    this.recoveryMs = parsePositiveInteger(options.recoveryMs, SAFE_MODE_RECOVERY_MS);
    this.calls = [];
    this.successfulCalls = 0;
    this.failedCalls = 0;
    this.rateLimitedCalls = 0;
    this.assetRefreshes = 0;
    this.assetRefreshCallTotal = 0;
    this.last429At = null;
  }

  removeExpiredCalls(now = Date.now()) {
    const cutoff = now - this.windowMs;

    while (this.calls.length > 0 && this.calls[0] <= cutoff) {
      this.calls.shift();
    }
  }

  getSafeModeFactor(now = Date.now()) {
    if (!this.safeMode || !this.last429At) {
      return 1;
    }

    const elapsed = Math.max(0, now - this.last429At);
    const recovered = clamp(elapsed / this.recoveryMs, 0, 1);
    return SAFE_MODE_FLOOR_FACTOR + ((1 - SAFE_MODE_FLOOR_FACTOR) * recovered);
  }

  getEffectiveMaxCallsPerMinute(now = Date.now()) {
    return Math.max(1, Math.floor(this.maxCallsPerMinute * this.getSafeModeFactor(now)));
  }

  recordCall() {
    const now = Date.now();
    this.removeExpiredCalls(now);
    this.calls.push(now);
  }

  recordResponse(status) {
    if (status >= 200 && status <= 299) {
      this.successfulCalls += 1;
      return;
    }

    this.failedCalls += 1;

    if (status === 429) {
      this.rateLimitedCalls += 1;
      this.last429At = Date.now();
    }
  }

  recordFailure(error = {}) {
    this.failedCalls += 1;

    if (error.status === 429 || error.code === 'coingecko_rate_limited') {
      this.rateLimitedCalls += 1;
      this.last429At = Date.now();
    }
  }

  recordAssetRefresh(callCount) {
    const normalized = parsePositiveInteger(callCount, 1);
    this.assetRefreshes += 1;
    this.assetRefreshCallTotal += normalized;
  }

  getAverageCallsPerAssetRefresh() {
    if (this.assetRefreshes === 0) {
      return 1;
    }

    return this.assetRefreshCallTotal / this.assetRefreshes;
  }

  getRetryBudget() {
    return this.safeMode && this.last429At ? 0 : null;
  }

  getStatus(now = Date.now()) {
    this.removeExpiredCalls(now);
    const effectiveMaxCallsPerMinute = this.getEffectiveMaxCallsPerMinute(now);
    const reserveCalls = Math.max(1, Math.ceil(effectiveMaxCallsPerMinute * 0.1));
    const currentCallsUsed = this.calls.length;

    return {
      configuredMaxCallsPerMinute: this.maxCallsPerMinute,
      effectiveMaxCallsPerMinute,
      safeMode: this.safeMode,
      safeModeFactor: this.getSafeModeFactor(now),
      recoveryUntil: this.safeMode && this.last429At ? this.last429At + this.recoveryMs : null,
      callsThisMinute: currentCallsUsed,
      currentCallsUsed,
      successfulCalls: this.successfulCalls,
      failedCalls: this.failedCalls,
      rateLimitedCalls: this.rateLimitedCalls,
      responses429: this.rateLimitedCalls,
      averageCallsPerAssetRefresh: this.getAverageCallsPerAssetRefresh(),
      safeRemainingCalls: Math.max(0, effectiveMaxCallsPerMinute - currentCallsUsed - reserveCalls),
      reserveCalls,
      last429At: this.last429At
    };
  }

  estimateJobCalls(job) {
    if (!isCoinGeckoJob(job)) {
      return 0;
    }

    return Math.max(1, Math.ceil(this.getAverageCallsPerAssetRefresh()));
  }

  estimateQueue(jobs = [], now = Date.now()) {
    const fetchJobs = jobs.filter(isCoinGeckoJob);
    const projectedCalls = fetchJobs.reduce((total, job) => total + this.estimateJobCalls(job), 0);
    const status = this.getStatus(now);
    const callsAvailablePerMinute = Math.max(1, status.safeRemainingCalls || status.effectiveMaxCallsPerMinute);
    const estimatedMinutes = projectedCalls === 0 ? 0 : Math.ceil(projectedCalls / callsAvailablePerMinute);
    const byAsset = new Map();

    fetchJobs.forEach((job) => {
      const assetId = getJobAssetId(job) || 'unknown';
      const existing = byAsset.get(assetId) || { assetId, queuedJobs: 0, projectedCalls: 0 };
      existing.queuedJobs += 1;
      existing.projectedCalls += this.estimateJobCalls(job);
      byAsset.set(assetId, existing);
    });

    return {
      fetchJobs: fetchJobs.length,
      projectedCalls,
      estimatedMinutes,
      estimatedDrainMs: estimatedMinutes * ONE_MINUTE_MS,
      byAsset: Array.from(byAsset.values()).sort((left, right) => right.projectedCalls - left.projectedCalls || left.assetId.localeCompare(right.assetId))
    };
  }

  buildSnapshot(options = {}) {
    const scheduler = options.scheduler || null;
    const assets = options.assets || [];
    const jobs = scheduler && typeof scheduler.listJobs === 'function'
      ? scheduler.listJobs({ statuses: ['queued', 'delayed', 'running'], limit: 10000 })
      : [];
    const status = this.getStatus();
    const queue = this.estimateQueue(jobs);
    const queuedByAsset = new Map(queue.byAsset.map((item) => [item.assetId, item]));
    const expensiveAssets = assets.map((asset) => {
      const queued = queuedByAsset.get(asset.id) || { queuedJobs: 0, projectedCalls: 0 };
      const policyProjectedCalls = estimateAssetPolicyCost(asset);

      return {
        id: asset.id,
        symbol: asset.symbol,
        name: asset.name,
        enabled: asset.enabled,
        maxBackfillDaysPerRun: asset.fetchPolicy && asset.fetchPolicy.maxBackfillDaysPerRun,
        dailyBackfill: asset.fetchPolicy && asset.fetchPolicy.dailyBackfill === true,
        queuedJobs: queued.queuedJobs,
        projectedCalls: queued.projectedCalls,
        policyProjectedCalls,
        expensiveScore: queued.projectedCalls + policyProjectedCalls + ((asset.fetchPolicy && Number(asset.fetchPolicy.maxBackfillDaysPerRun) > 90) ? 2 : 0)
      };
    }).filter((asset) => asset.queuedJobs > 0 || asset.dailyBackfill || Number(asset.maxBackfillDaysPerRun) > 90)
      .sort((left, right) => right.expensiveScore - left.expensiveScore || String(left.symbol).localeCompare(String(right.symbol)))
      .slice(0, 10);

    return {
      ...status,
      queueEstimatedCalls: queue.projectedCalls,
      estimatedTimeToDrainQueueMinutes: queue.estimatedMinutes,
      estimatedDrainMs: queue.estimatedDrainMs,
      averageCallsPerAssetRefresh: status.averageCallsPerAssetRefresh,
      expensiveAssets,
      pendingQueue: queue
    };
  }
}

function createRateBudgetService(options = {}) {
  return new RateBudgetService(options);
}

function getGlobalRateBudgetService(options = {}) {
  if (!globalThis[GLOBAL_RATE_BUDGET_KEY]) {
    globalThis[GLOBAL_RATE_BUDGET_KEY] = createRateBudgetService(options);
  }

  return globalThis[GLOBAL_RATE_BUDGET_KEY];
}

module.exports = {
  DEFAULT_MAX_CALLS_PER_MINUTE,
  WARNING_CALL_THRESHOLD,
  RateBudgetService,
  createRateBudgetService,
  getGlobalRateBudgetService
};
