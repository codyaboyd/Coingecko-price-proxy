const DEFAULT_ASSET = {
  id: 'btc',
  symbol: 'BTC',
  name: 'Bitcoin',
  coingeckoId: 'bitcoin',
  vsCurrency: 'usd',
  enabled: true,
  priority: 10
};

function normalizeAssets(assets) {
  if (!Array.isArray(assets) || assets.length === 0) {
    return [DEFAULT_ASSET];
  }

  return assets.map((asset) => ({
    id: asset.id,
    symbol: asset.symbol,
    name: asset.name,
    coingeckoId: asset.coingeckoId,
    vsCurrency: asset.vsCurrency || 'usd',
    enabled: asset.enabled !== false,
    priority: asset.priority,
    earliestTs: asset.earliestTs,
    latestTs: asset.latestTs
  }));
}

function buildAssetExample(asset) {
  const example = {
    id: asset.id,
    symbol: asset.symbol,
    name: asset.name,
    coingeckoId: asset.coingeckoId,
    vsCurrency: asset.vsCurrency,
    enabled: asset.enabled,
    priority: asset.priority
  };

  if (asset.earliestTs !== undefined) {
    example.earliestTs = asset.earliestTs;
  }

  if (asset.latestTs !== undefined) {
    example.latestTs = asset.latestTs;
  }

  return example;
}

function buildCandleExample(asset, timestamp = Date.UTC(2026, 0, 1)) {
  return {
    assetId: asset.id,
    vsCurrency: asset.vsCurrency,
    interval: '1d',
    ts: timestamp,
    open: 42500,
    high: 43000,
    low: 42000,
    close: 42800,
    volume: 123.45,
    marketCap: 850000000000,
    fetchedAt: timestamp + 60000
  };
}

function jsonResponse(description, example) {
  return {
    description,
    content: {
      'application/json': {
        example
      }
    }
  };
}

function errorResponse(status, code, message) {
  return jsonResponse(message, {
    error: {
      code,
      message
    }
  });
}

function buildOpenApiDocument(options = {}) {
  const assets = normalizeAssets(options.assets);
  const asset = assets[0];
  const assetExample = buildAssetExample(asset);
  const historyExample = {
    asset: assetExample,
    vsCurrency: asset.vsCurrency,
    interval: '1d',
    from: Date.UTC(2026, 0, 1),
    to: Date.UTC(2026, 0, 2),
    source: 'local',
    count: 2,
    candles: [
      buildCandleExample(asset, Date.UTC(2026, 0, 1)),
      buildCandleExample(asset, Date.UTC(2026, 0, 2))
    ]
  };

  return {
    openapi: '3.0.3',
    info: {
      title: 'Chrono Cache Local API',
      version: 'v1',
      description: 'Self-documenting local API for cached cryptocurrency asset and history data.'
    },
    servers: [
      {
        url: '/api/v1',
        description: 'Local API root'
      }
    ],
    tags: [
      { name: 'public', description: 'Unauthenticated local cache endpoints.' },
      { name: 'admin', description: 'Session-protected admin API endpoints.' }
    ],
    paths: {
      '/health': {
        get: {
          tags: ['public'],
          summary: 'Health check',
          responses: {
            200: jsonResponse('Service health payload.', {
              status: 'ok',
              service: 'chrono-cache',
              apiVersion: 'v1',
              timestamp: '2026-01-01T00:00:00.000Z'
            })
          }
        }
      },
      '/assets': {
        get: {
          tags: ['public'],
          summary: 'List enabled assets',
          responses: {
            200: jsonResponse('Enabled asset list ordered by priority and symbol.', {
              assets: assets.map(buildAssetExample)
            })
          }
        }
      },
      '/assets/{assetId}': {
        get: {
          tags: ['public'],
          summary: 'Get one enabled asset',
          parameters: [
            {
              name: 'assetId',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              example: asset.id
            }
          ],
          responses: {
            200: jsonResponse('Enabled asset detail.', { asset: assetExample }),
            404: errorResponse(404, 'asset_not_found', `Asset '${asset.id}' was not found.`)
          }
        }
      },
      '/history/{assetId}': {
        get: {
          tags: ['public'],
          summary: 'Read cached OHLCV history for one asset',
          parameters: [
            { name: 'assetId', in: 'path', required: true, schema: { type: 'string' }, example: asset.id },
            { name: 'interval', in: 'query', required: false, schema: { type: 'string', enum: ['5m', '1h', '1d'], default: '1d' } },
            { name: 'from', in: 'query', required: false, schema: { type: 'string' }, description: 'ISO date, ISO timestamp, or millisecond timestamp.' },
            { name: 'to', in: 'query', required: false, schema: { type: 'string' }, description: 'ISO date, ISO timestamp, or millisecond timestamp.' },
            { name: 'vs', in: 'query', required: false, schema: { type: 'string', default: asset.vsCurrency } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 5000, default: 1000 } },
            { name: 'format', in: 'query', required: false, schema: { type: 'string', enum: ['json', 'csv'], default: 'json' } },
            { name: 'fill', in: 'query', required: false, schema: { type: 'string', enum: ['none', 'previous'], default: 'none' } },
            { name: 'cache', in: 'query', required: false, schema: { type: 'string' }, description: 'Use cache=bypass to skip the local response cache.' }
          ],
          responses: {
            200: jsonResponse('History response with matching candles.', historyExample),
            400: errorResponse(400, 'invalid_interval', 'interval must be one of: 5m, 1h, 1d.'),
            404: errorResponse(404, 'asset_not_found', `Asset '${asset.id}' was not found.`)
          }
        }
      },
      '/openapi.json': {
        get: {
          tags: ['public'],
          summary: 'Generated OpenAPI-style JSON for the local API',
          responses: {
            200: jsonResponse('OpenAPI-style document.', { openapi: '3.0.3', info: { title: 'Chrono Cache Local API', version: 'v1' } })
          }
        }
      },
      '/admin/system-health': {
        get: {
          tags: ['admin'],
          summary: 'Session-protected system health snapshot',
          responses: {
            200: jsonResponse('System health snapshot.', { status: 'ok', checks: [] }),
            401: errorResponse(401, 'unauthorized', 'Admin session is required.')
          }
        }
      },
      '/admin/rate-budget': {
        get: {
          tags: ['admin'],
          summary: 'Session-protected CoinGecko rate budget snapshot',
          responses: {
            200: jsonResponse('Rate budget snapshot.', { budget: { callsUsedThisMinute: 0 } }),
            401: errorResponse(401, 'unauthorized', 'Admin session is required.')
          }
        }
      },
      '/admin/assets/{assetId}/staleness': {
        get: {
          tags: ['admin'],
          summary: 'Session-protected asset staleness by interval',
          responses: {
            200: jsonResponse('Asset staleness snapshot.', { asset: { id: asset.id, symbol: asset.symbol, vsCurrency: asset.vsCurrency }, staleness: { intervals: [] } }),
            401: errorResponse(401, 'unauthorized', 'Admin session is required.')
          }
        }
      },
      '/admin/assets/{assetId}/gaps': {
        get: {
          tags: ['admin'],
          summary: 'Session-protected gap report for an asset interval and range',
          responses: {
            200: jsonResponse('Gap report.', { expectedCount: 0, foundCount: 0, missingCount: 0, gaps: [] }),
            401: errorResponse(401, 'unauthorized', 'Admin session is required.')
          }
        }
      },
      '/admin/assets/{assetId}/fetch': {
        post: {
          tags: ['admin'],
          summary: 'Session-protected manual fetch job enqueue',
          responses: {
            202: jsonResponse('Enqueued manual fetch job.', { job: { id: 1, type: 'manual_admin_fetch' } }),
            401: errorResponse(401, 'unauthorized', 'Admin session is required.')
          }
        }
      },
      '/admin/assets/{assetId}/backfill/plan': {
        post: {
          tags: ['admin'],
          summary: 'Session-protected backfill dry-run plan',
          responses: {
            200: jsonResponse('Backfill plan.', { chunks: [], projectedCalls: 0, warning: false }),
            401: errorResponse(401, 'unauthorized', 'Admin session is required.')
          }
        }
      },
      '/admin/assets/{assetId}/backfill': {
        post: {
          tags: ['admin'],
          summary: 'Session-protected backfill job enqueue',
          responses: {
            202: jsonResponse('Enqueued backfill jobs.', { enqueuedJobs: [], projectedCalls: 0 }),
            401: errorResponse(401, 'unauthorized', 'Admin session is required.')
          }
        }
      }
    }
  };
}

