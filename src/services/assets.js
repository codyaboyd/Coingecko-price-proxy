const { readJsonFile } = require('../utils/files');

function getConfiguredAssets(configPath) {
  const payload = readJsonFile(configPath);
  return Array.isArray(payload.assets) ? payload.assets : [];
}

module.exports = { getConfiguredAssets };
