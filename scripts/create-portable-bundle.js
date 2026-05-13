#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const BUNDLE_PREFIX = 'chrono-cache-bundle';
const TIMESTAMP_PATTERN = /^history-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.sqlite$/;

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatTimestamp(date = new Date()) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('-') + `-${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function removePath(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function copyFile(source, destination) {
  ensureDirectory(path.dirname(destination));
  fs.copyFileSync(source, destination);
}

function copyDirectory(source, destination, options = {}) {
  if (!fs.existsSync(source)) {
    return false;
  }

  const entries = fs.readdirSync(source, { withFileTypes: true });
  ensureDirectory(destination);

  entries.forEach((entry) => {
    if (options.excludeNames && options.excludeNames.has(entry.name)) {
      return;
    }

    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(sourcePath, destinationPath, options);
      return;
    }

    if (entry.isFile()) {
      copyFile(sourcePath, destinationPath);
    }
  });

  return true;
}

function copyIfExists(rootDir, relativePath, bundleRoot) {
  const source = path.join(rootDir, relativePath);

  if (!fs.existsSync(source)) {
    return false;
  }

  const stats = fs.statSync(source);
  const destination = path.join(bundleRoot, relativePath);

  if (stats.isDirectory()) {
    return copyDirectory(source, destination);
  }

  if (stats.isFile()) {
    copyFile(source, destination);
    return true;
  }

  return false;
}

function findLatestBackup(rootDir) {
  const backupDir = path.join(rootDir, 'data', 'backups');

  if (!fs.existsSync(backupDir)) {
    return null;
  }

  return fs.readdirSync(backupDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && TIMESTAMP_PATTERN.test(entry.name))
    .map((entry) => path.join(backupDir, entry.name))
    .sort((left, right) => path.basename(right).localeCompare(path.basename(left)))[0] || null;
}

function copyDatabase(rootDir, bundleRoot) {
  const databasePath = path.join(rootDir, 'data', 'history.sqlite');
  const destinationPath = path.join(bundleRoot, 'data', 'history.sqlite');

  if (fs.existsSync(databasePath)) {
    copyFile(databasePath, destinationPath);
    return { source: 'data/history.sqlite', bundledAs: 'data/history.sqlite' };
  }

  const latestBackup = findLatestBackup(rootDir);

  if (!latestBackup) {
    throw new Error('No data/history.sqlite file or data/backups/history-*.sqlite backup was found to include in the bundle.');
  }

  copyFile(latestBackup, destinationPath);
  return {
    source: toPosixPath(path.relative(rootDir, latestBackup)),
    bundledAs: 'data/history.sqlite'
  };
}

function writeMigrationReadme(bundleRoot, metadata) {
  const content = `# Chrono Cache portable bundle\n\nThis portable bundle was created for moving Chrono Cache to a new server.\n\n## Restore on the new server\n\n1. Extract the bundle:\n\n   \`\`\`bash\n   tar -xzf ${metadata.archiveName}\n   cd ${metadata.bundleDirectoryName}\n   \`\`\`\n\n2. Copy your real environment file into place:\n\n   \`\`\`bash\n   cp /secure/path/to/.env .env\n   \`\`\`\n\n   The real \`.env\` is excluded by default. Create the bundle with \`EXPORT_ENV=1 npm run bundle\` only if you intentionally want to include it.\n\n3. Start the app:\n\n   \`\`\`bash\n   ./start.sh\n   \`\`\`\n\nThe bundle includes application files, config, package manifests, startup scripts, README.md, and a SQLite database copied from \`${metadata.database.source}\` as \`${metadata.database.bundledAs}\`.\n`;

  fs.writeFileSync(path.join(bundleRoot, 'PORTABLE-RESTORE.md'), content);
}

function createPortableBundle(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const env = options.env || process.env;
  const timestamp = options.timestamp || formatTimestamp(options.now || new Date());
  const bundleDirectoryName = `${BUNDLE_PREFIX}-${timestamp}`;
  const archiveName = `${bundleDirectoryName}.tar.gz`;
  const exportsDir = path.join(rootDir, 'data', 'exports');
  const archivePath = path.join(exportsDir, archiveName);
  const stagingParent = fs.mkdtempSync(path.join(os.tmpdir(), `${BUNDLE_PREFIX}-`));
  const bundleRoot = path.join(stagingParent, bundleDirectoryName);

  ensureDirectory(exportsDir);
  ensureDirectory(bundleRoot);

  try {
    ['config', 'src', 'views', 'public'].forEach((directory) => {
      copyIfExists(rootDir, directory, bundleRoot);
    });

    copyDirectory(path.join(rootDir, 'scripts'), path.join(bundleRoot, 'scripts'), {
      excludeNames: new Set(['node_modules'])
    });

    ['package.json', 'package-lock.json', 'server.js', 'start.sh', 'stop.sh', 'restart.sh', 'README.md'].forEach((file) => {
      copyIfExists(rootDir, file, bundleRoot);
    });

    if (env.EXPORT_ENV === '1') {
      copyIfExists(rootDir, '.env', bundleRoot);
    }

    copyIfExists(rootDir, '.env.example', bundleRoot);

    const database = copyDatabase(rootDir, bundleRoot);
    writeMigrationReadme(bundleRoot, { archiveName, bundleDirectoryName, database });

    removePath(archivePath);
    execFileSync('tar', ['-czf', archivePath, '-C', stagingParent, bundleDirectoryName], { stdio: 'pipe' });

    const stats = fs.statSync(archivePath);
    return {
      archivePath,
      relativeArchivePath: toPosixPath(path.relative(rootDir, archivePath)),
      archiveName,
      bundleDirectoryName,
      sizeBytes: stats.size,
      database
    };
  } finally {
    removePath(stagingParent);
  }
}

if (require.main === module) {
  try {
    const result = createPortableBundle();
    console.log(`Portable bundle created: ${result.relativeArchivePath}`);
    console.log(`Database source: ${result.database.source}`);
  } catch (error) {
    console.error(`Failed to create portable bundle: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { createPortableBundle };
