const fs = require('fs');
const path = require('path');

function resolveFromRoot(filePath) {
  return path.resolve(process.cwd(), filePath);
}

function readJsonFile(filePath) {
  const resolvedPath = resolveFromRoot(filePath);
  const raw = fs.readFileSync(resolvedPath, 'utf8');
  return JSON.parse(raw);
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(resolveFromRoot(dirPath), { recursive: true });
}

module.exports = { ensureDirectory, readJsonFile, resolveFromRoot };
