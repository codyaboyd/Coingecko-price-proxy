const express = require('express');

const { loadAssets } = require('../services/asset-service');
const { resolveFromRoot } = require('../utils/files');

const router = express.Router();

router.get('/', (req, res, next) => {
  try {
    const config = req.app.get('config');
    const assets = loadAssets(config.assetsConfigPath);

    res.render('admin', {
      title: config.adminTitle,
      assets,
      status: {
        appName: config.appName,
        runtime: `Node.js ${process.version} (${config.nodeEnv})`,
        assetsLoaded: assets.length,
        configPath: resolveFromRoot(config.assetsConfigPath),
        databasePath: resolveFromRoot(config.databasePath)
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
