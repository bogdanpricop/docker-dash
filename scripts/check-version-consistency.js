#!/usr/bin/env node
/**
 * check-version-consistency.js
 *
 * The release version is written to five places (package.json,
 * package-lock.json, src/version.js, docker-compose.yml) and reported in the
 * What's New page. Nothing currently checks that they agree — a partial
 * write (for example `npm version` run on a dirty tree, where the lifecycle
 * hook never fires) leaves the tree advertising a version that does not
 * exist.
 *
 * This check asserts every version location carries the same value, and that
 * the newest What's New release matches it. It is the guard that makes the
 * release-scoped versioning scheme safe: the version may only be bumped in a
 * commit that also records the release notes.
 *
 * Run: node scripts/check-version-consistency.js
 * Exits non-zero with a description of every mismatch.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

/**
 * The version each location claims, or null when it cannot be read.
 * @returns {{packageJson: string|null, packageLock: string|null, packageLockRoot: string|null, versionJs: string|null, compose: string[], whatsNew: string|null}}
 */
function collectVersions() {
  const out = {
    packageJson: null,
    packageLock: null,
    packageLockRoot: null,
    versionJs: null,
    compose: [],
    whatsNew: null,
    hasUnreleased: false,
  };

  try {
    out.packageJson = JSON.parse(read('package.json')).version || null;
  } catch { /* unreadable */ }

  try {
    const lock = JSON.parse(read('package-lock.json'));
    out.packageLock = lock.version || null;
    out.packageLockRoot = lock.packages?.['']?.version || null;
  } catch { /* unreadable */ }

  const versionJs = read('src/version.js');
  const match = versionJs.match(/module\.exports\s*=\s*'([^']+)'/);
  out.versionJs = match ? match[1] : null;

  // Every ${APP_VERSION:-X.Y.Z} default in docker-compose.yml.
  const compose = read('docker-compose.yml');
  const seen = new Set();
  const re = /\$\{APP_VERSION:-([^}\s]+)\}/g;
  let m;
  while ((m = re.exec(compose)) !== null) seen.add(m[1]);
  out.compose = [...seen];

  // The newest numbered release in the What's New page.
  const whatsNew = read('public/js/pages/whatsnew.js');
  const release = whatsNew.match(/version:\s*'([^']+)'\s*,\s*date:/);
  out.whatsNew = release ? release[1] : null;

  // Whether the What's New page carries an unreleased list. Under
  // release-scoped versioning a contributor's change lands in _unreleased
  // and the numbered release is created at release time.
  const unreleased = whatsNew.match(/_unreleased:\s*\[([\s\S]*?)\]/);
  out.hasUnreleased = unreleased ? unreleased[1].trim().length > 0 : false;

  return out;
}

/**
 * Check that every location agrees.
 * @returns {string[]} Human-readable problems; empty means consistent.
 */
function checkConsistency() {
  const v = collectVersions();
  const problems = [];

  // The authoritative value: package.json, which npm version writes first.
  const expected = v.packageJson;
  if (!expected) {
    problems.push('package.json has no readable version');
    return problems;
  }

  const compare = (label, actual) => {
    if (actual === null) problems.push(`${label}: could not be read`);
    else if (actual !== expected) problems.push(`${label}: ${actual} (expected ${expected})`);
  };

  compare('package-lock.json (root)', v.packageLock);
  compare('package-lock.json (packages[""])', v.packageLockRoot);
  compare('src/version.js', v.versionJs);

  for (const compose of v.compose) {
    compare('docker-compose.yml APP_VERSION', compose);
  }
  if (!v.compose.length) {
    problems.push('docker-compose.yml: no ${APP_VERSION:-...} default found');
  }

  compare('public/js/pages/whatsnew.js (newest release)', v.whatsNew);

  return problems;
}

if (require.main === module) {
  const problems = checkConsistency();
  if (problems.length) {
    console.error('Version consistency check FAILED:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`Version consistency verified: ${collectVersions().packageJson}`);
}

module.exports = { collectVersions, checkConsistency };
