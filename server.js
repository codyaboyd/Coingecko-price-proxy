const logger = require('./src/utils/logger');

function formatStartupError(error) {
  if (Array.isArray(error.errors) && error.errors.length > 0) {
    return `${error.message}\n${error.errors.map((item) => `  - ${item}`).join('\n')}`;
  }

  return error && error.stack ? error.stack : String(error);
}

function start() {
  const { createApp } = require('./src/app');
  const { initializeDatabase } = require('./src/db');
  const { countAssets } = require('./src/db/queries');
  const { loadAssets } = require('./src/services/asset-service');
  const { createHotReloadManager } = require('./src/services/hot-reload');
  const { loadServerConfig } = require('./src/utils/config');
  const { createScheduler } = require('./src/jobs/scheduler');
  const { createRecentRefreshScheduler } = require('./src/jobs/recent-refresh-scheduler');

  const config = loadServerConfig();
  const assets = loadAssets(config.assetsConfigPath);
  const db = initializeDatabase(config, { syncAssets: false });
  const app = createApp(config);
  const jobScheduler = createScheduler({ db });
  const recentRefreshScheduler = createRecentRefreshScheduler({
    db,
    jobScheduler,
    assets
  });
  const hotReloadManager = createHotReloadManager({
    app,
    db,
    config,
    jobScheduler,
    recentRefreshScheduler,
    assets
  });

  app.set('db', db);
  app.set('assets', assets);
  app.set('jobScheduler', jobScheduler);
  app.set('recentRefreshScheduler', recentRefreshScheduler);
  app.set('hotReloadManager', hotReloadManager);
  recentRefreshScheduler.start();
  hotReloadManager.reloadAssetsConfig();
  hotReloadManager.start();

  const server = app.listen(config.port, config.host, () => {
    logger.info(`${config.appName} listening at http://${config.host}:${config.port}`);
    logger.info(`Database ready at ${config.databasePath}; ${countAssets(db)} asset(s) loaded`);
  });

  server.on('error', (error) => {
    logger.error(`Startup failed while binding ${config.host}:${config.port}: ${error.message}`);
    db.close();
    process.exit(1);
  });

  function shutdown(signal) {
    logger.info(`${signal} received, shutting down ${config.appName}`);
    recentRefreshScheduler.stopTimer();
    Promise.resolve(hotReloadManager.stop()).finally(() => {
      server.close(() => {
        db.close();
        process.exit(0);
      });
    });
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

try {
  start();
} catch (error) {
  logger.error(`Startup failed: ${formatStartupError(error)}`);
  process.exit(1);
}
