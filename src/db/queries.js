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
    .prepare(`${publicAssetSelectSql()} ORDER BY assets.priority ASC, assets.symbol ASC`)
    .all()
    .map(toPublicAsset);
}

function getPublicAsset(db, assetId) {
  const row = db
    .prepare(`${publicAssetSelectSql('WHERE assets.id = ?')} LIMIT 1`)
    .get(assetId);

  return row ? toPublicAsset(row) : null;
}

module.exports = {
  countAssets,
  getPublicAsset,
  listPublicAssets,
  upsertAssets
};
