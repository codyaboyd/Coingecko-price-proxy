const logger = require('../utils/logger');

function isApiRequest(req) {
  return req.path.startsWith('/api/');
}

function notFoundHandler(req, res) {
  if (isApiRequest(req)) {
    res.status(404).json({
      error: {
        code: 'not_found',
        message: 'The requested API route could not be found.'
      }
    });
    return;
  }

  res.status(404).render('error', {
    title: 'Not Found',
    message: 'The requested page could not be found.'
  });
}

function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  const safeStatus = status >= 400 && status < 600 ? status : 500;
  const code = err.code || (safeStatus === 500 ? 'server_error' : 'request_error');
  const message = safeStatus === 500 ? 'Something went wrong.' : err.message;

  logger.error(err.message, { stack: err.stack });

  if (isApiRequest(req)) {
    res.status(safeStatus).json({
      error: {
        code,
        message
      }
    });
    return;
  }

  res.status(safeStatus).render('error', {
    title: safeStatus === 404 ? 'Not Found' : 'Server Error',
    message
  });
}

module.exports = {
  errorHandler,
  notFoundHandler
};
