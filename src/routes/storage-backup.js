'use strict';

const { Router } = require('express');
const { getDb } = require('../db');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { parseHostId, defaultHost } = require('../utils/host-id');
const { getClientIp } = require('../utils/helpers');
const { generateToken, sha256 } = require('../utils/crypto');
const asyncHandler = require('../utils/asyncHandler');
const dockerService = require('../services/docker');
const storage = require('../services/storage-backup');
const audit = require('../services/audit');

const router = Router();
const operations = new Map();
let running = false;
router.use(requireAuth, requireRole('admin'));
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

function selectHost(value) {
  const id = parseHostId(value);
  if (id === null) throw Object.assign(new Error('Select a Docker host'), { status: 400 });
  const db = getDb();
  const host = id === 0 ? defaultHost(db) : db.prepare('SELECT * FROM docker_hosts WHERE id = ?').get(id);
  if (!host || !host.is_active || host.daemon_type !== 'docker') {
    throw Object.assign(new Error('Select an active Docker host'), { status: 400 });
  }
  const identity = sha256(JSON.stringify([host.connection_type, host.host, host.port, host.socket_path, host.ssh_config, host.tls_config]));
  return { id: host.id, name: host.name, identity };
}

function log(req, action, id, details) {
  audit.log({ userId: req.user.id, username: req.user.username, ip: getClientIp(req),
    action, targetType: 'storage_backup', targetId: id, details });
}

function startOperation(req, res, action, work) {
  if (running) return res.status(409).json({ error: 'A storage backup or restore is already running' });
  running = true;
  const id = generateToken(16);
  const operation = { id, action, state: 'running', owner: req.user.id };
  operations.set(id, operation);
  if (operations.size > 32) operations.delete(operations.keys().next().value);
  void Promise.resolve().then(work).then(result => {
    Object.assign(operation, { state: 'completed', result });
  }, error => {
    Object.assign(operation, { state: 'failed', error: error.message });
  }).finally(() => { running = false; });
  return res.status(202).json({ operationId: id });
}

router.get('/', (_req, res) => res.json({ backups: storage.list() }));

router.get('/operations/:id', (req, res) => {
  const operation = operations.get(req.params.id);
  if (!operation || operation.owner !== req.user.id) return res.status(404).json({ error: 'Storage operation is unavailable' });
  const { owner: _, ...status } = operation;
  res.json(status);
});

router.get('/sources', asyncHandler(async (req, res) => {
  const host = selectHost(req.query.sourceHostId);
  const docker = dockerService.getDocker(host.id);
  const [volumes, containers] = await Promise.all([docker.listVolumes(), dockerService.listContainers(host.id)]);
  res.json({
    volumes: (volumes.Volumes || []).map(volume => volume.Name).sort(),
    binds: containers.flatMap(container => container.mounts
      .filter(mount => mount.type === 'bind' && storage.bindSourceAllowed(mount.source))
      .map(mount => ({ containerId: container.id, containerName: container.name, destination: mount.destination }))),
  });
}));

router.post('/', writeable, (req, res) => {
  const host = selectHost(req.body?.sourceHostId);
  return startOperation(req, res, 'backup', async () => {
    const backup = await storage.create(host, req.body?.source);
    log(req, 'storage_backup_created', backup.id, { hostId: host.id, source: backup.source_name, bytes: backup.archive_bytes });
    return { backup };
  });
});

router.post('/:id/restore/plan', asyncHandler(async (req, res) => {
  const host = selectHost(req.body?.targetHostId);
  res.json(await storage.plan(req.params.id, host, req.body?.volume));
}));

router.post('/:id/restore', writeable, (req, res) => {
  const host = selectHost(req.body?.targetHostId);
  return startOperation(req, res, 'restore', async () => {
    try {
      const result = await storage.restore(req.params.id, host, req.body?.volume, req.body?.confirmation);
      log(req, 'storage_backup_restored', req.params.id, { hostId: host.id, volume: result.volume });
      return result;
    } catch (error) {
      log(req, 'storage_restore_failed', req.params.id, { hostId: host.id, status: error.status || error.statusCode || 500 });
      throw error;
    }
  });
});

router.delete('/:id', writeable, asyncHandler(async (req, res) => {
  await storage.remove(req.params.id);
  log(req, 'storage_backup_deleted', req.params.id);
  res.json({ ok: true });
}));

module.exports = router;
