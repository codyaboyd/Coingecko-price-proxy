#!/usr/bin/env node

const { main } = require('./cli');

main(['backup-db']).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
