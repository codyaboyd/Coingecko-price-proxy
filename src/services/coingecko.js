const logger = require('../utils/logger');
const { createProxyAwareFetch } = require('../utils/proxy-fetch');
const { getGlobalLimiter, sleep } = require('../utils/limiter');
const { getGlobalRateBudgetService } = require('./rate-budget-service');

const DEFAULT_API_BASE = 'https://api.coingecko.com/api/v3';
const DEFAULT_TIMEOUT_MS = 15 * 1000;
const DEFAULT_RETRIES = 3;
const DEFAULT_RATE_LIMIT_PAUSE_MS = 10 * 1000;
const DEFAULT_BACKOFF_MS = 750;
const MAX_BACKOFF_MS = 30 * 1000;

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }

  return parsed;
}

function parseNonNegativeInteger(value, fallback) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

function normalizeRequiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string.`);
  }

  return value.trim().toLowerCase();
}

function normalizeTimestampMs(value, field) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${field} must be a non-negative timestamp in milliseconds.`);
  }

  return Math.floor(parsed);
}

function normalizeBaseUrl(value) {
  const baseUrl = (value || DEFAULT_API_BASE).trim();
  return baseUrl.replace(/\/+$/, '');
}

function normalizeApiKeyType(value) {
  const normalized = (value || 'none').trim().toLowerCase();
  const allowed = new Set(['demo', 'pro', 'none']);

  if (!allowed.has(normalized)) {
    throw new Error('COINGECKO_API_KEY_TYPE must be one of: demo, pro, none.');
  }

  return normalized;
}

function buildAuthHeaders(apiKey, apiKeyType) {
  if (!apiKey || apiKeyType === 'none') {
    return {};
  }

  if (apiKeyType === 'pro') {
    return { 'x-cg-pro-api-key': apiKey };
  }

  return { 'x-cg-demo-api-key': apiKey };
}

function getRetryAfterMs(response) {
  const retryAfter = response.headers.get('retry-after');

  if (!retryAfter) {
    return null;
  }

  const seconds = Number(retryAfter);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(retryAfter);

  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return null;
}

function getBackoffMs(attempt, baseDelayMs, retryAfterMs) {
  const exponentialDelay = Math.min(MAX_BACKOFF_MS, baseDelayMs * (2 ** attempt));
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(exponentialDelay / 2)));
  const calculatedDelay = exponentialDelay + jitter;

  if (retryAfterMs === null || retryAfterMs === undefined) {
    return calculatedDelay;
  }

  return Math.max(calculatedDelay, retryAfterMs);
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function buildCoinGeckoError(message, details = {}) {
  const error = new Error(message);
  Object.entries(details).forEach(([key, value]) => {
    if (value !== undefined) {
      error[key] = value;
    }
  });
  return error;
}

async function readResponseText(response) {
  try {
    return await response.text();
  } catch (error) {
    return `Unable to read response body: ${error.message}`;
  }
}

