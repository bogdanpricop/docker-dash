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
  try { res.json(await dockerService.listNetworks(req.hostId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id/inspect', requireAuth, async (req, res) => {
  try { res.json(await dockerService.inspectNetwork(req.params.id, req.hostId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  try {
    const result = await dockerService.createNetwork(req.body, req.hostId);
    auditService.log({ userId: req.user.id, username: req.user.username,
      action: 'network_create', targetType: 'network', details: req.body, ip: getClientIp(req) });
    res.status(201).json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  try {
    await dockerService.removeNetwork(req.params.id, req.hostId);
    auditService.log({ userId: req.user.id, username: req.user.username,
      action: 'network_remove', targetType: 'network', targetId: req.params.id, ip: getClientIp(req) });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Connect container to network
router.post('/:id/connect', requireAuth, requireRole('admin', 'operator'), writeable, async (req, res) => {
  try {
    const { containerId } = req.body;
    if (!containerId) return res.status(400).json({ error: 'containerId required' });
    const docker = dockerService.getDocker(req.hostId);
    const network = docker.getNetwork(req.params.id);
    await network.connect({ Container: containerId });
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'network_connect', targetType: 'network', targetId: req.params.id,
      details: { containerId }, ip: getClientIp(req),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Disconnect container from network
router.post('/:id/disconnect', requireAuth, requireRole('admin', 'operator'), writeable, async (req, res) => {
  try {
    const { containerId } = req.body;
    if (!containerId) return res.status(400).json({ error: 'containerId required' });
    const docker = dockerService.getDocker(req.hostId);
    const network = docker.getNetwork(req.params.id);
    await network.disconnect({ Container: containerId });
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'network_disconnect', targetType: 'network', targetId: req.params.id,
      details: { containerId }, ip: getClientIp(req),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
