function toDatabaseBoolean(value) {
  return value ? 1 : 0;
}

function upsertAssets(db, assets, timestamp = Date.now()) {
  const statement = db.prepare(`
    INSERT INTO assets (
      id,
      symbol,
      name,
      coingecko_id,
      vs_currency,
      enabled,
      priority,
      created_at,
      updated_at
    ) VALUES (
      @id,
      @symbol,
      @name,
      @coingeckoId,
      @vsCurrency,
      @enabled,
      @priority,
      @createdAt,
      @updatedAt
    )
    ON CONFLICT(id) DO UPDATE SET
      symbol = excluded.symbol,
      name = excluded.name,
      coingecko_id = excluded.coingecko_id,
      vs_currency = excluded.vs_currency,
      enabled = excluded.enabled,
      priority = excluded.priority,
      updated_at = excluded.updated_at
  `);

  const writeAssets = db.transaction((assetRows) => {
    assetRows.forEach((asset) => {
      statement.run({
        id: asset.id,
        symbol: asset.symbol,
        name: asset.name,
        coingeckoId: asset.coingeckoId,
        vsCurrency: asset.vsCurrency,
        enabled: toDatabaseBoolean(asset.enabled),
        priority: asset.priority,
        createdAt: timestamp,
        updatedAt: timestamp
      });
    });

    if (assetRows.length === 0) {
      db.prepare('UPDATE assets SET enabled = 0, updated_at = ?').run(timestamp);
      return;
    }

    const placeholders = assetRows.map(() => '?').join(', ');
    db.prepare(`
      UPDATE assets
      SET enabled = 0,
          updated_at = ?
      WHERE id NOT IN (${placeholders})
    `).run(timestamp, ...assetRows.map((asset) => asset.id));
  });

  writeAssets(assets);

  return assets.length;
}

function countAssets(db) {
  return db.prepare('SELECT COUNT(*) AS count FROM assets').get().count;
}

function toPublicAsset(row) {
  const asset = {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    coingeckoId: row.coingecko_id,
    vsCurrency: row.vs_currency,
    enabled: Boolean(row.enabled),
    priority: row.priority
  };

  if (row.earliest_ts !== null && row.earliest_ts !== undefined) {
    asset.earliestTs = row.earliest_ts;
  }

  if (row.latest_ts !== null && row.latest_ts !== undefined) {
    asset.latestTs = row.latest_ts;
  }

  return asset;
}

function publicAssetSelectSql(whereClause = '') {
  return `
    SELECT
      assets.id,
      assets.symbol,
      assets.name,
      assets.coingecko_id,
      assets.vs_currency,
      assets.enabled,
      assets.priority,
      candle_ranges.earliest_ts,
      candle_ranges.latest_ts
    FROM assets
    LEFT JOIN (
      SELECT
        asset_id,
        vs_currency,
        MIN(ts) AS earliest_ts,
        MAX(ts) AS latest_ts
      FROM candles
      GROUP BY asset_id, vs_currency
    ) AS candle_ranges
      ON candle_ranges.asset_id = assets.id
      AND candle_ranges.vs_currency = assets.vs_currency
    ${whereClause}
  `;
}

function listPublicAssets(db) {
  return db
    .prepare(`${publicAssetSelectSql('WHERE assets.enabled = 1')} ORDER BY assets.priority ASC, assets.symbol ASC`)
    .all()
    .map(toPublicAsset);
}

function getPublicAsset(db, assetId) {
  const row = db
    .prepare(`${publicAssetSelectSql('WHERE assets.id = ? AND assets.enabled = 1')} LIMIT 1`)
    .get(assetId);

  return row ? toPublicAsset(row) : null;
}

function toFetchRun(row) {
  return {
    id: row.id,
    assetId: row.asset_id,
    vsCurrency: row.vs_currency,
    rangeFrom: row.range_from,
    rangeTo: row.range_to,
    interval: row.interval,
    status: row.status,
    source: row.source,
    pointsInserted: row.points_inserted,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  };
}

function getAssetCandleBounds(db, assetId) {
  return db
    .prepare(`
      SELECT
        MIN(ts) AS earliest_ts,
        MAX(ts) AS latest_ts,
        COUNT(*) AS candle_count
      FROM candles
      WHERE asset_id = @assetId
    `)
    .get({ assetId });
}

function listFetchRunsForAsset(db, assetId, limit = 10) {
  return db
    .prepare(`
      SELECT
        id,
        asset_id,
        vs_currency,
        range_from,
        range_to,
        interval,
        status,
        source,
        points_inserted,
        error,
        started_at,
        finished_at
      FROM fetch_runs
      WHERE asset_id = @assetId
      ORDER BY started_at DESC, id DESC
      LIMIT @limit
    `)
    .all({ assetId, limit })
    .map(toFetchRun);
}

function createFetchRun(db, run) {
  const result = db
    .prepare(`
      INSERT INTO fetch_runs (
        asset_id,
        vs_currency,
        range_from,
        range_to,
        interval,
        status,
        source,
        points_inserted,
        error,
        started_at,
        finished_at
      ) VALUES (
        @assetId,
        @vsCurrency,
        @rangeFrom,
        @rangeTo,
        @interval,
        @status,
        @source,
        @pointsInserted,
        @error,
        @startedAt,
        @finishedAt
      )
    `)
    .run(run);

  return result.lastInsertRowid;
}

function updateFetchRun(db, id, updates) {
  db
    .prepare(`
      UPDATE fetch_runs
      SET
        status = @status,
        points_inserted = @pointsInserted,
        error = @error,
        finished_at = @finishedAt
      WHERE id = @id
    `)
    .run({ id, ...updates });
}

module.exports = {
  countAssets,
  createFetchRun,
  getAssetCandleBounds,
  getPublicAsset,
  listFetchRunsForAsset,
  listPublicAssets,
  updateFetchRun,
  upsertAssets
};
