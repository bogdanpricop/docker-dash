'use strict';

// v8.9.9-alpha.1 — Portainer G07 closure: volume file browser.
// Launches an ephemeral alpine container with the volume mounted to run
// small helper commands (ls/cat/rm/tar). Path traversal blocked — every
// path is canonicalized to stay under /data (the mount point inside the
// helper container).
//
// SECURITY REVIEW: any admin who reaches these routes can read any file
// inside any volume. That's equivalent to what `docker exec` already
// grants them, but this makes it click-through — documented in
// SECURITY.md "Known tradeoffs".

const path = require('path');
const dockerService = require('./docker');
const log = require('../utils/logger')('volume-browser');

const HELPER_IMAGE = 'alpine:3';
const HELPER_TIMEOUT_MS = 30_000;
const MAX_LIST_ENTRIES = 5000;

/** Resolve a user-supplied path to something safely under /data. */
function _safePath(userPath) {
  const p = userPath || '/';
  const resolved = path.posix.resolve('/data', '.' + (p.startsWith('/') ? p : '/' + p));
  if (!resolved.startsWith('/data')) throw new Error('Path traversal blocked');
  return resolved;
}

async function _runHelper(hostId, volumeName, cmd, { readOnly = true } = {}) {
  const container = await dockerService.getDocker(hostId).createContainer({
    Image: HELPER_IMAGE,
    Cmd: cmd,
    HostConfig: {
      AutoRemove: true,
      Binds: [`${volumeName}:/data${readOnly ? ':ro' : ''}`],
      NetworkMode: 'none',
    },
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await container.attach({ stream: true, stdout: true, stderr: true });
  await container.start();
  const chunks = [];
  const timer = setTimeout(() => container.kill().catch(() => {}), HELPER_TIMEOUT_MS);
  await new Promise((resolve, reject) => {
    stream.on('data', c => chunks.push(c));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  clearTimeout(timer);
  return Buffer.concat(chunks).toString('utf8');
}

/** List directory entries under `dirPath` inside the volume. */
async function list(hostId, volumeName, dirPath) {
  const safe = _safePath(dirPath);
  // Use `ls -laF --time-style=+%s` for stable output.
  const out = await _runHelper(hostId, volumeName,
    ['sh', '-c', `ls -laF --time-style=+%s ${safe} 2>&1 | head -n ${MAX_LIST_ENTRIES}`]);
  const entries = [];
  const lines = out.split('\n').slice(1); // skip 'total X' line
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 7) continue;
    const [perm, , owner, group, size, ts, ...rest] = parts;
    let name = rest.join(' ');
    let type = 'file';
    if (perm.startsWith('d')) type = 'dir';
    else if (perm.startsWith('l')) { type = 'symlink'; name = name.split(' -> ')[0]; }
    // strip trailing ls -F markers
    name = name.replace(/[*/=@|]$/, '');
    if (name === '.' || name === '..') continue;
    entries.push({ name, type, perm, owner, group, size: Number(size), mtime: Number(ts) });
  }
  return { path: safe.replace(/^\/data/, '') || '/', entries };
}

/** Delete a file or directory inside the volume. */
async function remove(hostId, volumeName, filePath) {
  const safe = _safePath(filePath);
  if (safe === '/data') throw new Error('Cannot delete root');
  const out = await _runHelper(hostId, volumeName,
    ['sh', '-c', `rm -rf ${safe} && echo OK`], { readOnly: false });
  if (!out.trim().endsWith('OK')) {
    log.warn('volume-browser: delete may have failed', { out });
  }
}

/**
 * Read a file's contents (bounded to maxBytes). Returns { encoding, content } —
 * text/utf-8 if the buffer parses as UTF-8, else base64.
 */
async function readFile(hostId, volumeName, filePath, maxBytes = 5_000_000) {
  const safe = _safePath(filePath);
  const raw = await _runHelper(hostId, volumeName,
    ['sh', '-c', `head -c ${maxBytes} ${safe}`]);
  // Detect if content is likely binary — look for null bytes.
  if (raw.includes('\0')) {
    return { encoding: 'base64', content: Buffer.from(raw, 'binary').toString('base64') };
  }
  return { encoding: 'utf8', content: raw };
}

module.exports = { list, remove, readFile, _safePath };
