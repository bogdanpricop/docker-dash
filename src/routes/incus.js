'use strict';

// v8.9.0-alpha.2 — Sprint 3: Incus routes.
//
// SECURITY: every state-changing route requires the admin role and
// writes an audit_log entry per CLAUDE.md convention.
//
// ADDRESSING MODEL: unlike Docker, the docker-dash Incus integration is
// per-host (each Incus daemon is a distinct docker_hosts row with
// daemon_type='incus'). All routes require an explicit `hostId` in the
// standard X-Host-ID header handled by the extractHostId middleware.
//
// STATUS: alpha.2. Read + write shipped. UI page + WebSocket console
// still pending. Feature-flagged via daemon_type='incus' on the target
// host row — no accidental Docker host ends up in this code path.

const { Router } = require('express');
const { getDb } = require('../db');
const { fromHostRow } = require('../services/incus');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const { extractHostId } = require('../middleware/hostId');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();
router.use(extractHostId);

// Reusable guard: verify the target host is registered AND runs an
// Incus- or LXD-compatible daemon. Both share the same REST API so the
// same routes serve both. Returns the row on success; sends 400/404 and
// returns null on failure so the handler can early-exit.
function _getIncusHost(req, res) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM docker_hosts WHERE id = ?').get(req.hostId);
  if (!row) { res.status(404).json({ error: `Host ${req.hostId} not found` }); return null; }
  if (row.daemon_type !== 'incus' && row.daemon_type !== 'lxd') {
    res.status(400).json({
      error: `Host ${req.hostId} (${row.name}) is not an Incus/LXD daemon (daemon_type=${row.daemon_type})`,
    });
    return null;
  }
  return row;
}

// ─── Health probe ───────────────────────────────────────────

// GET /api/incus/info — daemon version + supported API versions.
// Used by the frontend to render a "connected/not connected" pill.
router.get('/info', requireAuth, asyncHandler(async (req, res) => {
  const row = _getIncusHost(req, res); if (!row) return;
  const client = fromHostRow(row);
  const info = await client.info();
  res.json(info && info.metadata);
}));

// ─── Instances ──────────────────────────────────────────────

router.get('/instances', requireAuth, asyncHandler(async (req, res) => {
  const row = _getIncusHost(req, res); if (!row) return;
  const client = fromHostRow(row);
  const project = req.query.project || undefined;
  const list = await client.listInstances(project);
  res.json(list);
}));

router.get('/instances/:name', requireAuth, asyncHandler(async (req, res) => {
  const row = _getIncusHost(req, res); if (!row) return;
  const client = fromHostRow(row);
  const project = req.query.project || undefined;
  const inst = await client.getInstance(req.params.name, project);
  res.json(inst);
}));

// State changes: start / stop / restart / freeze / unfreeze.
// Each returns the operation metadata on success.
const _stateActionRoutes = ['start', 'stop', 'restart', 'freeze', 'unfreeze'];
for (const action of _stateActionRoutes) {
  router.post(`/instances/:name/${action}`, requireAuth, requireRole('admin'), writeable,
    asyncHandler(async (req, res) => {
      const row = _getIncusHost(req, res); if (!row) return;
      const client = fromHostRow(row);
      const opts = {
        project: req.query.project || undefined,
        force: !!req.body.force,
        timeout: typeof req.body.timeout === 'number' ? req.body.timeout : 30,
      };
      try {
        const result = await client[`${action}Instance`](req.params.name, opts);
        auditService.log({
          userId: req.user.id, username: req.user.username,
          action: `incus_instance_${action}`, targetType: 'incus_instance', targetId: req.params.name,
          details: { hostId: req.hostId, daemonType: row.daemon_type, force: opts.force }, ip: getClientIp(req),
        });
        res.json({ ok: true, result });
      } catch (err) {
        res.status(err.status || 500).json({ error: err.message, incusResponse: err.incusResponse });
      }
    })
  );
}

