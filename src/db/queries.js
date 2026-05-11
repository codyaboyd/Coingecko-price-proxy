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

module.exports = {
  countAssets,
  upsertAssets
};
