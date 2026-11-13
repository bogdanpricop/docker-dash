'use strict';

const { spawnSync } = require('node:child_process');

function validate(report, scope = 'All dependencies') {
  const vulnerabilities = report?.vulnerabilities;
  const total = report?.metadata?.vulnerabilities?.total;
  if (report?.error || !vulnerabilities || typeof vulnerabilities !== 'object'
    || Array.isArray(vulnerabilities) || !Number.isSafeInteger(total) || total < 0) {
    throw new Error('Invalid npm audit response');
  }
  const names = Object.keys(vulnerabilities);
  if (total > 0 || names.length) {
    throw new Error(`${scope} must have zero npm advisories (reported: ${names.join(', ') || total})`);
  }
}

function audit(args) {
  const result = spawnSync(process.execPath, [process.env.npm_execpath, 'audit', '--json', ...args], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || ![0, 1].includes(result.status)) throw new Error('npm audit failed to run');
  return JSON.parse(result.stdout);
}

if (require.main === module) {
  try {
    validate(audit(['--omit=dev']), 'Production dependencies');
    validate(audit([]));
    console.log('Production and development: zero npm advisories.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { validate };
