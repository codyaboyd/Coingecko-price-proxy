const logger = require('../utils/logger');

function requestLogger(req, res, next) {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1000000;
    const remoteAddress = req.ip || req.socket.remoteAddress || '-';
    logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs.toFixed(1)}ms ${remoteAddress}`);
  });

  next();
}

module.exports = { requestLogger };
