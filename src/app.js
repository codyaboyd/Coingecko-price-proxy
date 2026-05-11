const express = require('express');
const path = require('path');

const adminRoutes = require('./routes/admin');
const healthRoutes = require('./routes/health');

function createApp(config) {
  const app = express();

  app.set('config', config);
  app.set('view engine', 'ejs');
  app.set('views', path.join(process.cwd(), 'views'));

  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/public', express.static(path.join(process.cwd(), 'public')));

  app.use('/health', healthRoutes);
  app.use('/admin', adminRoutes);

  app.get('/', (req, res) => {
    res.redirect('/admin');
  });

  app.use((req, res) => {
    res.status(404).render('error', {
      title: 'Not Found',
      message: 'The requested page could not be found.'
    });
  });

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('error', {
      title: 'Server Error',
      message: 'Something went wrong.'
    });
  });

  return app;
}

module.exports = { createApp };
