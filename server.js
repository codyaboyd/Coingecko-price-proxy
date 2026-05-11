const { createApp } = require('./src/app');
const { initializeDatabase } = require('./src/db');
const { countAssets } = require('./src/db/queries');
const { loadAssets } = require('./src/services/asset-service');
const { loadServerConfig } = require('./src/utils/config');
const { createScheduler } = require('./src/jobs/scheduler');
const { createRecentRefreshScheduler } = require('./src/jobs/recent-refresh-scheduler');
const logger = require('./src/utils/logger');

const config = loadServerConfig();
const db = initializeDatabase(config);
const app = createApp(config);
const jobScheduler = createScheduler({ db });
const recentRefreshScheduler = createRecentRefreshScheduler({
  db,
  jobScheduler,
  assets: loadAssets(config.assetsConfigPath)
});

app.set('db', db);
app.set('jobScheduler', jobScheduler);
app.set('recentRefreshScheduler', recentRefreshScheduler);
recentRefreshScheduler.start();

const server = app.listen(config.port, config.host, () => {
  logger.info(`${config.appName} listening at http://${config.host}:${config.port}`);
  logger.info(`Database ready at ${config.databasePath}; ${countAssets(db)} asset(s) loaded`);
});

function shutdown(signal) {
  logger.info(`${signal} received, shutting down ${config.appName}`);
  recentRefreshScheduler.stopTimer();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
