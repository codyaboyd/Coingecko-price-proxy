const { writeLog } = require('../services/log-service');

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

function formatMetadata(metadata) {
  if (metadata === undefined) {
    return '';
  }

  if (metadata instanceof Error) {
    return ` ${metadata.stack || metadata.message}`;
  }

  if (typeof metadata === 'string') {
    return ` ${metadata}`;
  }

  try {
    return ` ${JSON.stringify(metadata)}`;
  } catch (error) {
    return ` ${String(metadata)}`;
  }
}

function formatMessage(level, message, metadata) {
  const timestamp = new Date().toISOString();
  return `[${timestamp}] ${level.toUpperCase()} ${message}${formatMetadata(metadata)}`;
}

function writeToFiles(level, output, options = {}) {
  try {
    if (process.env.SERVER_LOG_CAPTURED !== '1') {
      writeLog('server.log', output);
    }

    if (level === 'error') {
      writeLog('error.log', output);
    }

    if (options.job === true) {
      writeLog('jobs.log', output);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ERROR Failed to write log file: ${error.message}`);
  }
}

function write(level, message, metadata, options = {}) {
  if (!shouldLog(level)) {
    return;
  }

  const output = formatMessage(level, message, metadata);
  const args = metadata === undefined ? [output] : [output, metadata];
  writeToFiles(level, output, options);

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
  },
  jobInfo(message, metadata) {
    write('info', message, metadata, { job: true });
  },
  jobWarn(message, metadata) {
    write('warn', message, metadata, { job: true });
  },
  jobError(message, metadata) {
    write('error', message, metadata, { job: true });
  }
};
