#!/usr/bin/env node

const { main } = require('./cli');

main(['migrate']).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
