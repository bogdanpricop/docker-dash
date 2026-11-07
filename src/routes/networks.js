'use strict';

const { Router } = require('express');
const dockerService = require('../services/docker');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');

const { extractHostId } = require('../middleware/hostId');
const { requireHostAccessForMethod } = require('../middleware/hostAccess');
const asyncHandler = require('../utils/asyncHandler');
const { parseSubnet, findOverlaps } = require('../utils/docker-network-subnet');

const router = Router();
router.use(extractHostId);

router.get('/', requireAuth, requireHostAccessForMethod(), asyncHandler(async (req, res) => {
  res.json(await dockerService.listNetworks(req.resolvedHostId ?? req.hostId));
}));

router.get('/:id/inspect', requireAuth, requireHostAccessForMethod(), asyncHandler(async (req, res) => {
  res.json(await dockerService.inspectNetwork(req.params.id, req.resolvedHostId ?? req.hostId));
}));

router.get('/check-subnet', requireAuth, requireHostAccessForMethod(), requireRole('admin'), asyncHandler(async (req, res) => {
  const { subnet, driver, gateway } = req.query;
  const hostId = req.resolvedHostId ?? req.hostId;
  if (!subnet && !gateway) return res.json({ hostId, conflicts: [] });
  const range = parseSubnet(subnet);
  if (!range || !['bridge', 'macvlan', 'overlay'].includes(driver)) return res.status(400).json({ error: 'Enter a valid IPv4 or IPv6 subnet in CIDR notation' });
  if (gateway && (typeof gateway !== 'string' || !range.includes(gateway))) return res.status(400).json({ error: 'Gateway must be an address inside the subnet' });
  const networks = await dockerService.getDocker(hostId).listNetworks();
  res.json({ hostId, conflicts: findOverlaps(networks, range, driver === 'overlay' ? 'swarm' : 'local') });
}));

router.post('/', requireAuth, requireHostAccessForMethod(), requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  const result = await dockerService.createNetwork(req.body, req.resolvedHostId ?? req.hostId);
  auditService.log({ userId: req.user.id, username: req.user.username,
    action: 'network_create', targetType: 'network', details: req.body, ip: getClientIp(req) });
  res.status(201).json(result);
}));

router.delete('/:id', requireAuth, requireHostAccessForMethod(), requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  await dockerService.removeNetwork(req.params.id, req.resolvedHostId ?? req.hostId);
  auditService.log({ userId: req.user.id, username: req.user.username,
    action: 'network_remove', targetType: 'network', targetId: req.params.id, ip: getClientIp(req) });
  res.json({ ok: true });
}));

// Connect container to network
router.post('/:id/connect', requireAuth, requireHostAccessForMethod(), requireRole('admin', 'operator'), writeable, asyncHandler(async (req, res) => {
  const { containerId } = req.body;
  if (!containerId) return res.status(400).json({ error: 'containerId required' });
  const docker = dockerService.getDocker(req.resolvedHostId ?? req.hostId);
  const network = docker.getNetwork(req.params.id);
  await network.connect({ Container: containerId });
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'network_connect', targetType: 'network', targetId: req.params.id,
    details: { containerId }, ip: getClientIp(req),
  });
  res.json({ ok: true });
}));

// Disconnect container from network
router.post('/:id/disconnect', requireAuth, requireHostAccessForMethod(), requireRole('admin', 'operator'), writeable, asyncHandler(async (req, res) => {
  const { containerId } = req.body;
  if (!containerId) return res.status(400).json({ error: 'containerId required' });
  const docker = dockerService.getDocker(req.resolvedHostId ?? req.hostId);
  const network = docker.getNetwork(req.params.id);
  await network.disconnect({ Container: containerId });
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'network_disconnect', targetType: 'network', targetId: req.params.id,
    details: { containerId }, ip: getClientIp(req),
  });
  res.json({ ok: true });
}));

module.exports = router;
