#!/usr/bin/env node
/**
 * build-id.js
 *
 * Computes the cache-busting token for static assets.
 *
 * Why this exists: the release version (src/version.js) is the identity of a
 * published release. It changes only when the maintainer cuts a release. If
 * it were also the ?v= token on every <script>/<link> in index.html, browsers
 * would keep serving stale JS for the whole interval between releases.
 *
 * So the token is derived from the content of the assets themselves: any
 * change to a served file changes the token, and nothing else does.
 *
 * Only the directories actually served with a ?v= token are hashed:
 *   public/js  public/css  public/lib  public/vendor
 *
 * public/index.html is deliberately excluded — it is served
 * Cache-Control: no-cache, is never cached by the browser, and is where the
 * token is injected, so hashing it would be circular.
 *
 * Usage:
 *   const { computeBuildId } = require('./build-id');
 *   computeBuildId(path.join(__dirname, '..', 'public'));  // 'e888beed5acd'
 *
 * Deterministic: the same bytes always produce the same id.
 *
 * This lives in src/ rather than scripts/ because the running server needs
 * it at startup, and the production image copies only src/ and public/.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// The asset directories served with a ?v= cache-busting token.
const ASSET_DIRS = ['js', 'css', 'lib', 'vendor'];

// Short enough to keep URLs tidy, long enough to avoid collisions in
// practice (48 bits).
const ID_LENGTH = 12;

/**
 * Collect the files under the given asset directories, recursively.
 * Missing directories are skipped — a partial install still gets an id.
 *
 * @param {string} publicDir Absolute path to the public/ directory.
 * @returns {string[]} Absolute file paths, sorted for determinism.
 */
function collectAssetFiles(publicDir) {
  const files = [];

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // missing directory — skip
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };

  for (const dir of ASSET_DIRS) walk(path.join(publicDir, dir));

  // Sorting makes the hash independent of directory-read order.
  return files.sort();
}

/**
 * Compute the cache-busting token for the served assets.
 *
 * @param {string} publicDir Absolute path to the public/ directory.
 * @returns {string} 12 hex characters, or 'dev' when nothing is found.
 */
function computeBuildId(publicDir) {
  const files = collectAssetFiles(publicDir);
  if (!files.length) return 'dev';

  const hash = crypto.createHash('sha256');
  for (const file of files) {
    // Hash the path too, so moving a file changes the id even when the
    // contents of the two files are identical.
    hash.update(path.relative(publicDir, file));
    try {
      hash.update(fs.readFileSync(file));
    } catch {
      // Unreadable file (permissions, race with a build) — hash the path
      // alone rather than failing the server start.
    }
  }

  return hash.digest('hex').slice(0, ID_LENGTH);
}

module.exports = { computeBuildId, collectAssetFiles, ASSET_DIRS, ID_LENGTH };
