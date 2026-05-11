const { readJsonFile, resolveFromRoot } = require('../utils/files');

const REQUIRED_FIELDS = ['id', 'symbol', 'name', 'coingeckoId', 'vsCurrency', 'enabled', 'priority'];

function describeLocation(index) {
  return `assets[${index}]`;
}

function isBlankString(value) {
  return typeof value !== 'string' || value.trim().length === 0;
}


function validateFetchPolicy(fetchPolicy, location) {
  const errors = [];

  if (fetchPolicy === undefined) {
    return errors;
  }

  if (!fetchPolicy || typeof fetchPolicy !== 'object' || Array.isArray(fetchPolicy)) {
    return [`${location}.fetchPolicy must be an object when provided.`];
  }

  if (
    Object.prototype.hasOwnProperty.call(fetchPolicy, 'recentEveryMinutes') &&
    (!Number.isFinite(Number(fetchPolicy.recentEveryMinutes)) || Number(fetchPolicy.recentEveryMinutes) <= 0)
  ) {
    errors.push(`${location}.fetchPolicy.recentEveryMinutes must be a positive number.`);
  }

  if (
    Object.prototype.hasOwnProperty.call(fetchPolicy, 'dailyBackfill') &&
    typeof fetchPolicy.dailyBackfill !== 'boolean'
  ) {
    errors.push(`${location}.fetchPolicy.dailyBackfill must be true or false.`);
  }

  if (
    Object.prototype.hasOwnProperty.call(fetchPolicy, 'maxBackfillDaysPerRun') &&
    (!Number.isFinite(Number(fetchPolicy.maxBackfillDaysPerRun)) || Number(fetchPolicy.maxBackfillDaysPerRun) <= 0)
  ) {
    errors.push(`${location}.fetchPolicy.maxBackfillDaysPerRun must be a positive number.`);
  }

  return errors;
}

function validateAsset(asset, index) {
  const location = describeLocation(index);
  const errors = [];

  if (!asset || typeof asset !== 'object' || Array.isArray(asset)) {
    return [`${location} must be an object.`];
  }

  REQUIRED_FIELDS.forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(asset, field)) {
      errors.push(`${location}.${field} is required.`);
    }
  });

  ['id', 'symbol', 'name', 'coingeckoId', 'vsCurrency'].forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(asset, field) && isBlankString(asset[field])) {
      errors.push(`${location}.${field} must be a non-empty string.`);
    }
  });

  if (Object.prototype.hasOwnProperty.call(asset, 'enabled') && typeof asset.enabled !== 'boolean') {
    errors.push(`${location}.enabled must be true or false.`);
  }

  if (Object.prototype.hasOwnProperty.call(asset, 'priority')) {
    if (!Number.isInteger(asset.priority) || asset.priority < 0) {
      errors.push(`${location}.priority must be a non-negative integer.`);
    }
  }

  errors.push(...validateFetchPolicy(asset.fetchPolicy, location));

  return errors;
}

function validateAssetsPayload(payload) {
  const errors = [];

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Asset config must be a JSON object with an assets array.'];
  }

  if (!Array.isArray(payload.assets)) {
    return ['Asset config must contain an assets array.'];
  }

  if (payload.assets.length === 0) {
    errors.push('Asset config must contain at least one asset.');
  }

  payload.assets.forEach((asset, index) => {
    errors.push(...validateAsset(asset, index));
  });

  return errors;
}

function readAssetConfig(configPath) {
  try {
    return readJsonFile(configPath);
  } catch (error) {
    const resolvedPath = resolveFromRoot(configPath);
    throw new Error(`Unable to read asset config at ${resolvedPath}: ${error.message}`);
  }
}

function loadAssets(configPath) {
  const payload = readAssetConfig(configPath);
  const errors = validateAssetsPayload(payload);

  if (errors.length > 0) {
    const resolvedPath = resolveFromRoot(configPath);
    const message = [`Invalid asset config: ${resolvedPath}`, ...errors.map((error) => `- ${error}`)].join('\n');
    const validationError = new Error(message);
    validationError.errors = errors;
    validationError.configPath = resolvedPath;
    throw validationError;
  }

  return payload.assets;
}

function validateAssetsFile(configPath) {
  return loadAssets(configPath);
}

module.exports = {
  REQUIRED_FIELDS,
  loadAssets,
  readAssetConfig,
  validateAsset,
  validateFetchPolicy,
  validateAssetsFile,
  validateAssetsPayload
};
