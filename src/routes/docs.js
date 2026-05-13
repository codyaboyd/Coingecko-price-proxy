const express = require('express');

const { listPublicAssets } = require('../db/queries');
const { buildDocsModel } = require('../services/api-docs');

const router = express.Router();

function getDocsAssets(req) {
  const db = req.app.get('db');

  if (db) {
    return listPublicAssets(db);
  }

  const configuredAssets = req.app.get('assets');
  if (Array.isArray(configuredAssets)) {
    return configuredAssets.filter((asset) => asset.enabled !== false);
  }

  return [];
}

router.get('/', (req, res, next) => {
  try {
    res.render('docs', buildDocsModel({ assets: getDocsAssets(req) }));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
