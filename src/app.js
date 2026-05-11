const express = require('express');
const helmet = require('helmet');
const path = require('path');

const adminAuthRoutes = require('./routes/admin-auth');
const adminRoutes = require('./routes/admin');
const apiV1Routes = require('./routes/api-v1');
const healthRoutes = require('./routes/health');
const { errorHandler, notFoundHandler } = require('./middleware/error-handlers');
const { requireAdminSession } = require('./middleware/auth');
const { requestLogger } = require('./middleware/request-logger');

function createApp(config) {
  const app = express();

  app.set('config', config);
  app.set('view engine', 'ejs');
  app.set('views', path.join(process.cwd(), 'views'));

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        'style-src': ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
        'script-src': ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
        'img-src': ["'self'", 'data:']
      }
    }
  }));
  app.use(requestLogger);
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/public', express.static(path.join(process.cwd(), 'public')));

  app.use('/admin', adminAuthRoutes);
  app.use('/api/v1/admin', requireAdminSession({ api: true }));
  app.use('/api/v1', apiV1Routes);
  app.use('/health', healthRoutes);
  app.use('/admin', requireAdminSession(), adminRoutes);

  app.get('/', (req, res) => {
    res.redirect('/admin');
  });

  app.use(notFoundHandler);

  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
