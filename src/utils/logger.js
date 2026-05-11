const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function getConfiguredLevel() {
  const configuredLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[configuredLevel] ? configuredLevel : 'info';
}

function shouldLog(level) {
  return LEVELS[level] >= LEVELS[getConfiguredLevel()];
}

function formatMessage(level, message) {
  const timestamp = new Date().toISOString();
  return `[${timestamp}] ${level.toUpperCase()} ${message}`;
}

function write(level, message, metadata) {
  if (!shouldLog(level)) {
    return;
  }

  const output = formatMessage(level, message);
  const args = metadata === undefined ? [output] : [output, metadata];

  if (level === 'error') {
    console.error(...args);
    return;
  }

  if (level === 'warn') {
    console.warn(...args);
    return;
  }

  console.log(...args);
}

module.exports = {
  debug(message, metadata) {
    write('debug', message, metadata);
  },
  info(message, metadata) {
    write('info', message, metadata);
  },
  warn(message, metadata) {
    write('warn', message, metadata);
  },
  error(message, metadata) {
    write('error', message, metadata);
  }
};
