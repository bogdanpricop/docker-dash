'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const tar = require('tar-stream');
const config = require('../config');
const { getDb } = require('../db');
const { encrypt, decrypt, generateToken } = require('../utils/crypto');
const dockerService = require('./docker');
const { helperImage } = require('./volume-browser');

const maxBytes = 2 * 1024 ** 3;
const maxTotalBytes = 8 * 1024 ** 3;
const maxArchives = 100;
const maxEntries = 100_000;
const timeout = 10 * 60_000;
const archiveLabel = 'com.docker-dash.storage-restore-operation';
const idPattern = /^[a-f0-9]{32}$/;
const volumePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}$/;
let active = false;

function failure(message, status = 422) {
  return Object.assign(new Error(message), { status });
}

function archiveRoot() {
  return path.join(path.dirname(config.db.path), 'storage-backups');
}

function archivePath(id) {
  if (!idPattern.test(id)) throw failure('Invalid backup ID', 400);
  return path.join(archiveRoot(), id + '.enc');
}

async function exclusive(operation) {
  if (active) throw failure('A storage backup or restore is already running', 409);
  active = true;
  try { return await operation(); }
  finally { active = false; }
}

function archiveLimit() {
  let size = 0;
  return new Transform({
    transform(chunk, _, callback) {
      size += chunk.length;
      if (size > maxBytes) return callback(failure('The archive exceeds the 2 GiB storage backup limit', 413));
      callback(null, chunk);
    },
  });
}

function cleanArchivePath(name) {
  if (typeof name !== 'string' || name.startsWith('/') || name.includes('\\')
    || name.length > 4096 || /[\x00-\x1f]/.test(name) || name.split('/').includes('..')) {
    throw failure('The archive contains an unsafe file path or link');
  }
  return path.posix.normalize(name).replace(/\/$/, '');
}

// Docker supplies a tar rooted at /source. Repack it so the restore receives
// only checked relative paths, regular file metadata and contained links.
function normalizeArchive(fileName) {
  const unpack = tar.extract();
  const pack = tar.pack();
  const entries = new Map();
  let rootType;
  function relative(name, isFile = false) {
    const clean = cleanArchivePath(name);
    if (clean === 'source') return isFile ? cleanArchivePath(fileName) : '.';
    if (!clean.startsWith('source/') || rootType !== 'directory') throw failure('Unexpected archive layout');
    return clean.slice('source/'.length);
  }
  unpack.on('entry', (header, stream, next) => {
    stream.on('error', error => unpack.destroy(error));
    try {
      if (!rootType) {
        if (cleanArchivePath(header.name) !== 'source' || !['file', 'directory'].includes(header.type)) {
          throw failure('The mount must be a directory or regular file');
        }
        rootType = header.type;
      }
      const name = relative(header.name, rootType === 'file');
      if (entries.size >= maxEntries || entries.has(name)) throw failure('The archive has too many entries or duplicate paths');
      if (name !== '.') {
        let parent = path.posix.dirname(name);
        while (parent !== '.') {
          if (entries.get(parent) !== 'directory') throw failure('The archive contains a file outside its recorded directories');
          parent = path.posix.dirname(parent);
        }
      }
      let linkname;
      switch (header.type) {
        case 'directory':
        case 'file':
          break;
        case 'symlink':
          linkname = cleanArchivePath(header.linkname);
          if (!linkname || linkname === '.') throw failure('The archive contains an unsupported symbolic link');
          break;
        case 'link':
          linkname = relative(header.linkname);
          if (!['file', 'link'].includes(entries.get(linkname))) throw failure('The archive contains an unsupported hard link');
          break;
        default:
          throw failure('The archive contains a special file that cannot be restored safely');
      }
      entries.set(name, header.type);
      const entry = pack.entry({
        name, type: header.type, size: header.size, linkname, uid: header.uid, gid: header.gid,
        mode: header.mode & 0o1777, mtime: header.mtime,
      }, next);
      entry.once('error', error => unpack.destroy(error));
      stream.pipe(entry);
    } catch (error) { unpack.destroy(error); }
  });
  unpack.once('finish', () => {
    if (rootType) pack.finalize();
    else pack.destroy(failure('Docker returned an empty archive'));
  });
  unpack.once('error', error => pack.destroy(error));
  pack.once('error', error => unpack.destroy(error));
  return { unpack, pack };
}

