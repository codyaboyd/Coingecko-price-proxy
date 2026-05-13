#!/usr/bin/env node

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const WARNING = 'warning';
const CRITICAL = 'critical';
const OK = 'ok';
const OPTIONAL_BUN_MESSAGE = 'Bun is optional; Node.js remains the supported default runtime.';

const REQUIRED_PACKAGE_SCRIPTS = [
  'start',
  'migrate',
  'validate-assets',
  'test',
  'smoke',
  'self-check',
  'check-runtime'
];

const REQUIRED_DIRECTORIES = [
  'config',
  'public',
  'scripts',
  'src',
  'views'
];

function resolveProjectPath(projectRoot, relativePath) {
  return path.resolve(projectRoot, relativePath);
}

function readPackageJson(projectRoot) {
  const packagePath = resolveProjectPath(projectRoot, 'package.json');
  const raw = fs.readFileSync(packagePath, 'utf8');
  return JSON.parse(raw);
}

function createCheck(id, label, status, summary, details = null) {
  return { id, label, status, ok: status === OK, summary, details };
}

function commandExists(command) {
  const result = childProcess.spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function getCommandVersion(command, args) {
  const result = childProcess.spawnSync(command, args, { encoding: 'utf8' });

  if (result.error || result.status !== 0) {
    return null;
  }

  return (result.stdout || result.stderr || '').trim().split(/\r?\n/)[0] || null;
}

function parseMajor(version) {
  const match = String(version || '').match(/v?(\d+)/);
  return match ? Number(match[1]) : null;
}

function getMinimumNodeMajor(engineRange) {
  const match = String(engineRange || '').match(/>=\s*(\d+)/);
  return match ? Number(match[1]) : 20;
}

function checkNodeVersion(packageJson) {
  const requiredMajor = getMinimumNodeMajor(packageJson.engines && packageJson.engines.node);
  const version = process.versions.node;
  const major = parseMajor(version);
  const ok = major !== null && major >= requiredMajor;

  return createCheck(
    'node_version',
    'Node version',
    ok ? OK : WARNING,
    ok ? `Node ${version} satisfies >=${requiredMajor}` : `Unsupported Node ${version}; expected >=${requiredMajor}`,
    { version, major, required: packageJson.engines && packageJson.engines.node ? packageJson.engines.node : `>=${requiredMajor}` }
  );
}

function checkBunVersion() {
  const bunPath = commandExists('bun');

  if (!bunPath) {
    return createCheck('bun_version', 'Bun version', WARNING, 'Bun is not installed', {
      optional: true,
      message: OPTIONAL_BUN_MESSAGE
    });
  }

  const version = getCommandVersion('bun', ['--version']);
  return createCheck('bun_version', 'Bun version', OK, version ? `Bun ${version}` : 'Bun is installed', {
    path: bunPath,
    version,
    optional: true
  });
}

function checkNpmVersion() {
  const npmPath = commandExists('npm');

  if (!npmPath) {
    return createCheck('npm_version', 'npm version', CRITICAL, 'npm is not installed', null);
  }

  const version = getCommandVersion('npm', ['--version']);
  return createCheck('npm_version', 'npm version', version ? OK : CRITICAL, version ? `npm ${version}` : 'npm version unavailable', {
    path: npmPath,
    version
  });
}

function checkScreenInstalled() {
  const screenPath = commandExists('screen');

  return createCheck(
    'screen_installed',
    'screen installed',
    screenPath ? OK : WARNING,
    screenPath ? `screen found at ${screenPath}` : 'screen is not installed',
    screenPath ? { path: screenPath } : { installHint: 'Install GNU screen to use ./start.sh managed sessions.' }
  );
}

function checkSqliteDependencyLoads(projectRoot) {
  const result = childProcess.spawnSync(process.execPath, ['-e', "require('better-sqlite3'); console.log('loaded')"], {
    cwd: projectRoot,
    encoding: 'utf8'
  });

  if (result.status === 0) {
    return createCheck('sqlite_dependency_loads', 'SQLite dependency loads', OK, 'better-sqlite3 loaded', {
      module: 'better-sqlite3'
    });
  }

  const output = `${result.stderr || ''}${result.stdout || ''}`.trim();
  return createCheck('sqlite_dependency_loads', 'SQLite dependency loads', CRITICAL, 'better-sqlite3 failed to load', {
    module: 'better-sqlite3',
    error: result.error ? result.error.message : output
  });
}

function checkPackageScripts(packageJson) {
  const scripts = packageJson.scripts || {};
  const missing = REQUIRED_PACKAGE_SCRIPTS.filter((scriptName) => !scripts[scriptName]);

  return createCheck(
    'required_package_scripts',
    'Required package scripts',
    missing.length === 0 ? OK : CRITICAL,
    missing.length === 0 ? `${REQUIRED_PACKAGE_SCRIPTS.length} required script(s) found` : `Missing scripts: ${missing.join(', ')}`,
    { required: REQUIRED_PACKAGE_SCRIPTS, missing }
  );
}

function checkRequiredDirectories(projectRoot) {
  const directories = REQUIRED_DIRECTORIES.map((directory) => {
    const absolutePath = resolveProjectPath(projectRoot, directory);
    return {
      path: directory,
      exists: fs.existsSync(absolutePath),
      isDirectory: fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory()
    };
  });
  const missing = directories.filter((directory) => !directory.exists || !directory.isDirectory);

  return createCheck(
    'required_directories',
    'Required directories',
    missing.length === 0 ? OK : CRITICAL,
    missing.length === 0 ? `${directories.length} required director${directories.length === 1 ? 'y' : 'ies'} found` : `Missing directories: ${missing.map((directory) => directory.path).join(', ')}`,
    { required: REQUIRED_DIRECTORIES, directories, missing }
  );
}

function checkPackageLock(projectRoot) {
  const exists = fs.existsSync(resolveProjectPath(projectRoot, 'package-lock.json'));
  return createCheck(
    'package_lock_present',
    'package-lock present',
    exists ? OK : WARNING,
    exists ? 'package-lock.json found' : 'package-lock.json is missing',
    { path: 'package-lock.json' }
  );
}

function checkNodeModules(projectRoot) {
  const nodeModulesPath = resolveProjectPath(projectRoot, 'node_modules');
  const exists = fs.existsSync(nodeModulesPath) && fs.statSync(nodeModulesPath).isDirectory();
  return createCheck(
    'node_modules_present',
    'node_modules present',
    exists ? OK : WARNING,
    exists ? 'node_modules found' : 'node_modules is missing',
    { path: 'node_modules', installHint: 'Run npm install without auto-upgrading dependencies.' }
  );
}

function summarize(checks) {
  const summary = { ok: 0, warning: 0, critical: 0 };
  checks.forEach((check) => {
    summary[check.status] += 1;
  });
  return summary;
}

function buildRuntimeCompatibility(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const packageJson = readPackageJson(projectRoot);
  const checks = [
    checkNodeVersion(packageJson),
    checkBunVersion(),
    checkNpmVersion(),
    checkScreenInstalled(),
    checkSqliteDependencyLoads(projectRoot),
    checkPackageScripts(packageJson),
    checkRequiredDirectories(projectRoot),
    checkPackageLock(projectRoot),
    checkNodeModules(projectRoot)
  ];
  const summary = summarize(checks);
  const status = summary.critical > 0 ? CRITICAL : (summary.warning > 0 ? WARNING : OK);

  return {
    ok: status !== CRITICAL,
    status,
    projectRoot,
    generatedAt: Date.now(),
    generatedAtIso: new Date().toISOString(),
    summary,
    checks
  };
}

function formatRuntimeCompatibility(result) {
  const lines = [
    `Runtime compatibility: ${result.status}`,
    `Project root: ${result.projectRoot}`,
    `Generated: ${result.generatedAtIso}`,
    `Summary: ${result.summary.ok} ok, ${result.summary.warning} warning, ${result.summary.critical} critical`,
    ''
  ];

  result.checks.forEach((check) => {
    const icon = check.status === OK ? 'OK' : (check.status === WARNING ? 'WARN' : 'FAIL');
    lines.push(`[${icon}] ${check.label}: ${check.summary}`);
  });

  return lines.join('\n');
}

function main() {
  const json = process.argv.includes('--json');
  let result;

  try {
    result = buildRuntimeCompatibility();
  } catch (error) {
    console.error(`Runtime compatibility check failed before checks completed: ${error.stack || error.message}`);
    process.exit(1);
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const output = formatRuntimeCompatibility(result);
    if (result.status === OK) {
      console.log(output);
    } else if (result.status === WARNING) {
      console.warn(output);
    } else {
      console.error(output);
    }
  }

  process.exit(result.status === CRITICAL ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildRuntimeCompatibility,
  formatRuntimeCompatibility,
  REQUIRED_DIRECTORIES,
  REQUIRED_PACKAGE_SCRIPTS
};
