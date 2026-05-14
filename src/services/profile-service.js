const fs = require('fs');
const path = require('path');

const { readJsonFile } = require('../utils/files');

const PROFILE_DIR = path.join(process.cwd(), 'config', 'profiles');
const PROFILE_NAMES = ['conservative', 'normal', 'aggressive'];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readProfile(profileName) {
  const normalized = String(profileName || '').trim().toLowerCase();

  if (!PROFILE_NAMES.includes(normalized)) {
    const error = new Error(`Unknown configuration profile '${profileName}'.`);
    error.status = 400;
    throw error;
  }

  const profilePath = path.join(PROFILE_DIR, `${normalized}.json`);
  const profile = readJsonFile(profilePath);

  return {
    ...profile,
    id: profile.id || normalized,
    path: profilePath
  };
}

function listProfiles() {
  return PROFILE_NAMES.map(readProfile);
}

function pickProfileValues(profile) {
  return {
    profile: profile.id,
    coingecko: clone(profile.coingecko || {}),
    automation: clone(profile.automation || {})
  };
}

function mergeConfig(currentConfig, patch) {
  const nextConfig = clone(currentConfig || {});

  Object.entries(patch).forEach(([key, value]) => {
    if (isPlainObject(value) && isPlainObject(nextConfig[key])) {
      nextConfig[key] = mergeConfig(nextConfig[key], value);
      return;
    }

    nextConfig[key] = clone(value);
  });

  return nextConfig;
}

function formatValue(value) {
  if (value === undefined) {
    return '(unset)';
  }

  if (typeof value === 'string') {
    return value;
  }

  return JSON.stringify(value);
}

function collectDiffs(currentValue, nextValue, prefix = '') {
  const keys = new Set([
    ...Object.keys(isPlainObject(currentValue) ? currentValue : {}),
    ...Object.keys(isPlainObject(nextValue) ? nextValue : {})
  ]);

  if (keys.size === 0 || !isPlainObject(currentValue) || !isPlainObject(nextValue)) {
    const currentJson = JSON.stringify(currentValue);
    const nextJson = JSON.stringify(nextValue);

    if (currentJson === nextJson) {
      return [];
    }

    return [{
      key: prefix,
      current: currentValue,
      next: nextValue,
      currentLabel: formatValue(currentValue),
      nextLabel: formatValue(nextValue)
    }];
  }

  return Array.from(keys).sort().flatMap((key) => (
    collectDiffs(currentValue[key], nextValue[key], prefix ? `${prefix}.${key}` : key)
  ));
}

function buildProfilePreview(currentConfig, profile) {
  const values = pickProfileValues(profile);
  const nextConfig = mergeConfig(currentConfig, values);
  const changes = collectDiffs(currentConfig, nextConfig)
    .filter((change) => change.key === 'profile' || change.key.startsWith('coingecko.') || change.key.startsWith('automation.'));

  return {
    profile,
    values,
    nextConfig,
    changes
  };
}

function readServerConfigFile(config) {
  const serverConfigPath = path.resolve(process.cwd(), config && config.configDir ? config.configDir : './config', 'server.json');
  return readJsonFile(serverConfigPath);
}

function ensureProfilesAvailable() {
  PROFILE_NAMES.forEach((profileName) => {
    const profilePath = path.join(PROFILE_DIR, `${profileName}.json`);
    if (!fs.existsSync(profilePath)) {
      throw new Error(`Missing profile file: ${profilePath}`);
    }
  });
}

module.exports = {
  PROFILE_NAMES,
  buildProfilePreview,
  ensureProfilesAvailable,
  listProfiles,
  mergeConfig,
  pickProfileValues,
  readProfile,
  readServerConfigFile
};
