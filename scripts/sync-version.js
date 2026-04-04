#!/usr/bin/env node
/**
 * sync-version.js
 *
 * Reads version from package.json and propagates it to:
 *   - src/version.js       (read by server.js at startup → injected into index.html)
 *   - docker-compose.yml   (fallback version tag for docker image)
 *
 * Runs automatically via the "version" npm lifecycle hook:
 *   npm version 5.4.0   →  updates package.json + runs this + commits
 *
 * index.html does NOT need touching — server.js replaces __VERSION__ at startup.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const version = pkg.version;

// ── src/version.js ───────────────────────────────────────────
const versionJsPath = path.join(root, 'src', 'version.js');
fs.writeFileSync(versionJsPath,
  `'use strict';\n` +
  `// Single source of truth for the application version.\n` +
  `// Updated automatically by: npm version X.Y.Z  (via scripts/sync-version.js)\n` +
  `// server.js reads this to inject into index.html at startup — no build step needed.\n` +
  `module.exports = '${version}';\n`
);
console.log(`✓ synced version ${version} → src/version.js`);

// ── docker-compose.yml ────────────────────────────────────────
const composePath = path.join(root, 'docker-compose.yml');
const compose = fs.readFileSync(composePath, 'utf8');
const updatedCompose = compose.replace(
  /\$\{APP_VERSION:-[\d.]+\}/g,
  `\${APP_VERSION:-${version}}`
);
fs.writeFileSync(composePath, updatedCompose);
console.log(`✓ synced version ${version} → docker-compose.yml`);
