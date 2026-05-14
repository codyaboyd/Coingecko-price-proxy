const { INTERVAL_STEPS_MS, floorToUtcBoundary } = require('./cache-policy');
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const STALENESS_RULES = {
  '5m': 30 * MINUTE_MS,
  '1h': 3 * HOUR_MS,
  '1d': 36 * HOUR_MS
};
const FAILURE_THRESHOLD = 3;
const FAILURE_COOLDOWN_MS = 15 * MINUTE_MS;
const DEFAULT_RECENT_EVERY_MINUTES = 60;
const DEFAULT_MAX_BACKFILL_DAYS_PER_RUN = 30;

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

function normalizeFetchPolicy(asset, automation = {}) {
  const fetchPolicy = asset && asset.fetchPolicy && typeof asset.fetchPolicy === 'object'
    ? asset.fetchPolicy
    : {};
  const recentEveryMinutes = normalizePositiveNumber(automation.recentEveryMinutes ?? fetchPolicy.recentEveryMinutes, DEFAULT_RECENT_EVERY_MINUTES);
  const maxBackfillDaysPerRun = normalizePositiveNumber(automation.maxBackfillDaysPerRun ?? fetchPolicy.maxBackfillDaysPerRun, DEFAULT_MAX_BACKFILL_DAYS_PER_RUN);
  const intervals = ['1h'];

  if (automation.enable5m === true || (automation.enable5m !== false && isFiveMinuteEnabled(fetchPolicy))) {
    intervals.unshift('5m');
  }

  if ((automation.dailyBackfill ?? fetchPolicy.dailyBackfill) === true) {
    intervals.push('1d');
  }

  return {
    recentEveryMinutes,
    dailyBackfill: (automation.dailyBackfill ?? fetchPolicy.dailyBackfill) === true,
    maxBackfillDaysPerRun,
    intervals
  };
}

function toIso(value) {
  return value === null || value === undefined ? null : new Date(value).toISOString();
}

function getIntervalRules() {
  return Object.fromEntries(Object.entries(STALENESS_RULES).map(([interval, staleAfterMs]) => [
    interval,
    {
      interval,
      staleAfterMs,
      staleAfterMinutes: staleAfterMs / MINUTE_MS
    }
  ]));
}

function normalizeAssets(assets) {
  return (assets || []).filter(Boolean);
}

function isPendingRefresh(job, assetId, interval) {
  return job &&
    job.type === 'recent_refresh' &&
    job.payload &&
    job.payload.assetId === assetId &&
    job.payload.interval === interval;
}

function hasPendingRefresh(jobScheduler, assetId, interval) {
  return Boolean(jobScheduler && typeof jobScheduler.hasPendingJob === 'function' && jobScheduler.hasPendingJob((job) => (
    isPendingRefresh(job, assetId, interval)
  )));
}

function getLatestCandleRow(db, asset, interval) {
  return db.prepare(`
    SELECT COUNT(*) AS candleCount,
           MAX(ts) AS latestTs,
           MAX(fetched_at) AS latestFetchedAt
    FROM candles
    WHERE asset_id = @assetId
      AND vs_currency = @vsCurrency
      AND interval = @interval
  `).get({
    assetId: asset.id,
    vsCurrency: asset.vsCurrency,
    interval
  });
}

function getRecentFetchRows(db, asset, interval, limit) {
  return db.prepare(`
    SELECT status, error, error_message, started_at, finished_at
    FROM fetch_runs
    WHERE asset_id = @assetId
      AND vs_currency = @vsCurrency
      AND interval = @interval
      AND finished_at IS NOT NULL
    ORDER BY finished_at DESC, id DESC
    LIMIT @limit
  `).all({
    assetId: asset.id,
    vsCurrency: asset.vsCurrency,
    interval,
    limit
  });
}

function getFailureState(db, asset, interval, now, options = {}) {
  const threshold = Number.isInteger(options.failureThreshold) && options.failureThreshold > 0
    ? options.failureThreshold
    : FAILURE_THRESHOLD;
  const cooldownMs = Number.isFinite(Number(options.failureCooldownMs)) && Number(options.failureCooldownMs) >= 0
    ? Number(options.failureCooldownMs)
    : FAILURE_COOLDOWN_MS;
  const rows = getRecentFetchRows(db, asset, interval, threshold);
  let consecutiveFailures = 0;

  for (const row of rows) {
    if (row.status !== 'failed') {
      break;
    }

    consecutiveFailures += 1;
  }

  const latestFailure = rows.find((row) => row.status === 'failed') || null;
  const latestFailureAt = latestFailure ? latestFailure.finished_at : null;
  const cooldownUntil = consecutiveFailures >= threshold && latestFailureAt !== null
    ? latestFailureAt + cooldownMs
    : null;
  const inCooldown = cooldownUntil !== null && cooldownUntil > now;

  return {
    consecutiveFailures,
    failureThreshold: threshold,
    failing: consecutiveFailures >= threshold,
    inCooldown,
    cooldownMs,
    cooldownUntil,
    cooldownUntilIso: toIso(cooldownUntil),
    lastError: latestFailure ? latestFailure.error || latestFailure.error_message || null : null,
    lastFailureAt: latestFailureAt,
    lastFailureAtIso: toIso(latestFailureAt)
  };
}

