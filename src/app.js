const express = require('express');
const path = require('path');

const adminRoutes = require('./routes/admin');
const apiV1Routes = require('./routes/api-v1');
const healthRoutes = require('./routes/health');
const { errorHandler, notFoundHandler } = require('./middleware/error-handlers');

function createApp(config) {
  const app = express();

  app.set('config', config);
  app.set('view engine', 'ejs');
  app.set('views', path.join(process.cwd(), 'views'));

  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/public', express.static(path.join(process.cwd(), 'public')));

  app.use('/api/v1', apiV1Routes);
  app.use('/health', healthRoutes);
  app.use('/admin', adminRoutes);

  app.get('/', (req, res) => {
    res.redirect('/admin');
  });

  app.use(notFoundHandler);

  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
