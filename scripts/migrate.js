require('dotenv').config();

const { openDatabase } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrations');
const { loadServerConfig } = require('../src/utils/config');
const { ensureDirectory } = require('../src/utils/files');

async function main() {
  const config = loadServerConfig();
  ensureDirectory('data');

  const db = await openDatabase(config.databasePath);
  await runMigrations(db);
  await db.close();

  console.log(`Migrations completed for ${config.databasePath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
