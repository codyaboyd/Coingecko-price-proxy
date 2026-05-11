require('dotenv').config();

const { createApp } = require('./src/app');
const { loadServerConfig } = require('./src/utils/config');

const config = loadServerConfig();
const app = createApp(config);

const server = app.listen(config.port, config.host, () => {
  console.log(`chrono-cache listening at http://${config.host}:${config.port}`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down chrono-cache`);
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
