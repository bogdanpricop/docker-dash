'use strict';

const { Router } = require('express');
const dockerService = require('../services/docker');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');

const { extractHostId } = require('../middleware/hostId');

const router = Router();
router.use(extractHostId);

router.get('/', requireAuth, async (req, res) => {
  try { res.json(await dockerService.listVolumes(req.hostId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:name/inspect', requireAuth, async (req, res) => {
  try { res.json(await dockerService.inspectVolume(req.params.name, req.hostId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Create volume
router.post('/', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  try {
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:name', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  try {
    await dockerService.removeVolume(req.params.name, { force: req.query.force === 'true' }, req.hostId);
    auditService.log({ userId: req.user.id, username: req.user.username,
      action: 'volume_remove', targetType: 'volume', targetId: req.params.name, ip: getClientIp(req) });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
