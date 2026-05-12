#!/usr/bin/env node

const { formatSelfCheckResult, runStartupSelfCheck } = require('../src/services/startup-self-check');

try {
  const result = runStartupSelfCheck();
  const output = formatSelfCheckResult(result);

  if (!result.ok) {
    console.error(output);
    process.exit(1);
  }

  if (result.degraded) {
    console.warn(output);
    process.exit(0);
  }

  console.log(output);
} catch (error) {
  console.error(`Startup self-check failed before checks completed: ${error.stack || error.message}`);
  process.exit(1);
}
