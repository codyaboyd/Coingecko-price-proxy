#!/usr/bin/env node

const { main } = require('./cli');

main(['validate-assets']).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