function bindSourceAllowed(source) {
  return /^\/(?:home\/[^/]+\/|root\/|opt\/|srv\/|source\/|tmp\/|mnt\/|media\/|data\/|var\/(?:www|opt|local|log)\/)[^/]/.test(source)
    && path.posix.normalize(source) === source && !/\.sock(?:\/|$)/i.test(source);
}

async function sourceMount(docker, input) {
  if (input?.type === 'volume' && typeof input.name === 'string' && volumePattern.test(input.name)) {
    await docker.getVolume(input.name).inspect();
    return { name: input.name, mount: { Type: 'volume', Source: input.name, VolumeOptions: { NoCopy: true } } };
  }
  if (input?.type === 'bind' && typeof input.containerId === 'string' && /^[0-9a-f]{12,64}$/.test(input.containerId)) {
    const container = await docker.getContainer(input.containerId).inspect();
    const bind = container.Mounts?.find(mount => mount.Type === 'bind' && mount.Destination === input.destination);
    if (!bind || !bindSourceAllowed(bind.Source)) throw failure('Select an existing bind mount in an eligible data directory');
    return { name: (container.Name || container.Id).replace(/^\//, '') + ':' + bind.Destination,
      mount: { Type: 'bind', Source: bind.Source, BindOptions: { NonRecursive: true } } };
  }
  throw failure('Select a volume or a container bind mount', 400);
}

async function withHelper(docker, mount, operation) {
  const container = await docker.createContainer({
    Image: await helperImage(docker), Entrypoint: ['/bin/true'], Cmd: [],
    Labels: { 'com.docker-dash.storage-backup-helper': 'true' }, Healthcheck: { Test: ['NONE'] },
    HostConfig: {
      Mounts: [mount], NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'], PidsLimit: 16, Memory: 64 * 1024 ** 2,
    },
  });
  try { return await operation(container); }
  finally { await container.remove({ force: true }).catch(() => {}); }
}

function list() {
  return getDb().prepare(`SELECT id, host_id, host_name, source_type, source_name, archive_bytes, created_at
    FROM storage_backups ORDER BY created_at DESC, id`).all();
}

async function create(host, input) {
  return exclusive(async () => {
    const db = getDb();
    const quota = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(archive_bytes), 0) AS bytes FROM storage_backups').get();
    if (quota.count >= maxArchives || quota.bytes >= maxTotalBytes) throw failure('Storage backup quota reached', 413);
    const docker = dockerService.getDocker(host.id);
    const source = await sourceMount(docker, input);
    const id = generateToken(16);
    const final = archivePath(id);
    const partial = final + '.partial';
    const iv = crypto.randomBytes(12);
    const key = crypto.randomBytes(32);
    const wrapped = encrypt(key.toString('hex'));
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(id));
    await fsp.mkdir(archiveRoot(), { mode: 0o700, recursive: true });
    let committed = false;
    try {
      await withHelper(docker, { ...source.mount, Target: '/source', ReadOnly: true }, async container => {
        const signal = AbortSignal.timeout(timeout);
        const archive = await container.getArchive({ path: '/source', abortSignal: signal });
        const { unpack, pack } = normalizeArchive(path.posix.basename(source.mount.Source));
        await Promise.all([
          pipeline(archive, archiveLimit(), unpack, { signal }),
          pipeline(pack, archiveLimit(), cipher, fs.createWriteStream(partial, { mode: 0o600, flags: 'wx' }), { signal }),
        ]);
      });
      const { size } = await fsp.stat(partial);
      if (quota.bytes + size > maxTotalBytes) throw failure('Storage backup quota reached', 413);
      await fsp.rename(partial, final);
      db.prepare(`INSERT INTO storage_backups
        (id, host_id, host_name, source_type, source_name, archive_bytes, wrapped_key, iv, tag)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, host.id, host.name || 'Local Docker', input.type, source.name, size,
        wrapped, iv.toString('hex'), cipher.getAuthTag().toString('hex')
      );
      committed = true;
      return list().find(item => item.id === id);
    } finally {
      if (!committed) await Promise.all([fsp.rm(partial, { force: true }), fsp.rm(final, { force: true })]);
    }
  });
}

function record(id) {
  archivePath(id);
  const row = getDb().prepare('SELECT * FROM storage_backups WHERE id = ?').get(id);
  if (!row) throw failure('Storage backup not found', 404);
  return row;
}

async function assertAvailable(docker, name) {
  try { await docker.getVolume(name).inspect(); }
  catch (error) { if (error.statusCode === 404) return; throw error; }
  throw failure('A volume with this name already exists on the destination host', 409);
}

async function plan(id, host, name) {
  if (typeof name !== 'string' || !volumePattern.test(name)) throw failure('Enter a valid name for a new Docker volume', 400);
  const row = record(id);
  await assertAvailable(dockerService.getDocker(host.id), name);
  const review = { backupId: id, sourceHost: row.host_name, source: row.source_name,
    archiveBytes: row.archive_bytes, destinationHost: host.name || 'Local Docker', targetHostId: host.id, volume: name };
  const confirmation = crypto.createHmac('sha256', config.app.secret)
    .update(JSON.stringify([id, host.id, host.identity, name, row.tag])).digest('hex');
  return { ...review, confirmation };
}

function decipherFor(row) {
  const key = Buffer.from(decrypt(row.wrapped_key), 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(row.iv, 'hex'), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(row.id));
  decipher.setAuthTag(Buffer.from(row.tag, 'hex'));
  return decipher;
}

async function restore(id, host, name, confirmation) {
  return exclusive(async () => {
    const review = await plan(id, host, name);
    if (typeof confirmation !== 'string' || !/^[a-f0-9]{64}$/.test(confirmation)
      || !crypto.timingSafeEqual(Buffer.from(confirmation), Buffer.from(review.confirmation))) {
      throw failure('Review the restore plan again before continuing', 409);
    }
    const row = record(id);
    const file = await fsp.open(archivePath(id), 'r');
    const signal = AbortSignal.timeout(timeout);
    try {
      const stats = await file.stat();
      if (!stats.isFile() || stats.size !== row.archive_bytes) throw failure('The backup file is incomplete');
      // Authenticate the entire archive before allowing any Docker write.
      try {
        await pipeline(file.createReadStream({ start: 0, autoClose: false }), decipherFor(row),
          new Writable({ write(_chunk, _encoding, done) { done(); } }), { signal });
      } catch { throw failure('The backup could not be decrypted or its integrity check failed'); }
      const docker = dockerService.getDocker(host.id);
      await assertAvailable(docker, name);
      const operationId = generateToken(16);
      const target = await docker.createVolume({ Name: name, Driver: 'local', Labels: { [archiveLabel]: operationId } });
      const identity = await target.inspect();
      if (identity.Labels?.[archiveLabel] !== operationId) throw failure('A volume with this name already exists', 409);
      try {
        await withHelper(docker, { Type: 'volume', Source: name, Target: '/target', VolumeOptions: { NoCopy: true } }, async container => {
          const input = file.createReadStream({ start: 0, autoClose: false });
          const content = decipherFor(row);
          const uploading = container.putArchive(content, { path: '/target', copyUIDGID: 'true', abortSignal: signal });
          await Promise.all([pipeline(input, content, { signal }), uploading]);
        });
      } catch (error) {
        const current = await target.inspect().catch(() => null);
        if (current?.Labels?.[archiveLabel] === operationId) await target.remove().catch(() => {});
        throw error;
      }
      return { volume: name, hostId: host.id, hostName: review.destinationHost };
    } finally { await file.close(); }
  });
}

async function remove(id) {
  return exclusive(async () => {
    record(id);
    await fsp.rm(archivePath(id), { force: true });
    getDb().prepare('DELETE FROM storage_backups WHERE id = ?').run(id);
  });
}

module.exports = { list, create, plan, restore, remove, bindSourceAllowed, normalizeArchive };
