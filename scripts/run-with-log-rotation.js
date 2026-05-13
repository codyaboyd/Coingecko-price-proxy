#!/usr/bin/env node
const { spawn } = require('child_process');
const { writeLog } = require('../src/services/log-service');

const command = process.argv[2];
const args = process.argv.slice(3);

if (!command) {
  console.error('Usage: node scripts/run-with-log-rotation.js <command> [args...]');
  process.exit(64);
}

function writeChunk(chunk) {
  const text = chunk.toString('utf8');
  text.split(/\r?\n/).forEach((line) => {
    if (line) {
      writeLog('server.log', line);
    }
  });
}

const child = spawn(command, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe']
});

child.stdout.on('data', writeChunk);
child.stderr.on('data', writeChunk);

child.on('error', (error) => {
  const message = `[${new Date().toISOString()}] ERROR Failed to start ${command}: ${error.message}`;
  writeLog('server.log', message);
  writeLog('error.log', message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    writeLog('server.log', `[${new Date().toISOString()}] ${command} exited due to ${signal}`);
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code || 0);
});
