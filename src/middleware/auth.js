const crypto = require('crypto');

const SESSION_COOKIE_NAME = 'chrono_cache_admin_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function getAdminAuthConfig(req) {
  const config = req.app.get('config') || {};
  return config.adminAuth || {};
}

function hasCredentials(authConfig) {
  return Boolean(authConfig.username && authConfig.password && authConfig.sessionSecret);
}

function parseCookies(cookieHeader) {
  if (!cookieHeader) {
    return {};
  }

  return cookieHeader.split(';').reduce((cookies, part) => {
    const separatorIndex = part.indexOf('=');

    if (separatorIndex === -1) {
      return cookies;
    }

    const name = decodeURIComponent(part.slice(0, separatorIndex).trim());
    const value = decodeURIComponent(part.slice(separatorIndex + 1).trim());
    cookies[name] = value;
    return cookies;
  }, {});
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function serializeSession(username, secret) {
  const payload = JSON.stringify({
    username,
    createdAt: Date.now(),
    nonce: crypto.randomBytes(16).toString('base64url')
  });
  const encodedPayload = Buffer.from(payload).toString('base64url');
  return `${encodedPayload}.${sign(encodedPayload, secret)}`;
}

function readSession(req) {
  const authConfig = getAdminAuthConfig(req);

  if (!hasCredentials(authConfig)) {
    return null;
  }

  const cookies = parseCookies(req.headers.cookie);
  const cookieValue = cookies[SESSION_COOKIE_NAME];

  if (!cookieValue) {
    return null;
  }

  const [encodedPayload, signature] = cookieValue.split('.');

  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = sign(encodedPayload, authConfig.sessionSecret);

  if (!safeEqual(signature, expectedSignature)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch (error) {
    return null;
  }

  if (!payload || payload.username !== authConfig.username || !Number.isFinite(payload.createdAt)) {
    return null;
  }

  if (Date.now() - payload.createdAt > SESSION_TTL_MS) {
    return null;
  }

  return payload;
}

function buildCookieOptions(req, maxAgeSeconds) {
  const secure = req.secure || req.app.get('env') === 'production';
  return [
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    secure ? 'Secure' : null
  ].filter(Boolean).join('; ');
}

function setAdminSessionCookie(req, res, username) {
  const authConfig = getAdminAuthConfig(req);
  const value = serializeSession(username, authConfig.sessionSecret);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}; ${buildCookieOptions(req, Math.floor(SESSION_TTL_MS / 1000))}`);
}

function clearAdminSessionCookie(req, res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; ${buildCookieOptions(req, 0)}`);
}

function validateLogin(req, username, password) {
  const authConfig = getAdminAuthConfig(req);

  if (!hasCredentials(authConfig)) {
    return false;
  }

  return safeEqual(username, authConfig.username) && safeEqual(password, authConfig.password);
}

function requireAdminSession(options = {}) {
  return (req, res, next) => {
    const authConfig = getAdminAuthConfig(req);

    if (!hasCredentials(authConfig)) {
      const message = 'Admin authentication is not configured. Set ADMIN_USERNAME, ADMIN_PASSWORD, and ADMIN_SESSION_SECRET.';

      if (options.api) {
        res.status(503).json({ error: 'admin_auth_not_configured', message });
        return;
      }

      res.status(503).render('admin-login', {
        title: 'Admin login',
        error: message,
        username: '',
        returnTo: req.originalUrl || '/admin'
      });
      return;
    }

    const session = readSession(req);

    if (session) {
      req.adminUser = { username: session.username };
      next();
      return;
    }

    if (options.api) {
      res.status(401).json({ error: 'admin_auth_required', message: 'Admin authentication is required.' });
      return;
    }

    const returnTo = encodeURIComponent(req.originalUrl || '/admin');
    res.redirect(`/admin/login?returnTo=${returnTo}`);
  };
}

module.exports = {
  clearAdminSessionCookie,
  readSession,
  requireAdminSession,
  setAdminSessionCookie,
  validateLogin
};
