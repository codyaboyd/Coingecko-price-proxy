const express = require('express');

const { getConfiguredAssets } = require('../services/assets');

const router = express.Router();

router.get('/', (req, res, next) => {
  try {
    const config = req.app.get('config');
    const assets = getConfiguredAssets(config.assetsConfigPath);

    res.render('admin', {
      title: config.adminTitle,
      assets,
      databasePath: config.databasePath
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
