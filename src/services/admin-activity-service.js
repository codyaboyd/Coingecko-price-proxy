const ADMIN_EVENT_ACTIONS = [
  'login',
  'logout',
  'config edit',
  'config rollback',
  'manual fetch',
  'backfill request',
  'scheduler pause',
  'scheduler resume',
  'maintenance mode toggle',
  'backup created',
  'backup deleted',
  'restore attempted',
  'import run',
  'job retry',
  'job cancel'
];

const ADMIN_EVENT_ENTITY_TYPES = [
  'session',
  'config',
  'asset',
  'scheduler',
  'backup',
  'restore',
  'import',
  'job'
];

function getRequestIp(req) {
  const forwardedFor = req.headers['x-forwarded-for'];

  if (forwardedFor) {
    return String(forwardedFor).split(',')[0].trim();
  }

  return req.ip || (req.socket && req.socket.remoteAddress) || '';
}

function getActor(req, fallback = 'admin-ui') {
  if (req.adminUser && req.adminUser.username) {
    return req.adminUser.username;
  }

  if (req.body && req.body.username) {
    return String(req.body.username);
  }

  return fallback;
}

function stringifyDetails(details) {
  if (details === null || details === undefined) {
    return null;
  }

  return JSON.stringify(details);
}

function toAdminEvent(row) {
  let details = null;

  if (row.details_json) {
    try {
      details = JSON.parse(row.details_json);
    } catch (error) {
      details = row.details_json;
    }
  }

  return {
    id: row.id,
    actor: row.actor,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    detailsJson: row.details_json,
    details,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    createdAt: row.created_at
  };
}

function insertAdminEvent(db, event) {
  const now = Date.now();
  const result = db.prepare(`
    INSERT INTO admin_events (
      actor,
      action,
      entity_type,
      entity_id,
      details_json,
      ip_address,
      user_agent,
      created_at
    ) VALUES (
      @actor,
      @action,
      @entityType,
      @entityId,
      @detailsJson,
      @ipAddress,
      @userAgent,
      @createdAt
    )
  `).run({
    actor: event.actor || 'admin-ui',
    action: event.action,
    entityType: event.entityType || null,
    entityId: event.entityId === undefined || event.entityId === null ? null : String(event.entityId),
    detailsJson: stringifyDetails(event.details),
    ipAddress: event.ipAddress || null,
    userAgent: event.userAgent || null,
    createdAt: event.createdAt || now
  });

  return result.lastInsertRowid;
}

function recordAdminEvent(req, event) {
  const db = req.app.get('db');

  if (!db) {
    return null;
  }

  return insertAdminEvent(db, {
    actor: getActor(req, event.actor),
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    details: event.details,
    ipAddress: getRequestIp(req),
    userAgent: req.get ? req.get('user-agent') : req.headers['user-agent']
  });
}

function parseDateBoundary(value, endOfDay = false) {
  const text = String(value || '').trim();

  if (!text) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const suffix = endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
    const timestamp = Date.parse(`${text}${suffix}`);
    return Number.isNaN(timestamp) ? null : timestamp;
  }

  const timestamp = Date.parse(text);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function normalizeAdminEventFilters(input = {}) {
  const action = String(input.action || '').trim();
  const entityType = String(input.entityType || input.entity_type || '').trim();
  const from = String(input.from || '').trim();
  const to = String(input.to || '').trim();

  return {
    action,
    entityType,
    from,
    to,
    fromTs: parseDateBoundary(from, false),
    toTs: parseDateBoundary(to, true)
  };
}

function buildFilterWhere(filters) {
  const where = [];
  const params = {};

  if (filters.action) {
    where.push('action = @action');
    params.action = filters.action;
  }

  if (filters.entityType) {
    where.push('entity_type = @entityType');
    params.entityType = filters.entityType;
  }

  if (filters.fromTs !== null) {
    where.push('created_at >= @fromTs');
    params.fromTs = filters.fromTs;
  }

  if (filters.toTs !== null) {
    where.push('created_at <= @toTs');
    params.toTs = filters.toTs;
  }

  return {
    whereSql: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
    params
  };
}

function listAdminEvents(db, input = {}, options = {}) {
  const filters = normalizeAdminEventFilters(input);
  const limit = Math.min(Math.max(Number(options.limit || input.limit || 100), 1), 1000);
  const { whereSql, params } = buildFilterWhere(filters);
  const rows = db.prepare(`
    SELECT id, actor, action, entity_type, entity_id, details_json, ip_address, user_agent, created_at
    FROM admin_events
    ${whereSql}
    ORDER BY created_at DESC, id DESC
    LIMIT @limit
  `).all({ ...params, limit });

  return {
    filters,
    events: rows.map(toAdminEvent)
  };
}

function listAdminEventFacetValues(db, column) {
  if (!['action', 'entity_type'].includes(column)) {
    throw new Error('Unsupported admin event facet.');
  }

  return db.prepare(`
    SELECT DISTINCT ${column} AS value
    FROM admin_events
    WHERE ${column} IS NOT NULL AND ${column} != ''
    ORDER BY ${column} ASC
  `).all().map((row) => row.value);
}

function toCsvValue(value) {
  if (value === null || value === undefined) {
    return '';
  }

  const text = String(value);

  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function adminEventsToCsv(events) {
  const headers = ['id', 'created_at', 'actor', 'action', 'entity_type', 'entity_id', 'details_json', 'ip_address', 'user_agent'];
  const rows = events.map((event) => [
    event.id,
    new Date(event.createdAt).toISOString(),
    event.actor,
    event.action,
    event.entityType,
    event.entityId,
    event.detailsJson,
    event.ipAddress,
    event.userAgent
  ]);

  return [headers, ...rows]
    .map((row) => row.map(toCsvValue).join(','))
    .join('\n');
}

module.exports = {
  ADMIN_EVENT_ACTIONS,
  ADMIN_EVENT_ENTITY_TYPES,
  adminEventsToCsv,
  insertAdminEvent,
  listAdminEventFacetValues,
  listAdminEvents,
  recordAdminEvent
};
