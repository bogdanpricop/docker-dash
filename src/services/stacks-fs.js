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
  .split(',').map(s => s.trim()).filter(Boolean).map(root => path.resolve(root));
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
const MAX_DEPTH = 3;

/**
 * Resolve existing paths through symlinks. For a not-yet-created target, resolve
 * the nearest existing parent first so `/allowed/link/new-stack` cannot escape
 * through a symlink merely because `new-stack` does not exist yet.
 */
function _canonical(target) {
  const resolved = path.resolve(target);
  let cursor = resolved;
  const missing = [];

  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return resolved;
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }

  try { return path.resolve(fs.realpathSync.native(cursor), ...missing); }
  catch { return resolved; }
}

function _isInsideRoots(child, roots = DEFAULT_ROOTS) {
  const c = _canonical(child);
  return roots.some(root => {
    const r = _canonical(root);
    return c === r || c.startsWith(r + path.sep);
  });
}

function assertInsideRoots(target, roots = DEFAULT_ROOTS) {
  if (!_isInsideRoots(target, roots)) {
    throw Object.assign(new Error('Working directory must be inside DD_STACKS_DIR'), { status: 400 });
  }
  return _canonical(target);
}

function defaultStackDir(name, roots = DEFAULT_ROOTS) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(String(name || ''))) {
    throw Object.assign(new Error('Invalid stack name'), { status: 400 });
  }
  if (!roots.length) throw Object.assign(new Error('DD_STACKS_DIR has no configured roots'), { status: 500 });
  return assertInsideRoots(path.join(roots[0], name), roots);
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
    // Never follow symlinks/junctions. A stack root can be a configured
    // symlink, but discovery cannot escape from it through a nested link.
    if (e.isDirectory() && !e.isSymbolicLink()
      && !e.name.startsWith('.') && e.name !== 'node_modules') {
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
  const unique = [...new Set(found.map(composePath => _canonical(composePath)))];
  return unique.filter(composePath => _isInsideRoots(composePath, roots)).map(composePath => {
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

function findByName(name, roots = DEFAULT_ROOTS) {
  return discover(roots).find(stack => stack.name === name) || null;
}

module.exports = {
  discover, findByName, assertInsideRoots, defaultStackDir,
  _canonical, _isInsideRoots, DEFAULT_ROOTS, COMPOSE_FILES, MAX_DEPTH,
};
