const express = require('express');

const {
  clearAdminSessionCookie,
  readSession,
  setAdminSessionCookie,
  validateLogin
} = require('../middleware/auth');

const router = express.Router();

function getSafeReturnTo(value) {
  if (!value || typeof value !== 'string') {
    return '/admin';
  }

  if (!value.startsWith('/admin') || value.startsWith('//')) {
    return '/admin';
  }

  if (value.startsWith('/admin/login')) {
    return '/admin';
  }

  return value;
}

router.get('/login', (req, res) => {
  const returnTo = getSafeReturnTo(req.query.returnTo);

  if (readSession(req)) {
    res.redirect(returnTo);
    return;
  }

  res.render('admin-login', {
    title: 'Admin login',
    error: null,
    username: '',
    returnTo
  });
});

router.post('/login', (req, res) => {
  const username = String(req.body.username || '');
  const password = String(req.body.password || '');
  const returnTo = getSafeReturnTo(req.body.returnTo);

  if (validateLogin(req, username, password)) {
    setAdminSessionCookie(req, res, username);
    res.redirect(returnTo);
    return;
  }

  res.status(401).render('admin-login', {
    title: 'Admin login',
    error: 'Invalid admin username or password.',
    username,
    returnTo
  });
});

router.post('/logout', (req, res) => {
  clearAdminSessionCookie(req, res);
  res.redirect('/admin/login');
});

router.get('/logout', (req, res) => {
  clearAdminSessionCookie(req, res);
  res.redirect('/admin/login');
});

module.exports = router;
