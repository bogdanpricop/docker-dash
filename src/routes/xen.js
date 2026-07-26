'use strict';

const { Router } = require('express');
const { getDb } = require('../db');
const xen = require('../services/xen');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { requireHostAccessForMethod } = require('../middleware/hostAccess');
const { extractHostId } = require('../middleware/hostId');
const { getClientIp } = require('../utils/helpers');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();
router.use(extractHostId);
router.use(requireAuth);
router.use(requireHostAccessForMethod());

function _host(req, res) {
  const row = getDb().prepare('SELECT * FROM docker_hosts WHERE id = ?').get(req.hostId);
  if (!row) { res.status(404).json({ error: `Host ${req.hostId} not found` }); return null; }
  if (row.daemon_type !== 'xen') {
    res.status(400).json({ error: `Host ${req.hostId} (${row.name}) is not a Xen endpoint` });
    return null;
  }
  return row;
}

function _client(req, res) {
  const row = _host(req, res);
  return row ? { row, client: xen.clientForHost(row) } : null;
}

function _sendError(res, err) {
  const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  res.status(status).json({
    error: err?.message || 'Xen operation failed',
    code: err?.code || null,
    provider: err?.provider || null,
  });
}

function _audit(req, action, targetType, targetId, details = {}) {
  auditService.log({
    userId: req.user.id, username: req.user.username, action, targetType,
    targetId: String(targetId), details: { hostId: req.hostId, ...details },
    ip: getClientIp(req),
  });
}

router.post('/reconnect', asyncHandler(async (req, res) => {
  const row = _host(req, res); if (!row) return;
  xen.invalidateHost(row.id);
  try {
    const info = await xen.clientForHost(row).info();
    res.json({ ok: true, info });
  } catch (err) { _sendError(res, err); }
}));

router.get('/info', asyncHandler(async (req, res) => {
  const ctx = _client(req, res); if (!ctx) return;
  try { res.json(await ctx.client.info()); }
  catch (err) { _sendError(res, err); }
}));

router.get('/capabilities', asyncHandler(async (req, res) => {
  const ctx = _client(req, res); if (!ctx) return;
  try { res.json(ctx.client.capabilities()); }
  catch (err) { _sendError(res, err); }
}));

for (const [path, method] of [
  ['pools', 'listPools'], ['hosts', 'listHosts'], ['vms', 'listVMs'],
  ['storages', 'listStorages'], ['networks', 'listNetworks'], ['tasks', 'listTasks'],
]) {
  router.get(`/${path}`, asyncHandler(async (req, res) => {
    const ctx = _client(req, res); if (!ctx) return;
    try { res.json(await ctx.client[method]()); }
    catch (err) { _sendError(res, err); }
  }));
}

router.get('/tasks/:id', asyncHandler(async (req, res) => {
  const ctx = _client(req, res); if (!ctx) return;
  try { res.json(await ctx.client.getTask(req.params.id)); }
  catch (err) { _sendError(res, err); }
}));

router.delete('/tasks/:id', requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  const ctx = _client(req, res); if (!ctx) return;
  if (!ctx.client.capabilities().taskCleanup || typeof ctx.client.deleteTask !== 'function') {
    return res.status(400).json({ error: 'Task cleanup is unavailable for this Xen provider' });
  }
  try {
    const result = await ctx.client.deleteTask(req.params.id);
    _audit(req, 'xen_task_delete', 'xen_task', req.params.id, { provider: ctx.client.provider });
    res.json({ ok: true, result });
  } catch (err) { _sendError(res, err); }
}));

router.get('/vms/:id/snapshots', asyncHandler(async (req, res) => {
  const ctx = _client(req, res); if (!ctx) return;
  try { res.json(await ctx.client.listSnapshots(req.params.id)); }
  catch (err) { _sendError(res, err); }
}));

const ACTIONS = new Set([
  'start', 'shutdown', 'forceShutdown', 'reboot', 'forceReboot',
  'suspend', 'resume', 'pause', 'unpause',
]);
const FORCE_ACTIONS = new Set(['forceShutdown', 'forceReboot']);

router.post('/vms/:id/actions/:action', requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  const action = req.params.action;
  if (!ACTIONS.has(action)) return res.status(400).json({ error: `Unsupported Xen VM action: ${action}` });
  if (FORCE_ACTIONS.has(action) && req.body?.confirm !== true) {
    return res.status(400).json({ error: `${action} requires confirm=true` });
  }
  const ctx = _client(req, res); if (!ctx) return;
  try {
    const result = await ctx.client.vmAction(req.params.id, action, req.body || {});
    _audit(req, `xen_vm_${action}`, 'xen_vm', req.params.id, {
      provider: ctx.client.provider, forced: FORCE_ACTIONS.has(action),
    });
    res.json({ ok: true, result });
  } catch (err) { _sendError(res, err); }
}));

router.post('/vms/:id/snapshots', requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!/^[\p{L}\p{N} ._()-]{1,80}$/u.test(name)) {
    return res.status(400).json({ error: 'Snapshot name must contain 1-80 safe characters' });
  }
  const ctx = _client(req, res); if (!ctx) return;
  try {
    const result = await ctx.client.createSnapshot(req.params.id, name);
    _audit(req, 'xen_snapshot_create', 'xen_snapshot', req.params.id, {
      provider: ctx.client.provider, name,
    });
    res.json({ ok: true, result });
  } catch (err) { _sendError(res, err); }
}));

router.post('/snapshots/:id/revert', requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  if (req.body?.confirm !== true) return res.status(400).json({ error: 'Snapshot revert requires confirm=true' });
  const ctx = _client(req, res); if (!ctx) return;
  try {
    const result = await ctx.client.revertSnapshot(req.params.id);
    _audit(req, 'xen_snapshot_revert', 'xen_snapshot', req.params.id, { provider: ctx.client.provider });
    res.json({ ok: true, result });
  } catch (err) { _sendError(res, err); }
}));

router.delete('/snapshots/:id', requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  if (req.query.confirm !== 'true') return res.status(400).json({ error: 'Snapshot deletion requires confirm=true' });
  const ctx = _client(req, res); if (!ctx) return;
  try {
    const result = await ctx.client.deleteSnapshot(req.params.id);
    _audit(req, 'xen_snapshot_delete', 'xen_snapshot', req.params.id, { provider: ctx.client.provider });
    res.json({ ok: true, result });
  } catch (err) { _sendError(res, err); }
}));

module.exports = router;
