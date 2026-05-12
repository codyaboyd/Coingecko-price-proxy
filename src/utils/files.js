const fs = require('fs');
const path = require('path');

function resolveFromRoot(filePath) {
  return path.resolve(process.cwd(), filePath);
}

function readJsonFile(filePath) {
  const resolvedPath = resolveFromRoot(filePath);

  try {
    const raw = fs.readFileSync(resolvedPath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`JSON config file not found: ${resolvedPath}`);
    }

    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${resolvedPath}: ${error.message}`);
    }

    throw new Error(`Unable to read JSON file ${resolvedPath}: ${error.message}`);
  }
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(resolveFromRoot(dirPath), { recursive: true });
}

module.exports = { ensureDirectory, readJsonFile, resolveFromRoot };
