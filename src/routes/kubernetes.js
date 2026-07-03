'use strict';

// v8.9.4-alpha.1 — Sprint 5 (Kubernetes) routes. Read-only in this alpha.
//
// SECURITY: read-only routes require requireAuth. State-changing routes
// (deferred to alpha.2) will additionally require admin + writeable +
// audit_log per CLAUDE.md convention.
//
// ADDRESSING MODEL: per-host, per docker-dash convention. Each cluster
// is a docker_hosts row with daemon_type='kubernetes'. All routes take
// the host id via X-Host-ID header (extractHostId middleware).
//
// STATUS: alpha.1. Read of namespaces / pods / deployments / services /
// nodes shipped. Write ops (scale, rollout-restart, delete pod) deferred
// to alpha.2.

const { Router } = require('express');
const { getDb } = require('../db');
const { fromHostRow } = require('../services/kubernetes');
const { requireAuth } = require('../middleware/auth');
const { extractHostId } = require('../middleware/hostId');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();
router.use(extractHostId);

// Reusable guard: verify the target host is registered AND is k8s.
function _getK8sHost(req, res) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM docker_hosts WHERE id = ?').get(req.hostId);
  if (!row) { res.status(404).json({ error: `Host ${req.hostId} not found` }); return null; }
  if (row.daemon_type !== 'kubernetes') {
    res.status(400).json({
      error: `Host ${req.hostId} (${row.name}) is not a Kubernetes daemon (daemon_type=${row.daemon_type})`,
    });
    return null;
  }
  return row;
}

// ─── Health probe ───────────────────────────────────────────

router.get('/version', requireAuth, asyncHandler(async (req, res) => {
  const row = _getK8sHost(req, res); if (!row) return;
  const client = fromHostRow(row);
  res.json(await client.version());
}));

// ─── Namespaces ─────────────────────────────────────────────

router.get('/namespaces', requireAuth, asyncHandler(async (req, res) => {
  const row = _getK8sHost(req, res); if (!row) return;
  const client = fromHostRow(row);
  res.json(await client.listNamespaces());
}));

// ─── Pods ───────────────────────────────────────────────────

router.get('/pods', requireAuth, asyncHandler(async (req, res) => {
  const row = _getK8sHost(req, res); if (!row) return;
  const client = fromHostRow(row);
  const ns = req.query.namespace || undefined;
  res.json(await client.listPods(ns));
}));

// ─── Deployments ────────────────────────────────────────────

router.get('/deployments', requireAuth, asyncHandler(async (req, res) => {
  const row = _getK8sHost(req, res); if (!row) return;
  const client = fromHostRow(row);
  const ns = req.query.namespace || undefined;
  res.json(await client.listDeployments(ns));
}));

// ─── Services ───────────────────────────────────────────────

router.get('/services', requireAuth, asyncHandler(async (req, res) => {
  const row = _getK8sHost(req, res); if (!row) return;
  const client = fromHostRow(row);
  const ns = req.query.namespace || undefined;
  res.json(await client.listServices(ns));
}));

// ─── Nodes ──────────────────────────────────────────────────

router.get('/nodes', requireAuth, asyncHandler(async (req, res) => {
  const row = _getK8sHost(req, res); if (!row) return;
  const client = fromHostRow(row);
  res.json(await client.listNodes());
}));

module.exports = router;
