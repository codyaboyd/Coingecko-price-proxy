const { validateAssetsFile } = require('../src/services/asset-service');
const { loadServerConfig } = require('../src/utils/config');
const logger = require('../src/utils/logger');

function main() {
  const config = loadServerConfig();
  const assets = validateAssetsFile(config.assetsConfigPath);

  logger.info(`Validated ${assets.length} configured assets from ${config.assetsConfigPath}.`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
