'use strict';

// v8.9.5-alpha.1 — Sprint 10 (Nomad) routes. Read-only in this alpha.
//
// SECURITY: read routes require requireAuth. Write ops (job submit,
// stop, restart) land in alpha.2 and will additionally require admin +
// writeable + audit_log.

const { Router } = require('express');
const { getDb } = require('../db');
const { fromHostRow } = require('../services/nomad');
const { requireAuth } = require('../middleware/auth');
const { extractHostId } = require('../middleware/hostId');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();
router.use(extractHostId);

function _getNomadHost(req, res) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM docker_hosts WHERE id = ?').get(req.hostId);
  if (!row) { res.status(404).json({ error: `Host ${req.hostId} not found` }); return null; }
  if (row.daemon_type !== 'nomad') {
    res.status(400).json({
      error: `Host ${req.hostId} (${row.name}) is not a Nomad daemon (daemon_type=${row.daemon_type})`,
    });
    return null;
  }
  return row;
}

router.get('/info', requireAuth, asyncHandler(async (req, res) => {
  const row = _getNomadHost(req, res); if (!row) return;
  res.json(await fromHostRow(row).agentSelf());
}));

router.get('/namespaces', requireAuth, asyncHandler(async (req, res) => {
  const row = _getNomadHost(req, res); if (!row) return;
  res.json(await fromHostRow(row).listNamespaces());
}));

router.get('/jobs', requireAuth, asyncHandler(async (req, res) => {
  const row = _getNomadHost(req, res); if (!row) return;
  const ns = req.query.namespace || undefined;
  res.json(await fromHostRow(row).listJobs(ns));
}));

router.get('/jobs/:id', requireAuth, asyncHandler(async (req, res) => {
  const row = _getNomadHost(req, res); if (!row) return;
  const ns = req.query.namespace || undefined;
  res.json(await fromHostRow(row).getJob(req.params.id, ns));
}));

router.get('/jobs/:id/allocations', requireAuth, asyncHandler(async (req, res) => {
  const row = _getNomadHost(req, res); if (!row) return;
  const ns = req.query.namespace || undefined;
  res.json(await fromHostRow(row).listJobAllocations(req.params.id, ns));
}));

router.get('/allocations', requireAuth, asyncHandler(async (req, res) => {
  const row = _getNomadHost(req, res); if (!row) return;
  const ns = req.query.namespace || undefined;
  res.json(await fromHostRow(row).listAllocations(ns));
}));

router.get('/nodes', requireAuth, asyncHandler(async (req, res) => {
  const row = _getNomadHost(req, res); if (!row) return;
  res.json(await fromHostRow(row).listNodes());
}));

router.get('/deployments', requireAuth, asyncHandler(async (req, res) => {
  const row = _getNomadHost(req, res); if (!row) return;
  const ns = req.query.namespace || undefined;
  res.json(await fromHostRow(row).listDeployments(ns));
}));

module.exports = router;
