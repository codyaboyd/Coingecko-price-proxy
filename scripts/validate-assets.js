const { getConfiguredAssets } = require('../src/services/assets');
const { loadServerConfig } = require('../src/utils/config');

function validateAsset(asset, index) {
  const requiredFields = ['id', 'symbol', 'name', 'currency'];
  const missing = requiredFields.filter((field) => !asset[field]);

  if (missing.length > 0) {
    throw new Error(`Asset at index ${index} is missing: ${missing.join(', ')}`);
  }
}

function main() {
  const config = loadServerConfig();
  const assets = getConfiguredAssets(config.assetsConfigPath);

  if (assets.length === 0) {
    throw new Error('No assets are configured.');
  }

  assets.forEach(validateAsset);
  console.log(`Validated ${assets.length} configured assets.`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
