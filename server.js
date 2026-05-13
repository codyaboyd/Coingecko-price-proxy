const logger = require('./src/utils/logger');

function formatStartupError(error) {
  if (Array.isArray(error.errors) && error.errors.length > 0) {
    return `${error.message}\n${error.errors.map((item) => `  - ${item}`).join('\n')}`;
  }

  return error && error.stack ? error.stack : String(error);
}

function start() {
  const { runStartupSelfCheck, formatSelfCheckResult } = require('./src/services/startup-self-check');
  const { loadServerConfig } = require('./src/utils/config');

  const config = loadServerConfig();
  const selfCheck = runStartupSelfCheck({ config });

  if (!selfCheck.ok) {
    throw new Error(formatSelfCheckResult(selfCheck));
  }

  if (selfCheck.degraded) {
    logger.warn(formatSelfCheckResult(selfCheck));
  }

  const { createApp } = require('./src/app');
  const { initializeDatabase } = require('./src/db');
  const { countAssets } = require('./src/db/queries');
  const { loadAssets } = require('./src/services/asset-service');
  const { createHotReloadManager } = require('./src/services/hot-reload');
  const { createScheduler } = require('./src/jobs/scheduler');
  const { createRecentRefreshScheduler } = require('./src/jobs/recent-refresh-scheduler');
  const { setGlobalAlertDatabase } = require('./src/services/alert-service');

  const assets = loadAssets(config.assetsConfigPath);
  const db = initializeDatabase(config, { syncAssets: false });
  const app = createApp(config);
  setGlobalAlertDatabase(db);
  const jobScheduler = createScheduler({ db, config });
  const recentRefreshScheduler = createRecentRefreshScheduler({
    db,
    jobScheduler,
    assets,
    maintenanceMode: config.maintenanceMode
  });
  const hotReloadManager = createHotReloadManager({
    app,
    db,
    config,
    jobScheduler,
    recentRefreshScheduler,
    assets
  });

  app.set('startupSelfCheck', selfCheck);
  app.set('degradedMode', selfCheck.degraded);
  app.set('db', db);
  app.set('assets', assets);
  app.set('jobScheduler', jobScheduler);
  app.set('recentRefreshScheduler', recentRefreshScheduler);
  app.set('hotReloadManager', hotReloadManager);
  recentRefreshScheduler.start();
  jobScheduler.startDailyBackupJob();
  jobScheduler.process();
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
    jobScheduler.stopDailyBackupJob();
    Promise.resolve(hotReloadManager.stop()).finally(() => {
      server.close(() => {
        setGlobalAlertDatabase(null);
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
