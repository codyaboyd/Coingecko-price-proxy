const logger = require('../utils/logger');

const ALERT_STATUSES = new Set(['open', 'acknowledged', 'resolved']);
const ALERT_SEVERITIES = new Set(['info', 'warning', 'critical']);

let globalDb = null;

function setGlobalAlertDatabase(db) {
  globalDb = db || null;
}

function getGlobalAlertDatabase() {
  return globalDb;
}

function normalizeEnum(value, allowed, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  return allowed.has(normalized) ? normalized : fallback;
}

function normalizeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function toAlert(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    severity: row.severity,
    type: row.type,
    title: row.title,
    message: row.message,
    entityType: row.entity_type,
    entityId: row.entity_id,
    status: row.status,
    createdAt: row.created_at,
    acknowledgedAt: row.acknowledged_at,
    createdAtIso: new Date(row.created_at).toISOString(),
    acknowledgedAtIso: row.acknowledged_at ? new Date(row.acknowledged_at).toISOString() : null
  };
}

async function postWebhook(alert) {
  const webhookUrl = String(process.env.ALERT_WEBHOOK_URL || '').trim();

  if (!webhookUrl || typeof fetch !== 'function') {
    return;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(alert)
    });

    if (!response.ok) {
      logger.warn(`Alert webhook POST failed with HTTP ${response.status}.`);
    }
  } catch (error) {
    logger.warn(`Alert webhook POST failed: ${error.message}`);
  }
}

