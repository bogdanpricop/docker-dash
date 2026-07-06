'use strict';

// v8.9.9-alpha.1 — Dockge G04 closure: filesystem-first stacks discovery.
// Walk DD_STACKS_DIR (default /opt/stacks, comma-separated) and find every
// docker-compose.yml / compose.yml, whether stack is up or down. Merge
// with the running-container list in the routes layer.

const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const log = require('../utils/logger')('stacks-fs');

const DEFAULT_ROOTS = (process.env.DD_STACKS_DIR || '/opt/stacks')
  .split(',').map(s => s.trim()).filter(Boolean);
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
const MAX_DEPTH = 3;

/** Return true if `child` resolves inside any of the roots. */
function _isInsideRoots(child) {
  const c = path.resolve(child);
  return DEFAULT_ROOTS.some(root => {
    const r = path.resolve(root);
    return c === r || c.startsWith(r + path.sep);
  });
}

function _walk(dir, depth, out) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  // Skip if any known compose file is here
  const composeName = entries.find(e => e.isFile() && COMPOSE_FILES.includes(e.name));
  if (composeName) {
    out.push(path.join(dir, composeName.name));
    return; // don't recurse further from within a stack dir
  }
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('node_modules')) {
      _walk(path.join(dir, e.name), depth + 1, out);
    }
  }
}

/** Discover all stack directories on disk. Returns array of stack summaries. */
function discover(roots = DEFAULT_ROOTS) {
  const found = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    _walk(root, 0, found);
  }
  return found.map(composePath => {
    const stackDir = path.dirname(composePath);
    const stackName = path.basename(stackDir);
    let serviceCount = 0;
    let services = [];
    try {
      const doc = yaml.parse(fs.readFileSync(composePath, 'utf8'));
      services = Object.keys((doc && doc.services) || {});
      serviceCount = services.length;
    } catch (err) {
      log.warn('stacks-fs: failed to parse', { composePath, error: err.message });
    }
    return {
      name: stackName,
      path: stackDir,
      composeFile: composePath,
      services,
      serviceCount,
      source: 'filesystem',
    };
  });
}

module.exports = { discover, _isInsideRoots, DEFAULT_ROOTS };
