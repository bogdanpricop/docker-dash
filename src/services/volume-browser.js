'use strict';

const path = require('node:path');
const { once } = require('node:events');
const { PassThrough } = require('node:stream');
const { TextDecoder } = require('node:util');
const dockerService = require('./docker');
const { applicationImage } = require('./docker-helper-image');

const MAX_LIST_ENTRIES = 5000;
const MAX_FILE_BYTES = 5_000_000;
const contained = 'case "$target" in /data|/data/*) ;; *) exit 3 ;; esac';
const resolveTarget = 'target=$(realpath "$1") || exit 3; ' + contained;
const listScript = resolveTarget + `
[ -d "$target" ] || exit 4
remaining=$2
for entry in "$target"/* "$target"/.[!.]* "$target"/..?*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  if [ "$remaining" -eq 0 ]; then printf 'more\\0'; break; fi
  meta=$(stat -c '%f %s %Y' -- "$entry") || continue
  printf '%s\\0%s\\0' "$meta" "\${entry##*/}"
  remaining=$((remaining - 1))
done`;
const readScript = resolveTarget + '; [ -f "$target" ] || exit 4; exec head -c "$2" -- "$target"';
const removeScript = 'target=$(realpath "${1%/*}") || exit 3; ' + contained + '; exec rm -rf -- "$target/${1##*/}"';

function _safePath(userPath) {
  const input = userPath ?? '/';
  if (typeof input !== 'string' || input.length > 4096 || input.includes('\0') || input.split('/').includes('..')) {
    throw new Error('Path traversal blocked');
  }
  return path.posix.join('/data', input).replace(/\/+$/, '');
}

async function helperImage(docker) {
  if (process.env.DD_VOLUME_BROWSER_IMAGE) return process.env.DD_VOLUME_BROWSER_IMAGE;
  const image = await applicationImage(docker);
  if (image) return image;
  try { return (await docker.getImage('alpine:3').inspect()).Id; }
  catch (error) {
    if (error.statusCode !== 404) throw error;
    throw new Error('No local file browser image is available on this Docker host');
  }
}

async function runHelper(hostId, volumeName, script, args, { readOnly = true, maxBytes = MAX_FILE_BYTES + 1 } = {}) {
  const docker = dockerService.getDocker(hostId);
  await docker.getVolume(volumeName).inspect();
  const container = await docker.createContainer({
    Image: await helperImage(docker),
    Entrypoint: ['/bin/sh'],
    Cmd: ['-c', script, '--', ...args],
    User: '0:0',
    Labels: { 'com.docker-dash.volume-browser': 'true' },
    HostConfig: {
      Mounts: [{ Type: 'volume', Source: volumeName, Target: '/data', ReadOnly: readOnly, VolumeOptions: { NoCopy: true } }],
      NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], CapAdd: ['DAC_OVERRIDE'],
      SecurityOpt: ['no-new-privileges'], PidsLimit: 32, Memory: 64 * 1024 * 1024,
    },
    Healthcheck: { Test: ['NONE'] },
    AttachStdout: true,
    AttachStderr: true,
  });
  let stream;
  let timer;
  try {
    stream = await container.attach({ stream: true, stdout: true, stderr: true });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const chunks = [];
    let received = 0;
    let diagnostic = '';
    stdout.on('data', chunk => {
      if (received < maxBytes) chunks.push(chunk.subarray(0, maxBytes - received));
      received += chunk.length;
    });
    stderr.on('data', chunk => { if (diagnostic.length < 1024) diagnostic += chunk.toString('utf8'); });
    const ended = once(stream, 'end');
    ended.catch(() => {});
    docker.modem.demuxStream(stream, stdout, stderr);
    await container.start();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Volume file operation timed out')), 30_000);
    });
    const [result] = await Promise.race([Promise.all([container.wait(), ended]), timeout]);
    if (result.StatusCode === 3) throw new Error('The path does not resolve inside this volume');
    if (result.StatusCode === 4) throw new Error('The requested path has the wrong file type');
    if (result.StatusCode !== 0) throw new Error(diagnostic.trim().slice(0, 1024) || 'Volume file operation failed');
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
    stream?.destroy();
    await container.remove({ force: true }).catch(() => {});
  }
}

async function list(hostId, volumeName, dirPath) {
  const safe = _safePath(dirPath);
  const data = await runHelper(hostId, volumeName, listScript, [safe, String(MAX_LIST_ENTRIES)]);
  const fields = data.toString('utf8').split('\0');
  const entries = [];
  let truncated = data.length > MAX_FILE_BYTES;
  for (let index = 0; index + 1 < fields.length; index += 2) {
    if (fields[index] === 'more') { truncated = true; break; }
    const [rawMode, size, mtime] = fields[index].split(' ');
    const mode = parseInt(rawMode, 16) & 0xf000;
    const type = { 0x4000: 'dir', 0xa000: 'symlink', 0x8000: 'file' }[mode] || 'other';
    if (fields[index + 1]) entries.push({ name: fields[index + 1], type, size: Number(size), mtime: Number(mtime) });
  }
  return { path: safe.slice('/data'.length) || '/', entries, truncated };
}

async function remove(hostId, volumeName, filePath) {
  const safe = _safePath(filePath);
  if (safe === '/data') throw new Error('Cannot delete root');
  await runHelper(hostId, volumeName, removeScript, [safe], { readOnly: false });
}

async function readBuffer(hostId, volumeName, filePath, maxBytes = MAX_FILE_BYTES) {
  return runHelper(hostId, volumeName, readScript, [_safePath(filePath), String(maxBytes + 1)], { maxBytes: maxBytes + 1 });
}

async function readFile(hostId, volumeName, filePath, maxBytes = MAX_FILE_BYTES) {
  const data = await readBuffer(hostId, volumeName, filePath, maxBytes);
  const truncated = data.length > maxBytes;
  const bytes = data.subarray(0, maxBytes);
  try {
    if (bytes.includes(0)) throw new Error('binary');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { encoding: 'utf8', content, truncated };
  } catch {
    return { encoding: 'base64', content: bytes.toString('base64'), truncated };
  }
}

module.exports = { list, remove, readFile, readBuffer, helperImage, MAX_FILE_BYTES, _safePath };