function findActiveAlert(db, type, entityType, entityId) {
  return toAlert(db.prepare(`
    SELECT * FROM alerts
    WHERE type = @type
      AND COALESCE(entity_type, '') = COALESCE(@entityType, '')
      AND COALESCE(entity_id, '') = COALESCE(@entityId, '')
      AND status IN ('open', 'acknowledged')
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get({ type, entityType, entityId }));
}

function createAlert(db, alert) {
  if (!db) {
    return null;
  }

  const severity = normalizeEnum(alert.severity, ALERT_SEVERITIES, 'warning');
  const type = normalizeText(alert.type, 'general');
  const title = normalizeText(alert.title, type);
  const message = normalizeText(alert.message, title);
  const entityType = alert.entityType || alert.entity_type || null;
  const entityId = alert.entityId || alert.entity_id || null;
  const existing = findActiveAlert(db, type, entityType, entityId);

  if (existing) {
    return existing;
  }

  const now = alert.createdAt || Date.now();
  const result = db.prepare(`
    INSERT INTO alerts (severity, type, title, message, entity_type, entity_id, status, created_at, acknowledged_at)
    VALUES (@severity, @type, @title, @message, @entityType, @entityId, 'open', @createdAt, NULL)
  `).run({ severity, type, title, message, entityType, entityId, createdAt: now });
  const created = getAlert(db, result.lastInsertRowid);

  postWebhook(created);
  return created;
}

function createGlobalAlert(alert) {
  if (!globalDb) {
    return null;
  }

  try {
    return createAlert(globalDb, alert);
  } catch (error) {
    logger.warn(`Unable to create alert ${alert.type || 'unknown'}: ${error.message}`);
    return null;
  }
}

function getAlert(db, id) {
  return toAlert(db.prepare('SELECT * FROM alerts WHERE id = ?').get(id));
}

function listAlerts(db, options = {}) {
  const allowedStatuses = ['open', 'acknowledged', 'resolved'];
  const status = allowedStatuses.includes(options.status) ? options.status : null;
  const limit = Number.isInteger(Number(options.limit)) ? Math.min(500, Math.max(1, Number(options.limit))) : 100;
  const rows = status
    ? db.prepare('SELECT * FROM alerts WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(status, limit)
    : db.prepare('SELECT * FROM alerts ORDER BY created_at DESC, id DESC LIMIT ?').all(limit);
  return rows.map(toAlert);
}

function countOpenAlerts(db) {
  if (!db) {
    return 0;
  }

  try {
    return db.prepare("SELECT COUNT(*) AS count FROM alerts WHERE status = 'open'").get().count;
  } catch (error) {
    return 0;
  }
}

function updateAlertStatus(db, id, status) {
  const normalized = normalizeEnum(status, ALERT_STATUSES, null);

  if (!normalized || normalized === 'open') {
    const error = new Error('Alert status must be acknowledged or resolved.');
    error.status = 400;
    throw error;
  }

  const now = Date.now();
  db.prepare(`
    UPDATE alerts
    SET status = @status,
        acknowledged_at = CASE WHEN @status = 'acknowledged' AND acknowledged_at IS NULL THEN @now ELSE acknowledged_at END
    WHERE id = @id
      AND status != 'resolved'
  `).run({ id, status: normalized, now });
  return getAlert(db, id);
}

function resolveActiveAlert(db, type, entityType, entityId) {
  const now = Date.now();
  db.prepare(`
    UPDATE alerts
    SET status = 'resolved'
    WHERE type = @type
      AND COALESCE(entity_type, '') = COALESCE(@entityType, '')
      AND COALESCE(entity_id, '') = COALESCE(@entityId, '')
      AND status IN ('open', 'acknowledged')
  `).run({ type, entityType, entityId, now });
}

function createAlertsFromHealthReport(db, report) {
  if (!db || !report || !Array.isArray(report.checks)) {
    return [];
  }

  const created = [];
  const emit = (alert) => {
    const item = createAlert(db, alert);
    if (item) {
      created.push(item);
    }
  };

  report.checks.forEach((check) => {
    if (check.id === 'latest_backup_time') {
      const latestBackupAt = Number(check.value);
      const backupAgeMs = Number.isFinite(latestBackupAt) ? report.generatedAt - latestBackupAt : null;
      if (check.status !== 'ok' || backupAgeMs === null || backupAgeMs > 25 * 60 * 60 * 1000) {
        emit({
          severity: 'warning',
          type: 'backup_overdue',
          title: 'Backup overdue',
          message: backupAgeMs === null ? check.summary : `Latest backup is ${Math.floor(backupAgeMs / (60 * 60 * 1000))} hour(s) old.`,
          entityType: 'backup',
          entityId: 'sqlite'
        });
      }
    }

    if (check.id === 'project_free_disk_space' && ['warning', 'critical'].includes(check.status)) {
      emit({ severity: check.status === 'critical' ? 'critical' : 'warning', type: 'disk_space_low', title: 'Disk space low', message: check.summary, entityType: 'system', entityId: 'project_disk' });
    }

    if (check.id === 'scheduler_state' && check.status !== 'ok' && check.value !== 'paused') {
      emit({ severity: 'critical', type: 'scheduler_stopped_unexpectedly', title: 'Scheduler stopped unexpectedly', message: check.summary, entityType: 'scheduler', entityId: 'recent-refresh' });
    }
  });

  const staleCheck = report.checks.find((check) => check.id === 'assets_with_stale_data');
  if (staleCheck && Array.isArray(staleCheck.details)) {
    staleCheck.details.forEach((asset) => {
      emit({ severity: 'warning', type: 'asset_stale_too_long', title: `Asset stale too long: ${asset.symbol || asset.assetId}`, message: `${asset.assetId} has stale cached data; latest fetched at ${asset.latestFetchedAtIso || 'never'}.`, entityType: 'asset', entityId: asset.assetId });
    });
  }

  return created;
}

function createAlertsFromIntegrityReport(db, report) {
  if (!db || !report || !Array.isArray(report.checks)) {
    return [];
  }

  return report.checks
    .filter((check) => check.status === 'critical')
    .map((check) => createAlert(db, {
      severity: 'critical',
      type: 'database_integrity_failure',
      title: `Database integrity failure: ${check.title}`,
      message: check.summary,
      entityType: 'db_check',
      entityId: check.id
    }))
    .filter(Boolean);
}

module.exports = {
  ALERT_STATUSES,
  createAlert,
  createAlertsFromHealthReport,
  createAlertsFromIntegrityReport,
  createGlobalAlert,
  countOpenAlerts,
  getAlert,
  listAlerts,
  resolveActiveAlert,
  setGlobalAlertDatabase,
  updateAlertStatus
};