router.delete('/instances/:name', requireAuth, requireRole('admin'), writeable,
  asyncHandler(async (req, res) => {
    const row = _getIncusHost(req, res); if (!row) return;
    const client = fromHostRow(row);
    try {
      const result = await client.deleteInstance(req.params.name, {
        project: req.query.project || undefined,
      });
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'incus_instance_delete', targetType: 'incus_instance', targetId: req.params.name,
        details: { hostId: req.hostId, daemonType: row.daemon_type }, ip: getClientIp(req),
      });
      res.json({ ok: true, result });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, incusResponse: err.incusResponse });
    }
  })
);

// ─── Snapshots ──────────────────────────────────────────────

router.get('/instances/:name/snapshots', requireAuth, asyncHandler(async (req, res) => {
  const row = _getIncusHost(req, res); if (!row) return;
  const client = fromHostRow(row);
  res.json(await client.listSnapshots(req.params.name, req.query.project || undefined));
}));

router.post('/instances/:name/snapshots', requireAuth, requireRole('admin'), writeable,
  asyncHandler(async (req, res) => {
    const row = _getIncusHost(req, res); if (!row) return;
    const client = fromHostRow(row);
    const { snapshotName, stateful } = req.body || {};
    if (!snapshotName || !/^[a-zA-Z0-9._-]{1,64}$/.test(snapshotName)) {
      return res.status(400).json({ error: 'snapshotName is required (alphanumeric, dot, underscore, dash; up to 64 chars)' });
    }
    try {
      const result = await client.createSnapshot(req.params.name, snapshotName, {
        project: req.query.project || undefined, stateful: !!stateful,
      });
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'incus_snapshot_create', targetType: 'incus_snapshot',
        targetId: `${req.params.name}/${snapshotName}`,
        details: { hostId: req.hostId, daemonType: row.daemon_type }, ip: getClientIp(req),
      });
      res.json({ ok: true, result });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, incusResponse: err.incusResponse });
    }
  })
);

router.post('/instances/:name/snapshots/:snapshot/restore', requireAuth, requireRole('admin'), writeable,
  asyncHandler(async (req, res) => {
    const row = _getIncusHost(req, res); if (!row) return;
    const client = fromHostRow(row);
    try {
      const result = await client.restoreSnapshot(req.params.name, req.params.snapshot, {
        project: req.query.project || undefined,
      });
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'incus_snapshot_restore', targetType: 'incus_snapshot',
        targetId: `${req.params.name}/${req.params.snapshot}`,
        details: { hostId: req.hostId, daemonType: row.daemon_type }, ip: getClientIp(req),
      });
      res.json({ ok: true, result });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, incusResponse: err.incusResponse });
    }
  })
);

router.delete('/instances/:name/snapshots/:snapshot', requireAuth, requireRole('admin'), writeable,
  asyncHandler(async (req, res) => {
    const row = _getIncusHost(req, res); if (!row) return;
    const client = fromHostRow(row);
    try {
      const result = await client.deleteSnapshot(req.params.name, req.params.snapshot, {
        project: req.query.project || undefined,
      });
      auditService.log({
        userId: req.user.id, username: req.user.username,
        action: 'incus_snapshot_delete', targetType: 'incus_snapshot',
        targetId: `${req.params.name}/${req.params.snapshot}`,
        details: { hostId: req.hostId, daemonType: row.daemon_type }, ip: getClientIp(req),
      });
      res.json({ ok: true, result });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message, incusResponse: err.incusResponse });
    }
  })
);

// ─── Images / Projects (read-only for now) ──────────────────

router.get('/images', requireAuth, asyncHandler(async (req, res) => {
  const row = _getIncusHost(req, res); if (!row) return;
  res.json(await fromHostRow(row).listImages());
}));

router.get('/projects', requireAuth, asyncHandler(async (req, res) => {
  const row = _getIncusHost(req, res); if (!row) return;
  res.json(await fromHostRow(row).listProjects());
}));

module.exports = router;