function buildDocsModel(options = {}) {
  const assets = normalizeAssets(options.assets);
  const asset = assets[0];
  const docs = buildOpenApiDocument({ assets });

  return {
    title: 'Local API Docs',
    assets,
    selectedAsset: asset,
    publicEndpoints: [
      {
        method: 'GET',
        path: '/api/v1/health',
        description: 'Returns a lightweight liveness payload for local monitoring.',
        curl: 'curl http://127.0.0.1:3000/api/v1/health',
        response: docs.paths['/health'].get.responses[200].content['application/json'].example
      },
      {
        method: 'GET',
        path: '/api/v1/assets',
        description: 'Lists enabled assets currently known to the local cache.',
        curl: 'curl http://127.0.0.1:3000/api/v1/assets',
        response: docs.paths['/assets'].get.responses[200].content['application/json'].example
      },
      {
        method: 'GET',
        path: '/api/v1/assets/:assetId',
        description: 'Returns metadata and available range hints for one enabled asset.',
        curl: `curl http://127.0.0.1:3000/api/v1/assets/${encodeURIComponent(asset.id)}`,
        response: docs.paths['/assets/{assetId}'].get.responses[200].content['application/json'].example
      },
      {
        method: 'GET',
        path: '/api/v1/history/:assetId',
        description: 'Returns cached local OHLCV candles. The endpoint never calls CoinGecko directly.',
        curl: `curl 'http://127.0.0.1:3000/api/v1/history/${encodeURIComponent(asset.id)}?interval=1d&vs=${encodeURIComponent(asset.vsCurrency)}&limit=5'`,
        response: docs.paths['/history/{assetId}'].get.responses[200].content['application/json'].example
      }
    ],
    adminEndpoints: [
      'GET /api/v1/admin/system-health — authenticated system health JSON.',
      'GET /api/v1/admin/rate-budget — authenticated CoinGecko rate budget snapshot.',
      'GET /api/v1/admin/assets/:assetId/staleness — authenticated per-interval cache freshness.',
      'GET /api/v1/admin/assets/:assetId/gaps — authenticated gap detection for an interval and range.',
      'POST /api/v1/admin/assets/:assetId/fetch — authenticated manual fetch job enqueue.',
      'POST /api/v1/admin/assets/:assetId/backfill/plan — authenticated backfill dry-run plan.',
      'POST /api/v1/admin/assets/:assetId/backfill — authenticated backfill job enqueue.'
    ],
    openApiUrl: '/api/v1/openapi.json'
  };
}

module.exports = {
  buildDocsModel,
  buildOpenApiDocument,
  normalizeAssets
};
