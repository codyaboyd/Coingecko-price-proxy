const { runManualFetch } = require('../services/manual-fetch-service');

const FETCH_JOB_TYPES = new Set([
  'recent_refresh',
  'historical_backfill',
  'gap_repair',
  'manual_admin_fetch'
]);

function normalizeFetchJob(job) {
  if (!job || !FETCH_JOB_TYPES.has(job.type)) {
    throw new Error('Unsupported fetch history job type.');
  }

  const payload = job.payload || {};

  if (!payload.assetId) {
    throw new Error('Fetch history job payload must include assetId.');
  }

  return {
    assetId: payload.assetId,
    request: {
      from: payload.from,
      to: payload.to,
      interval: payload.interval,
      vsCurrency: payload.vsCurrency,
      conflictPolicy: payload.conflictPolicy
    }
  };
}

async function runFetchHistoryJob(job, context = {}) {
  const db = context.db;

  if (!db) {
    throw new Error('Fetch history job requires a database connection.');
  }

  const normalized = normalizeFetchJob(job);
  return runManualFetch(db, normalized.assetId, normalized.request, context.fetchOptions || {});
}

module.exports = {
  FETCH_JOB_TYPES,
  runFetchHistoryJob
};
