'use strict';

const { spawnSync } = require('node:child_process');

// No upstream patch exists for GHSA-gcqx-w48m-w2h4. Permit only this
// development-only Jest dependency until the next review; production stays strict.
function validate(report, now = new Date()) {
  if (!report.metadata || report.error) throw new Error('Invalid npm audit response');
  const vulnerabilities = report.vulnerabilities || {};
  const allowed = new Set(['deepmerge', 'jest-config', 'jest-cli', '@jest/core', 'jest']);
  for (const [name, issue] of Object.entries(vulnerabilities)) {
    if (now >= new Date('2026-12-02T00:00:00Z') || !allowed.has(name) || issue.severity !== 'low') {
      throw new Error(`Unreviewed npm vulnerability: ${name}`);
    }
    for (const via of issue.via) {
      if (typeof via === 'string' ? !allowed.has(via)
        : via.url !== 'https://github.com/advisories/GHSA-gcqx-w48m-w2h4' || via.name !== 'deepmerge') {
        throw new Error(`Unreviewed advisory affecting ${name}`);
      }
    }
  }
  return Object.keys(vulnerabilities).length;
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
    const production = audit(['--omit=dev']);
    if (production.error || !production.metadata || Object.keys(production.vulnerabilities || {}).length) {
      throw new Error('Production dependencies must have zero npm advisories');
    }
    const count = validate(audit([]));
    console.log(`Production: zero advisories. Development: ${count} low entries for unpatched deepmerge/Jest (review expires 2026-12-02).`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { validate };
