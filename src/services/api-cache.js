const HISTORY_CACHE_TTLS = {
  '1m': 15 * 1000,
  '5m': 60 * 1000,
  '1h': 5 * 60 * 1000,
  '1d': 60 * 60 * 1000
};

function encodeCachePart(value) {
  return encodeURIComponent(value === null || value === undefined ? '' : String(value));
}

function buildHistoryCacheKey(options) {
  const parts = [
    'history',
    options.assetId,
    options.from,
    options.to,
    options.interval,
    options.vs,
    options.fill,
    options.format,
    options.limit
  ];

  return parts.map(encodeCachePart).join(':');
}

function getHistoryCacheTtl(interval) {
  return HISTORY_CACHE_TTLS[interval] || 0;
}

function isCacheBypassed(value) {
  return String(value || '').trim().toLowerCase() === 'false';
}

function getCachedResponse(db, cacheKey, now = Date.now()) {
  const row = db
    .prepare(`
      SELECT cache_key, response_json, status_code, expires_at, created_at, updated_at
      FROM api_cache
      WHERE cache_key = @cacheKey
      LIMIT 1
    `)
    .get({ cacheKey });

  if (!row || row.expires_at <= now) {
    return null;
  }

  return {
    cacheKey: row.cache_key,
    responseJson: row.response_json,
    statusCode: row.status_code,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function setCachedResponse(db, cacheKey, responseJson, ttlMs, statusCode = 200, now = Date.now()) {
  db
    .prepare(`
      INSERT INTO api_cache (
        cache_key,
        response_json,
        status_code,
        expires_at,
        created_at,
        updated_at
      ) VALUES (
        @cacheKey,
        @responseJson,
        @statusCode,
        @expiresAt,
        @now,
        @now
      )
      ON CONFLICT(cache_key) DO UPDATE SET
        response_json = excluded.response_json,
        status_code = excluded.status_code,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `)
    .run({
      cacheKey,
      responseJson,
      statusCode,
      expiresAt: now + ttlMs,
      now
    });
}

function invalidateHistoryCacheForAsset(db, assetId) {
  const result = db
    .prepare('DELETE FROM api_cache WHERE cache_key LIKE @cachePrefix')
    .run({ cachePrefix: `${encodeCachePart('history')}:${encodeCachePart(assetId)}:%` });

  return result.changes;
}

function clearApiCache(db) {
  return db.prepare('DELETE FROM api_cache').run().changes;
}

function getApiCacheStats(db, now = Date.now()) {
  const row = db
    .prepare(`
      SELECT
        SUM(CASE WHEN expires_at > @now THEN 1 ELSE 0 END) AS active_entries,
        SUM(CASE WHEN expires_at <= @now THEN 1 ELSE 0 END) AS expired_entries
      FROM api_cache
    `)
    .get({ now });

  return {
    activeEntries: row.active_entries || 0,
    expiredEntries: row.expired_entries || 0
  };
}

module.exports = {
  buildHistoryCacheKey,
  clearApiCache,
  getApiCacheStats,
  getCachedResponse,
  getHistoryCacheTtl,
  invalidateHistoryCacheForAsset,
  isCacheBypassed,
  setCachedResponse
};
