const DEFAULT_WINDOW_MS = 60 * 1000;
const DEFAULT_MAX_REQUESTS = 120;
const DEFAULT_MAX_BUCKETS = 5000;

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getClientKey(req) {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function createRateLimit(options = {}) {
  const windowMs = parsePositiveInteger(options.windowMs || process.env.API_RATE_LIMIT_WINDOW_MS, DEFAULT_WINDOW_MS);
  const maxRequests = parsePositiveInteger(options.maxRequests || process.env.API_RATE_LIMIT_MAX, DEFAULT_MAX_REQUESTS);
  const maxBuckets = parsePositiveInteger(options.maxBuckets, DEFAULT_MAX_BUCKETS);
  const buckets = new Map();

  return function rateLimit(req, res, next) {
    const now = Date.now();
    const resetBefore = now - windowMs;

    if (buckets.size > maxBuckets) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now || bucket.startedAt < resetBefore) {
          buckets.delete(key);
        }
      }
    }

    const key = getClientKey(req);
    let bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, startedAt: now, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, maxRequests - bucket.count);
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));

    res.set('RateLimit-Limit', String(maxRequests));
    res.set('RateLimit-Remaining', String(remaining));
    res.set('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > maxRequests) {
      res.set('Retry-After', String(retryAfterSeconds));
      res.status(429).json({
        error: {
          code: 'rate_limited',
          message: `Too many API requests. Try again in ${retryAfterSeconds} second(s).`,
          retryAfterSeconds
        }
      });
      return;
    }

    next();
  };
}

module.exports = { createRateLimit };
