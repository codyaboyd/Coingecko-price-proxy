const { loadAssets } = require('./asset-service');

function getConfiguredAssets(configPath) {
  return loadAssets(configPath);
}

module.exports = { getConfiguredAssets };
