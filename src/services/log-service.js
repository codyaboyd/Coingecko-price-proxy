const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(process.cwd(), 'logs');
const LOG_FILES = ['server.log', 'error.log', 'jobs.log'];
const MAX_LOG_BYTES = 10 * 1024 * 1024;
const MAX_ROTATED_FILES = 10;
const DEFAULT_TAIL_LINES = 200;
const MAX_TAIL_LINES = 5000;

function ensureLogDirectory(logDir = LOG_DIR) {
  fs.mkdirSync(logDir, { recursive: true });
}

function getLogDirectory() {
  ensureLogDirectory(LOG_DIR);
  return LOG_DIR;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isAllowedLogFile(fileName) {
  const normalized = path.basename(String(fileName || ''));
  return LOG_FILES.some((baseName) => normalized === baseName || normalized.match(new RegExp(`^${escapeRegExp(baseName)}\\.([1-9]|10)$`)));
}

function resolveLogFile(fileName, options = {}) {
  const logDir = options.logDir || getLogDirectory();
  const rawFileName = String(fileName || LOG_FILES[0]);
  const requested = path.basename(rawFileName);

  if (rawFileName !== requested || path.isAbsolute(rawFileName) || rawFileName.includes('/') || rawFileName.includes('\\')) {
    const error = new Error('Invalid log file.');
    error.status = 400;
    throw error;
  }

  if (!isAllowedLogFile(requested)) {
    const error = new Error('Invalid log file.');
    error.status = 400;
    throw error;
  }

  const resolved = path.resolve(logDir, requested);
  const base = path.resolve(logDir);

  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    const error = new Error('Log file must be inside the logs directory.');
    error.status = 400;
    throw error;
  }

  return resolved;
}

function rotateLogFile(filePath, options = {}) {
  const maxBytes = options.maxBytes || MAX_LOG_BYTES;
  const maxFiles = options.maxFiles || MAX_ROTATED_FILES;

  if (!fs.existsSync(filePath)) {
    return false;
  }

  const stats = fs.statSync(filePath);
  if (stats.size <= maxBytes) {
    return false;
  }

  for (let index = maxFiles; index >= 1; index -= 1) {
    const rotatedPath = `${filePath}.${index}`;
    if (!fs.existsSync(rotatedPath)) {
      continue;
    }

    if (index === maxFiles) {
      fs.rmSync(rotatedPath, { force: true });
    } else {
      fs.renameSync(rotatedPath, `${filePath}.${index + 1}`);
    }
  }

  fs.renameSync(filePath, `${filePath}.1`);
  fs.closeSync(fs.openSync(filePath, 'a'));
  return true;
}

function writeLog(fileName, line, options = {}) {
  const filePath = resolveLogFile(fileName, options);
  ensureLogDirectory(path.dirname(filePath));
  rotateLogFile(filePath, options);
  fs.appendFileSync(filePath, `${line}\n`, 'utf8');
  rotateLogFile(filePath, options);
}

function listLogFiles(options = {}) {
  const logDir = options.logDir || getLogDirectory();
  ensureLogDirectory(logDir);
  LOG_FILES.forEach((fileName) => fs.closeSync(fs.openSync(path.join(logDir, fileName), 'a')));

  return fs.readdirSync(logDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isAllowedLogFile(entry.name))
    .map((entry) => {
      const filePath = path.join(logDir, entry.name);
      const stats = fs.statSync(filePath);
      return {
        name: entry.name,
        sizeBytes: stats.size,
        updatedAt: stats.mtimeMs,
        isBase: LOG_FILES.includes(entry.name)
      };
    })
    .sort((left, right) => {
      const leftBase = LOG_FILES.findIndex((base) => left.name === base || left.name.startsWith(`${base}.`));
      const rightBase = LOG_FILES.findIndex((base) => right.name === base || right.name.startsWith(`${base}.`));
      if (leftBase !== rightBase) {
        return leftBase - rightBase;
      }
      return left.name.localeCompare(right.name, undefined, { numeric: true });
    });
}

function normalizeLineCount(value) {
  const parsed = Number(value || DEFAULT_TAIL_LINES);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_TAIL_LINES;
  }
  return Math.min(parsed, MAX_TAIL_LINES);
}

function readLatestLogLines(fileName, options = {}) {
  const filePath = resolveLogFile(fileName, options);
  const lines = normalizeLineCount(options.lines);
  const filter = String(options.filter || '').trim().toLowerCase();

  if (!fs.existsSync(filePath)) {
    return [];
  }

  let allLines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  if (allLines.length && allLines[allLines.length - 1] === '') {
    allLines = allLines.slice(0, -1);
  }

  if (filter) {
    allLines = allLines.filter((line) => line.toLowerCase().includes(filter));
  }

  return allLines.slice(-lines);
}

function clearLogFile(fileName, confirmation, options = {}) {
  if (confirmation !== 'CLEAR') {
    const error = new Error('Type CLEAR to confirm log clearing.');
    error.status = 400;
    throw error;
  }

  const filePath = resolveLogFile(fileName, options);
  ensureLogDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, '', 'utf8');
  return { fileName: path.basename(filePath) };
}

module.exports = {
  LOG_FILES,
  LOG_DIR,
  MAX_LOG_BYTES,
  MAX_ROTATED_FILES,
  clearLogFile,
  getLogDirectory,
  listLogFiles,
  readLatestLogLines,
  resolveLogFile,
  rotateLogFile,
  writeLog
};
