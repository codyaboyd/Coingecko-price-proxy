const { createApp } = require('./src/app');
const { loadServerConfig } = require('./src/utils/config');
const logger = require('./src/utils/logger');

const config = loadServerConfig();
const app = createApp(config);

const server = app.listen(config.port, config.host, () => {
  logger.info(`${config.appName} listening at http://${config.host}:${config.port}`);
});

function shutdown(signal) {
  logger.info(`${signal} received, shutting down ${config.appName}`);
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
