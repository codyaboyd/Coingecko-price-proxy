require('dotenv').config();

const { openDatabase } = require('../src/db/node-sqlite');
const { runMigrations } = require('../src/db/migrations');
const { loadServerConfig } = require('../src/utils/config');

function main() {
  const config = loadServerConfig();
  const db = openDatabase(config.databasePath);

  try {
    const appliedMigrations = runMigrations(db);
    const suffix = appliedMigrations.length === 0
      ? 'no pending migrations'
      : `${appliedMigrations.length} migration(s) applied`;

    console.log(`Migrations completed for ${config.databasePath}: ${suffix}`);
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
