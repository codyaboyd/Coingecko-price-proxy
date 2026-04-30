import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import pLimit from 'p-limit';

const PORT = Number(process.env.PORT || 8080);
const DB_PATH = process.env.DB_PATH || './price-history.sqlite';

const COINGECKO_PLAN = process.env.COINGECKO_PLAN || 'demo';
const COINGECKO_DEMO_API_KEY = process.env.COINGECKO_DEMO_API_KEY || '';
const COINGECKO_PRO_API_KEY = process.env.COINGECKO_PRO_API_KEY || '';

const REQUEST_DELAY_MS = Number(process.env.COINGECKO_REQUEST_DELAY_MS || 2500);
const REQUEST_DELAY_ON_RATE_LIMIT_MS = Number(process.env.COINGECKO_REQUEST_DELAY_ON_RATE_LIMIT_MS || 15_000);
const REQUEST_MAX_RETRIES = Number(process.env.COINGECKO_REQUEST_MAX_RETRIES || 2);
const UPDATE_INTERVAL_MS = Number(process.env.UPDATE_INTERVAL_MS || 300000);
const BACKFILL_DAYS = Number(process.env.BACKFILL_DAYS || 365);
const BACKFILL_CHUNK_DAYS = Number(process.env.BACKFILL_CHUNK_DAYS || 90);
const DEFAULT_VS_CURRENCY = process.env.DEFAULT_VS_CURRENCY || 'usd';

const ASSETS_FILE = path.resolve('./assets.json');

const COINGECKO_BASES = {
  pro: 'https://pro-api.coingecko.com/api/v3',
  demo: 'https://api.coingecko.com/api/v3'
};

const preferredPlan = COINGECKO_PLAN === 'pro' ? 'pro' : 'demo';
let activePlan = preferredPlan;

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  symbol TEXT,
  name TEXT,
  vs_currency TEXT NOT NULL DEFAULT 'usd',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS price_points (
  asset_id TEXT NOT NULL,
  vs_currency TEXT NOT NULL,
  ts INTEGER NOT NULL,
  price REAL NOT NULL,
  market_cap REAL,
  total_volume REAL,
  source TEXT NOT NULL DEFAULT 'coingecko',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (asset_id, vs_currency, ts)
);

CREATE INDEX IF NOT EXISTS idx_price_points_asset_time
ON price_points(asset_id, vs_currency, ts);

