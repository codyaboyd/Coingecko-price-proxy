const express = require('express');

const { getPublicAsset, listPublicAssets } = require('../db/queries');

const router = express.Router();

function getDatabase(req) {
  const db = req.app.get('db');

  if (!db) {
    const error = new Error('Database connection is not available.');
    error.status = 503;
    throw error;
  }

  return db;
}

function createNotFoundError(assetId) {
  const error = new Error(`Asset '${assetId}' was not found.`);
  error.status = 404;
  error.code = 'asset_not_found';
  return error;
}

router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'chrono-cache',
    apiVersion: 'v1',
    timestamp: new Date().toISOString()
  });
});

router.get('/assets', (req, res) => {
  const assets = listPublicAssets(getDatabase(req));

  res.json({ assets });
});

router.get('/assets/:assetId', (req, res, next) => {
  const asset = getPublicAsset(getDatabase(req), req.params.assetId);

  if (!asset) {
    next(createNotFoundError(req.params.assetId));
    return;
  }

  res.json({ asset });
});

module.exports = router;
