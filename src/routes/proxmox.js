'use strict';

// v8.9.1-alpha.1 — Sprint 4 (Proxmox VE) routes.
//
// READ-ONLY in this alpha. Write operations (start/stop VM/LXC,
// snapshot, backup trigger) ship in alpha.2 after real-world
// verification against a Proxmox cluster.
//
// POSITIONING: docker-dash's Proxmox integration is deliberately a
// "read + light action" panel — NOT a full Proxmox UI replacement.
// Proxmox already ships an excellent web UI. Our value-add is showing
// VMs + LXCs + backups + storages alongside Docker hosts in one
// dashboard for operators running a MIXED infrastructure.

const { Router } = require('express');
const { getDb } = require('../db');
const { fromHostRow } = require('../services/proxmox');
const { requireAuth } = require('../middleware/auth');
const { extractHostId } = require('../middleware/hostId');
const { requireHostAccessForMethod } = require('../middleware/hostAccess');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();
router.use(extractHostId);
const hostAccess = requireHostAccessForMethod();

function _getProxmoxHost(req, res) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM docker_hosts WHERE id = ?').get(req.resolvedHostId ?? req.hostId);
  if (!row) { res.status(404).json({ error: `Host ${req.hostId} not found` }); return null; }
  if (row.daemon_type !== 'proxmox') {
    res.status(400).json({
      error: `Host ${req.hostId} (${row.name}) is not a Proxmox daemon (daemon_type=${row.daemon_type})`,
    });
    return null;
  }
  return row;
}

router.get('/info', requireAuth, hostAccess, asyncHandler(async (req, res) => {
  const row = _getProxmoxHost(req, res); if (!row) return;
  res.json(await fromHostRow(row).version());
}));

router.get('/nodes', requireAuth, hostAccess, asyncHandler(async (req, res) => {
  const row = _getProxmoxHost(req, res); if (!row) return;
  res.json(await fromHostRow(row).listNodes());
}));

router.get('/vms', requireAuth, hostAccess, asyncHandler(async (req, res) => {
  const row = _getProxmoxHost(req, res); if (!row) return;
  res.json(await fromHostRow(row).listVMs());
}));

router.get('/vms/:node/:vmid', requireAuth, hostAccess, asyncHandler(async (req, res) => {
  const row = _getProxmoxHost(req, res); if (!row) return;
  res.json(await fromHostRow(row).getVM(req.params.node, req.params.vmid));
}));

router.get('/lxc', requireAuth, hostAccess, asyncHandler(async (req, res) => {
  const row = _getProxmoxHost(req, res); if (!row) return;
  res.json(await fromHostRow(row).listLXC());
}));

router.get('/lxc/:node/:vmid', requireAuth, hostAccess, asyncHandler(async (req, res) => {
  const row = _getProxmoxHost(req, res); if (!row) return;
  res.json(await fromHostRow(row).getLXC(req.params.node, req.params.vmid));
}));

router.get('/storages', requireAuth, hostAccess, asyncHandler(async (req, res) => {
  const row = _getProxmoxHost(req, res); if (!row) return;
  res.json(await fromHostRow(row).listStorages());
}));

router.get('/backups', requireAuth, hostAccess, asyncHandler(async (req, res) => {
  const row = _getProxmoxHost(req, res); if (!row) return;
  res.json(await fromHostRow(row).listBackups());
}));

module.exports = router;
