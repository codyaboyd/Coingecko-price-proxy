const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

async function openDatabase(databasePath) {
  return open({
    filename: path.resolve(process.cwd(), databasePath),
    driver: sqlite3.Database
  });
}

module.exports = { openDatabase };