function createCoinGeckoClient(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl || process.env.COINGECKO_API_BASE);
  const apiKey = options.apiKey || process.env.COINGECKO_API_KEY || '';
  const apiKeyType = normalizeApiKeyType(options.apiKeyType || process.env.COINGECKO_API_KEY_TYPE || (apiKey ? 'demo' : 'none'));
  const timeoutMs = parsePositiveInteger(options.timeoutMs || process.env.COINGECKO_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const retries = parseNonNegativeInteger(options.retries ?? process.env.COINGECKO_RETRIES, DEFAULT_RETRIES);
  const rateLimitPauseMs = parsePositiveInteger(
    options.rateLimitPauseMs || process.env.COINGECKO_RATE_LIMIT_PAUSE_MS,
    DEFAULT_RATE_LIMIT_PAUSE_MS
  );
  const baseBackoffMs = parsePositiveInteger(options.baseBackoffMs || process.env.COINGECKO_BACKOFF_MS, DEFAULT_BACKOFF_MS);
  const limiter = options.limiter || getGlobalLimiter();
  const fetchImpl = options.fetch || createProxyAwareFetch(fetch);
  const rateBudget = options.rateBudget || getGlobalRateBudgetService();
  const authHeaders = buildAuthHeaders(apiKey, apiKeyType);

  async function requestJson(pathname, searchParams, requestOptions = {}) {
    const url = new URL(`${baseUrl}${pathname}`);

    Object.entries(searchParams || {}).forEach(([key, value]) => {
      url.searchParams.set(key, String(value));
    });

    let lastError;
    let callsForRefresh = 0;
    const retryBudget = rateBudget && typeof rateBudget.getRetryBudget === 'function' ? rateBudget.getRetryBudget() : null;
    const maxRetries = retryBudget === null ? retries : Math.min(retries, retryBudget);

    try {
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
          callsForRefresh += 1;
          const response = await limiter.schedule(() => fetchImpl(url, {
            headers: {
              accept: 'application/json',
              'user-agent': 'chrono-cache/0.1 (+https://github.com/local/chrono-cache)',
              ...authHeaders
            },
            signal: controller.signal
          }));

        if (rateBudget && typeof rateBudget.recordResponse === 'function') {
          rateBudget.recordResponse(response.status);
        }

        if (response.ok) {
          try {
            return await response.json();
          } catch (error) {
            throw buildCoinGeckoError(`CoinGecko returned invalid JSON: ${error.message}`, { code: 'coingecko_invalid_json' });
          }
        }

        const responseBody = await readResponseText(response);
        const retryAfterMs = response.status === 429 ? getRetryAfterMs(response) : null;
        const error = buildCoinGeckoError(`CoinGecko request failed with HTTP ${response.status}: ${responseBody.slice(0, 300)}`, {
          status: response.status,
          code: response.status === 429 ? 'coingecko_rate_limited' : 'coingecko_request_failed',
          retryAfterMs
        });
        lastError = error;

        if (!isRetryableStatus(response.status) || attempt >= maxRetries) {
          throw error;
        }

        if (response.status === 429) {
          const pauseMs = Math.max(rateLimitPauseMs, retryAfterMs || 0);
          logger.warn(`CoinGecko rate limit hit; pausing queue for ${pauseMs}ms before retrying.`);
          limiter.pause(pauseMs);

          if (rateBudget && rateBudget.safeMode) {
            throw error;
          }
        }

        await sleep(getBackoffMs(attempt, baseBackoffMs, retryAfterMs));
      } catch (error) {
        if (error.name === 'AbortError') {
          error.message = `CoinGecko request timed out after ${timeoutMs}ms.`;
          error.code = 'coingecko_timeout';
        }

        lastError = error;

        if (!error.status && rateBudget && typeof rateBudget.recordFailure === 'function') {
          rateBudget.recordFailure(error);
        }

        if (error.status && (!isRetryableStatus(error.status) || attempt >= maxRetries)) {
          throw error;
        }

        if (attempt >= maxRetries) {
          throw error;
        }

        logger.warn(`CoinGecko request attempt ${attempt + 1} failed: ${error.message}`);
        await sleep(getBackoffMs(attempt, baseBackoffMs));
      } finally {
        clearTimeout(timeout);
      }
      }
    } finally {
      if (requestOptions.trackRefresh !== false && rateBudget && typeof rateBudget.recordAssetRefresh === 'function') {
        rateBudget.recordAssetRefresh(callsForRefresh);
      }
    }

    throw lastError;
  }

  async function fetchMarketChartRange(coingeckoId, vsCurrency, fromMs, toMs) {
    const id = normalizeRequiredString(coingeckoId, 'coingeckoId');
    const currency = normalizeRequiredString(vsCurrency, 'vsCurrency');
    const from = Math.floor(normalizeTimestampMs(fromMs, 'fromMs') / 1000);
    const to = Math.floor(normalizeTimestampMs(toMs, 'toMs') / 1000);

    if (to <= from) {
      throw new Error('toMs must be greater than fromMs.');
    }

    return requestJson(`/coins/${encodeURIComponent(id)}/market_chart/range`, {
      vs_currency: currency,
      from,
      to
    }, { assetId: id });
  }

  return {
    fetchMarketChartRange,
    requestJson
  };
}

const defaultClient = createCoinGeckoClient();

module.exports = {
  createCoinGeckoClient,
  fetchMarketChartRange: defaultClient.fetchMarketChartRange
};
