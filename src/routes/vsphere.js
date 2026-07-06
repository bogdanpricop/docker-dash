'use strict';

// v8.9.11-alpha.1 — VMware vSphere / ESXi routes. Read-only in this alpha.

const { Router } = require('express');
const { getDb } = require('../db');
const { fromHostRow } = require('../services/vsphere');
const { requireAuth } = require('../middleware/auth');
const { extractHostId } = require('../middleware/hostId');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();
router.use(extractHostId);

function _getVSphereHost(req, res) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM docker_hosts WHERE id = ?').get(req.hostId);
  if (!row) { res.status(404).json({ error: `Host ${req.hostId} not found` }); return null; }
  if (row.daemon_type !== 'vsphere') {
    res.status(400).json({
      error: `Host ${req.hostId} (${row.name}) is not a vSphere daemon (daemon_type=${row.daemon_type})`,
    });
    return null;
  }
  return row;
}

// Cache clients per host id — SOAP login is expensive.
const _clientCache = new Map();
async function _getClient(row) {
  const cached = _clientCache.get(row.id);
  if (cached) return cached;
  const c = fromHostRow(row);
  try { await c.login(); }
  catch (err) { throw err; }
  _clientCache.set(row.id, c);
  // Expire after 20 min
  setTimeout(() => {
    _clientCache.delete(row.id);
    c.logout().catch(() => {});
  }, 20 * 60 * 1000).unref();
  return c;
}

router.get('/info', requireAuth, asyncHandler(async (req, res) => {
  const row = _getVSphereHost(req, res); if (!row) return;
  try {
    const c = await _getClient(row);
    res.json(await c.retrieveServiceContent());
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}));

router.get('/vms', requireAuth, asyncHandler(async (req, res) => {
  const row = _getVSphereHost(req, res); if (!row) return;
  try {
    const c = await _getClient(row);
    res.json(await c.listVMs());
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}));

router.get('/hosts', requireAuth, asyncHandler(async (req, res) => {
  const row = _getVSphereHost(req, res); if (!row) return;
  try {
    const c = await _getClient(row);
    res.json(await c.listHosts());
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}));

router.get('/datastores', requireAuth, asyncHandler(async (req, res) => {
  const row = _getVSphereHost(req, res); if (!row) return;
  try {
    const c = await _getClient(row);
    res.json(await c.listDatastores());
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}));

module.exports = router;
