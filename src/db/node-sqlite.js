const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function resolveDatabasePath(databasePath) {
  return path.resolve(process.cwd(), databasePath);
}

function ensureDatabaseDirectory(databasePath) {
  const resolvedPath = resolveDatabasePath(databasePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  return resolvedPath;
}

function openDatabase(databasePath) {
  const resolvedPath = ensureDatabaseDirectory(databasePath);
  const db = new Database(resolvedPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  return db;
}

module.exports = {
  ensureDatabaseDirectory,
  openDatabase,
  resolveDatabasePath
};