function getIntervalStaleness(db, asset, interval, options = {}) {
  const now = options.now || Date.now();
  const jobScheduler = options.jobScheduler || null;
  const staleAfterMs = STALENESS_RULES[interval];

  if (!staleAfterMs) {
    return null;
  }

  const row = getLatestCandleRow(db, asset, interval);
  const candleCount = Number(row && row.candleCount ? row.candleCount : 0);
  const latestTs = row ? row.latestTs : null;
  const latestFetchedAt = row ? row.latestFetchedAt : null;
  const staleAfterTs = now - staleAfterMs;
  const latestCompleteBucket = floorToUtcBoundary(interval, now - INTERVAL_STEPS_MS[interval]);
  const fetching = hasPendingRefresh(jobScheduler, asset.id, interval);
  const automation = options.config && options.config.automation ? options.config.automation : {};
  const failure = getFailureState(db, asset, interval, now, {
    ...options,
    failureThreshold: options.failureThreshold ?? automation.failureThreshold,
    failureCooldownMs: options.failureCooldownMs ?? (automation.failureCooldownMinutes === undefined ? undefined : Number(automation.failureCooldownMinutes) * MINUTE_MS)
  });
  let status = 'fresh';

  if (failure.inCooldown) {
    status = 'failed';
  } else if (fetching) {
    status = 'fetching';
  } else if (candleCount === 0) {
    status = 'empty';
  } else if (latestTs < staleAfterTs) {
    status = 'stale';
  }

  return {
    interval,
    status,
    fresh: status === 'fresh',
    stale: status === 'stale',
    empty: status === 'empty',
    fetching: status === 'fetching',
    failed: status === 'failed',
    repairable: ['stale', 'empty'].includes(status),
    candleCount,
    latestTs,
    latestTsIso: toIso(latestTs),
    latestFetchedAt,
    latestFetchedAtIso: toIso(latestFetchedAt),
    staleAfterMs,
    staleAfterMinutes: staleAfterMs / MINUTE_MS,
    staleAfterTs,
    staleAfterIso: toIso(staleAfterTs),
    latestCompleteBucket,
    latestCompleteBucketIso: toIso(latestCompleteBucket),
    lastError: failure.lastError,
    failure
  };
}

function getAssetStaleness(db, asset, options = {}) {
  const checkedAt = options.now || Date.now();
  const policy = normalizeFetchPolicy(asset, options.config && options.config.automation ? options.config.automation : {});
  const intervals = policy.intervals
    .map((interval) => getIntervalStaleness(db, asset, interval, options))
    .filter(Boolean);
  const rank = { failed: 5, fetching: 4, empty: 3, stale: 2, fresh: 1 };
  const overall = intervals.reduce((current, intervalStatus) => (
    rank[intervalStatus.status] > rank[current] ? intervalStatus.status : current
  ), 'fresh');

  return {
    assetId: asset.id,
    symbol: asset.symbol,
    name: asset.name,
    vsCurrency: asset.vsCurrency,
    enabled: Boolean(asset.enabled),
    overallStatus: overall,
    intervals,
    policy,
    rules: getIntervalRules(),
    checkedAt,
    checkedAtIso: toIso(checkedAt)
  };
}

function listAssetStaleness(db, assets, options = {}) {
  return normalizeAssets(assets).map((asset) => getAssetStaleness(db, asset, options));
}

function getRepairableIntervals(db, asset, options = {}) {
  return getAssetStaleness(db, asset, options).intervals.filter((intervalStatus) => intervalStatus.repairable);
}

module.exports = {
  FAILURE_COOLDOWN_MS,
  FAILURE_THRESHOLD,
  STALENESS_RULES,
  getAssetStaleness,
  getIntervalRules,
  getIntervalStaleness,
  getRepairableIntervals,
  hasPendingRefresh,
  listAssetStaleness
};
