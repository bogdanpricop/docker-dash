'use strict';

const { Router } = require('express');
const dockerService = require('../services/docker');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');

const { extractHostId } = require('../middleware/hostId');
const { requireHostAccessForMethod } = require('../middleware/hostAccess');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();
router.use(requireAuth);
router.use(extractHostId);
router.use(requireHostAccessForMethod());

router.get('/', requireAuth, asyncHandler(async (req, res) => {
  res.json(await dockerService.listVolumes(req.hostId));
}));

router.get('/:name/inspect', requireAuth, asyncHandler(async (req, res) => {
  res.json(await dockerService.inspectVolume(req.params.name, req.hostId));
}));

// Create volume
router.post('/', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  const { name, driver, driverOpts, labels } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const docker = dockerService.getDocker(req.hostId);
  const volume = await docker.createVolume({
    Name: name,
    Driver: driver || 'local',
    DriverOpts: driverOpts || {},
    Labels: labels || {},
  });
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'volume_create', targetType: 'volume', targetId: name,
    details: { driver: driver || 'local' }, ip: getClientIp(req),
  });
  res.status(201).json({ ok: true, name: volume.name || volume.Name });
}));

router.delete('/:name', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  await dockerService.removeVolume(req.params.name, { force: req.query.force === 'true' }, req.hostId);
  auditService.log({ userId: req.user.id, username: req.user.username,
    action: 'volume_remove', targetType: 'volume', targetId: req.params.name, ip: getClientIp(req) });
  res.json({ ok: true });
}));

module.exports = router;