CREATE TABLE IF NOT EXISTS sync_state (
  asset_id TEXT NOT NULL,
  vs_currency TEXT NOT NULL,
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  last_error TEXT,
  syncing INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (asset_id, vs_currency)
);
`);

const stmts = {
  upsertAsset: db.prepare(`
    INSERT INTO assets (id, symbol, name, vs_currency, enabled, created_at, updated_at)
    VALUES (@id, @symbol, @name, @vs_currency, @enabled, @now, @now)
    ON CONFLICT(id) DO UPDATE SET
      symbol = excluded.symbol,
      name = excluded.name,
      vs_currency = excluded.vs_currency,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `),

  listAssets: db.prepare(`
    SELECT id, symbol, name, vs_currency, enabled, created_at, updated_at
    FROM assets
    ORDER BY id ASC
  `),

  listEnabledAssets: db.prepare(`
    SELECT id, symbol, name, vs_currency
    FROM assets
    WHERE enabled = 1
    ORDER BY id ASC
  `),

  getLastPoint: db.prepare(`
    SELECT ts, price
    FROM price_points
    WHERE asset_id = ? AND vs_currency = ?
    ORDER BY ts DESC
    LIMIT 1
  `),

  upsertPoint: db.prepare(`
    INSERT INTO price_points (
      asset_id,
      vs_currency,
      ts,
      price,
      market_cap,
      total_volume,
      source,
      created_at,
      updated_at
    )
    VALUES (
      @asset_id,
      @vs_currency,
      @ts,
      @price,
      @market_cap,
      @total_volume,
      @source,
      @now,
      @now
    )
    ON CONFLICT(asset_id, vs_currency, ts) DO UPDATE SET
      price = excluded.price,
      market_cap = excluded.market_cap,
      total_volume = excluded.total_volume,
      source = excluded.source,
      updated_at = excluded.updated_at
  `),

  getHistory: db.prepare(`
    SELECT ts, price, market_cap, total_volume
    FROM price_points
    WHERE asset_id = @asset_id
      AND vs_currency = @vs_currency
      AND ts >= @from
      AND ts <= @to
    ORDER BY ts ASC
  `),

  getLatestMany: db.prepare(`
    SELECT pp.asset_id, pp.vs_currency, pp.ts, pp.price, pp.market_cap, pp.total_volume
    FROM price_points pp
    JOIN (
      SELECT asset_id, vs_currency, MAX(ts) AS max_ts
      FROM price_points
      WHERE vs_currency = ?
      GROUP BY asset_id, vs_currency
    ) latest
      ON pp.asset_id = latest.asset_id
     AND pp.vs_currency = latest.vs_currency
     AND pp.ts = latest.max_ts
    ORDER BY pp.asset_id ASC
  `),

  setSyncing: db.prepare(`
    INSERT INTO sync_state (asset_id, vs_currency, last_attempt_at, syncing)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(asset_id, vs_currency) DO UPDATE SET
      last_attempt_at = excluded.last_attempt_at,
      syncing = excluded.syncing
  `),

  setSyncSuccess: db.prepare(`
    INSERT INTO sync_state (asset_id, vs_currency, last_success_at, last_error, syncing)
    VALUES (?, ?, ?, NULL, 0)
    ON CONFLICT(asset_id, vs_currency) DO UPDATE SET
      last_success_at = excluded.last_success_at,
      last_error = NULL,
      syncing = 0
  `),

  setSyncError: db.prepare(`
    INSERT INTO sync_state (asset_id, vs_currency, last_attempt_at, last_error, syncing)
    VALUES (?, ?, ?, ?, 0)
    ON CONFLICT(asset_id, vs_currency) DO UPDATE SET
      last_attempt_at = excluded.last_attempt_at,
      last_error = excluded.last_error,
      syncing = 0
  `),

  getSyncState: db.prepare(`
    SELECT *
    FROM sync_state
    ORDER BY asset_id ASC
  `)
};

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toUnixSeconds(value, fallback) {
  if (!value) return fallback;

  if (/^\d+$/.test(String(value))) {
    const n = Number(value);
    return n > 10_000_000_000 ? Math.floor(n / 1000) : n;
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return fallback;
  return Math.floor(parsed / 1000);
}

function loadInitialAssets() {
  if (!fs.existsSync(ASSETS_FILE)) {
    console.warn(`[assets] ${ASSETS_FILE} not found; starting with DB assets only.`);
    return;
  }

  const raw = fs.readFileSync(ASSETS_FILE, 'utf8');
  const assets = JSON.parse(raw);
  const now = nowSec();

  const tx = db.transaction(items => {
    for (const asset of items) {
      if (!asset.id) continue;

      stmts.upsertAsset.run({
        id: asset.id,
        symbol: asset.symbol || null,
        name: asset.name || null,
        vs_currency: asset.vs_currency || DEFAULT_VS_CURRENCY,
        enabled: asset.enabled === false ? 0 : 1,
        now
      });
    }
  });

  tx(assets);
  console.log(`[assets] loaded ${assets.length} assets from assets.json`);
}

let nextRequestAt = Date.now();
const coingeckoLimit = pLimit(1);

function getBaseUrlForPlan(plan) {
  return COINGECKO_BASES[plan] || COINGECKO_BASES.demo;
}

function parseRetryAfterMs(retryAfterValue) {
  if (!retryAfterValue) return null;
  const numeric = Number(retryAfterValue);
  if (Number.isFinite(numeric)) return Math.max(0, numeric * 1000);
  const asDate = Date.parse(String(retryAfterValue));
  if (Number.isNaN(asDate)) return null;
  return Math.max(0, asDate - Date.now());
}

function buildCoinGeckoUrl(plan, endpointPath, query = {}) {
  const url = new URL(`${getBaseUrlForPlan(plan)}${endpointPath}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function throttledFetch(endpointPath, query = {}, options = {}) {
  return coingeckoLimit(async () => {
    const wait = Math.max(0, nextRequestAt - Date.now());
    if (wait > 0) await sleep(wait);
    nextRequestAt = Date.now() + REQUEST_DELAY_MS;

    let attemptedFallback = false;

    for (let attempt = 0; attempt <= REQUEST_MAX_RETRIES; attempt++) {
      const headers = {
        accept: 'application/json',
        ...(options.headers || {})
      };

      if (activePlan === 'pro' && COINGECKO_PRO_API_KEY) {
        headers['x-cg-pro-api-key'] = COINGECKO_PRO_API_KEY;
      } else if (COINGECKO_DEMO_API_KEY) {
        headers['x-cg-demo-api-key'] = COINGECKO_DEMO_API_KEY;
      }

      const url = buildCoinGeckoUrl(activePlan, endpointPath, query);
      const res = await fetch(url, {
        ...options,
        headers
      });

      const text = await res.text();

      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { raw: text };
      }

      if (res.ok) return json;

      const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after')) ?? REQUEST_DELAY_ON_RATE_LIMIT_MS;

      if ((res.status === 401 || res.status === 403) && activePlan === 'pro' && !attemptedFallback) {
        attemptedFallback = true;
        activePlan = 'demo';
        console.warn('[coingecko] pro auth rejected, falling back to demo endpoint');
        continue;
      }

      if ((res.status === 429 || res.status === 503) && attempt < REQUEST_MAX_RETRIES) {
        nextRequestAt = Math.max(nextRequestAt, Date.now() + retryAfterMs);
        console.warn(`[coingecko] rate-limited (${res.status}), retrying in ${retryAfterMs}ms`);
        await sleep(retryAfterMs);
        continue;
      }

      const err = new Error(`CoinGecko HTTP ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
      err.status = res.status;
      err.payload = json;
      err.plan = activePlan;
      throw err;
    }
  });
}

function buildMarketChartRangeUrl({ assetId, vsCurrency, from, to }) {
  return {
    endpointPath: `/coins/${encodeURIComponent(assetId)}/market_chart/range`,
    query: {
      vs_currency: vsCurrency,
      from,
      to,
      interval: 'hourly'
    }
  };
}

function buildSimplePriceUrl({ ids, vsCurrency }) {
  return {
    endpointPath: '/simple/price',
    query: {
      ids: ids.join(','),
      vs_currencies: vsCurrency,
      include_market_cap: 'true',
      include_24hr_vol: 'true',
      include_last_updated_at: 'true'
    }
  };
}

const upsertPointsTx = db.transaction(points => {
  for (const point of points) {
    stmts.upsertPoint.run(point);
  }
});

function normalizeMarketChartPayload(assetId, vsCurrency, payload) {
  const prices = Array.isArray(payload?.prices) ? payload.prices : [];
  const marketCaps = new Map(
    Array.isArray(payload?.market_caps)
      ? payload.market_caps.map(([ms, value]) => [Math.floor(ms / 1000), value])
      : []
  );
  const volumes = new Map(
    Array.isArray(payload?.total_volumes)
      ? payload.total_volumes.map(([ms, value]) => [Math.floor(ms / 1000), value])
      : []
  );

  const now = nowSec();

  return prices
    .map(([ms, price]) => {
      const ts = Math.floor(ms / 1000);
      return {
        asset_id: assetId,
        vs_currency: vsCurrency,
        ts,
        price,
        market_cap: marketCaps.get(ts) ?? null,
        total_volume: volumes.get(ts) ?? null,
        source: 'coingecko:market_chart_range',
        now
      };
    })
    .filter(p => Number.isFinite(p.ts) && Number.isFinite(p.price));
}

async function fetchAndStoreRange(assetId, vsCurrency, from, to) {
  if (to <= from) return 0;

  const req = buildMarketChartRangeUrl({
    assetId,
    vsCurrency,
    from,
    to
  });

  const payload = await throttledFetch(req.endpointPath, req.query);
  const points = normalizeMarketChartPayload(assetId, vsCurrency, payload);

  if (points.length > 0) {
    upsertPointsTx(points);
  }

  return points.length;
}

function chunkRangeByDays(from, to, days) {
  const chunkSec = days * 24 * 60 * 60;
  const chunks = [];

  let cursor = from;
  while (cursor < to) {
    const chunkTo = Math.min(cursor + chunkSec, to);
    chunks.push([cursor, chunkTo]);
    cursor = chunkTo + 1;
  }

  return chunks;
}

async function syncAsset(asset) {
  const assetId = asset.id;
  const vsCurrency = asset.vs_currency || DEFAULT_VS_CURRENCY;
  const now = nowSec();

  stmts.setSyncing.run(assetId, vsCurrency, now, 1);

  try {
    const last = stmts.getLastPoint.get(assetId, vsCurrency);

    let from;
    if (last?.ts) {
      // Re-fetch a small overlap to repair missing/late points.
      from = Math.max(0, last.ts - 6 * 60 * 60);
    } else {
      from = now - BACKFILL_DAYS * 24 * 60 * 60;
    }

    const to = now;

    const chunks = chunkRangeByDays(from, to, BACKFILL_CHUNK_DAYS);
    let inserted = 0;

    for (const [chunkFrom, chunkTo] of chunks) {
      inserted += await fetchAndStoreRange(assetId, vsCurrency, chunkFrom, chunkTo);
    }

    stmts.setSyncSuccess.run(assetId, vsCurrency, nowSec());

    console.log(`[sync] ${assetId}/${vsCurrency}: stored ${inserted} points`);
    return { assetId, vsCurrency, inserted };
  } catch (err) {
    console.error(`[sync:error] ${assetId}/${vsCurrency}`, err.message);
    stmts.setSyncError.run(assetId, vsCurrency, nowSec(), err.message);
    return { assetId, vsCurrency, error: err.message };
  }
}

let syncLoopRunning = false;

async function syncAllEnabledAssets() {
  if (syncLoopRunning) {
    console.log('[sync] skipped because previous sync is still running');
    return;
  }

  syncLoopRunning = true;

  try {
    const assets = stmts.listEnabledAssets.all();
    console.log(`[sync] starting sync for ${assets.length} assets`);

    for (const asset of assets) {
      await syncAsset(asset);
    }

    console.log('[sync] complete');
  } finally {
    syncLoopRunning = false;
  }
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    coingecko_plan: COINGECKO_PLAN,
    coingecko_active_plan: activePlan,
    db_path: DB_PATH
  });
});

app.get('/api/assets', (req, res) => {
  res.json({
    assets: stmts.listAssets.all().map(a => ({
      ...a,
      enabled: Boolean(a.enabled)
    }))
  });
});

app.post('/api/assets', (req, res) => {
  const body = req.body;

  if (!Array.isArray(body.assets)) {
    return res.status(400).json({
      error: 'Expected body like: { "assets": [{ "id": "bitcoin", "symbol": "BTC" }] }'
    });
  }

  const now = nowSec();

  const tx = db.transaction(assets => {
    for (const asset of assets) {
      if (!asset.id) continue;

      stmts.upsertAsset.run({
        id: asset.id,
        symbol: asset.symbol || null,
        name: asset.name || null,
        vs_currency: asset.vs_currency || DEFAULT_VS_CURRENCY,
        enabled: asset.enabled === false ? 0 : 1,
        now
      });
    }
  });

  tx(body.assets);

  res.json({
    ok: true,
    assets: stmts.listAssets.all().map(a => ({
      ...a,
      enabled: Boolean(a.enabled)
    }))
  });
});

app.post('/api/sync', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  const vsCurrency = req.body?.vs_currency || DEFAULT_VS_CURRENCY;

  const assets = ids
    ? ids.map(id => ({ id, vs_currency: vsCurrency }))
    : stmts.listEnabledAssets.all();

  const results = [];

  for (const asset of assets) {
    results.push(await syncAsset(asset));
  }

  res.json({
    ok: true,
    results
  });
});

app.get('/api/sync-state', (req, res) => {
  res.json({
    sync_state: stmts.getSyncState.all()
  });
});

app.get('/api/history', (req, res) => {
  const ids = String(req.query.ids || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    return res.status(400).json({
      error: 'Missing ids query param. Example: /api/history?ids=bitcoin,ethereum'
    });
  }

  const vsCurrency = String(req.query.vs_currency || DEFAULT_VS_CURRENCY);
  const to = toUnixSeconds(req.query.to, nowSec());
  const from = toUnixSeconds(
    req.query.from,
    to - 30 * 24 * 60 * 60
  );

  const result = {};

  for (const assetId of ids) {
    result[assetId] = stmts.getHistory.all({
      asset_id: assetId,
      vs_currency: vsCurrency,
      from,
      to
    });
  }

  res.json({
    vs_currency: vsCurrency,
    from,
    to,
    assets: result
  });
});

app.get('/api/latest', async (req, res) => {
  const ids = String(req.query.ids || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const vsCurrency = String(req.query.vs_currency || DEFAULT_VS_CURRENCY);

  const localLatest = stmts.getLatestMany.all(vsCurrency);
  const localMap = new Map(localLatest.map(row => [row.asset_id, row]));

  const requestedIds = ids.length > 0 ? ids : localLatest.map(row => row.asset_id);

  res.json({
    vs_currency: vsCurrency,
    assets: requestedIds.reduce((acc, id) => {
      acc[id] = localMap.get(id) || null;
      return acc;
    }, {})
  });
});

app.get('/api/live-price', async (req, res) => {
  const ids = String(req.query.ids || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    return res.status(400).json({
      error: 'Missing ids query param. Example: /api/live-price?ids=bitcoin,ethereum'
    });
  }

  const vsCurrency = String(req.query.vs_currency || DEFAULT_VS_CURRENCY);

  try {
    const req = buildSimplePriceUrl({ ids, vsCurrency });
    const payload = await throttledFetch(req.endpointPath, req.query);

    const now = nowSec();
    const points = [];

    for (const id of ids) {
      const item = payload[id];
      if (!item) continue;

      const price = item[vsCurrency];
      if (!Number.isFinite(price)) continue;

      const ts = Number.isFinite(item.last_updated_at)
        ? item.last_updated_at
        : now;

      points.push({
        asset_id: id,
        vs_currency: vsCurrency,
        ts,
        price,
        market_cap: item[`${vsCurrency}_market_cap`] ?? null,
        total_volume: item[`${vsCurrency}_24h_vol`] ?? null,
        source: 'coingecko:simple_price',
        now
      });
    }

    if (points.length > 0) {
      upsertPointsTx(points);
    }

    res.json({
      ok: true,
      vs_currency: vsCurrency,
      stored: points.length,
      data: payload
    });
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message
    });
  }
});

loadInitialAssets();

app.listen(PORT, () => {
  console.log(`CoinGecko history proxy listening on http://localhost:${PORT}`);
  console.log(`Preferred CoinGecko plan: ${preferredPlan}`);
  console.log(`Active CoinGecko base: ${getBaseUrlForPlan(activePlan)}`);

  syncAllEnabledAssets().catch(err => {
    console.error('[sync:first-run:error]', err);
  });

  setInterval(() => {
    syncAllEnabledAssets().catch(err => {
      console.error('[sync:interval:error]', err);
    });
  }, UPDATE_INTERVAL_MS);
});
