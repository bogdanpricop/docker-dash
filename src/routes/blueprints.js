'use strict';

// v8.9.42-alpha.1 — Declarative Reconciler routes. Read/plan/export = any
// authenticated user; capture/apply/import/enforce/CRUD = admin + audited.

const { Router } = require('express');
const rec = require('../services/reconciler');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();
const admin = [requireAuth, requireRole('admin'), writeable];
function _audit(req, action, targetId, details) {
  auditService.log({ userId: req.user && req.user.id, username: req.user && req.user.username, action, targetType: 'blueprint', targetId: String(targetId), details, ip: getClientIp(req) });
}

router.get('/', requireAuth, asyncHandler(async (_req, res) => res.json({ blueprints: rec.list() })));

router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
  const bp = rec.get(parseInt(req.params.id, 10));
  if (!bp) return res.status(404).json({ error: 'Blueprint not found' });
  res.json(bp);
}));

router.post('/', ...admin, asyncHandler(async (req, res) => {
  try {
    const bp = rec.create({ name: req.body.name, description: req.body.description, doc: req.body.doc, user: req.user });
    _audit(req, 'blueprint_create', bp.id, { name: bp.name });
    res.status(201).json(bp);
  } catch (err) { res.status(400).json({ error: err.message }); }
}));

router.put('/:id', ...admin, asyncHandler(async (req, res) => {
  try {
    const bp = rec.update(parseInt(req.params.id, 10), { name: req.body.name, description: req.body.description, doc: req.body.doc, user: req.user });
    _audit(req, 'blueprint_update', req.params.id, { name: bp.name });
    res.json(bp);
  } catch (err) { res.status(400).json({ error: err.message }); }
}));

router.delete('/:id', ...admin, asyncHandler(async (req, res) => {
  rec.remove(parseInt(req.params.id, 10));
  _audit(req, 'blueprint_delete', req.params.id, {});
  res.json({ ok: true });
}));

// Capture current state → save as a new blueprint.
router.post('/capture', ...admin, asyncHandler(async (req, res) => {
  try {
    const doc = await rec.capture();
    const bp = rec.create({ name: req.body.name || 'Captured estate', description: 'Captured from current firewall state', doc, user: req.user });
    _audit(req, 'blueprint_capture', bp.id, { name: bp.name, hosts: Object.keys(doc.hosts || {}).length });
    res.status(201).json(bp);
  } catch (err) { res.status(400).json({ error: err.message }); }
}));

router.get('/:id/plan', requireAuth, asyncHandler(async (req, res) => {
  const bp = rec.get(parseInt(req.params.id, 10));
  if (!bp) return res.status(404).json({ error: 'Blueprint not found' });
  try {
    const p = await rec.plan(bp.doc);
    rec.recordRun(bp.id, 'plan', p.summary, (req.user && req.user.username) || 'system');
    res.json(p);
  } catch (err) { res.status(400).json({ error: err.message }); }
}));

router.post('/:id/apply', ...admin, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const bp = rec.get(id);
  if (!bp) return res.status(404).json({ error: 'Blueprint not found' });
  try {
    const r = await rec.apply(bp.doc, req.user);
    rec.recordRun(id, 'apply', { applied: r.applied, removed: r.removed, started: r.started, failed: r.failed }, req.user.username);
    _audit(req, 'blueprint_apply', id, { applied: r.applied, removed: r.removed, started: r.started, failed: r.failed });
    res.json(r);
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
}));

router.get('/:id/export', requireAuth, asyncHandler(async (req, res) => {
  const bp = rec.get(parseInt(req.params.id, 10));
  if (!bp) return res.status(404).json({ error: 'Blueprint not found' });
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="blueprint-${bp.id}.json"`);
  res.send(JSON.stringify(bp.doc, null, 2));
}));

router.post('/import', ...admin, asyncHandler(async (req, res) => {
  try {
    const bp = rec.create({ name: req.body.name || 'Imported blueprint', description: req.body.description, doc: req.body.doc, user: req.user });
    _audit(req, 'blueprint_import', bp.id, { name: bp.name });
    res.status(201).json(bp);
  } catch (err) { res.status(400).json({ error: err.message }); }
}));

router.post('/:id/enforce', ...admin, asyncHandler(async (req, res) => {
  const bp = rec.setEnforce(parseInt(req.params.id, 10), !!req.body.enforce);
  _audit(req, 'blueprint_enforce', req.params.id, { enforce: !!req.body.enforce });
  res.json(bp);
}));

// ── Remote source (GitOps pull) ─────────────────────────────
// Set the remote HTTPS(S) source of truth. Token (optional) is encrypted at rest
// and never returned. Rejects non-http(s) URLs with 400.
router.put('/:id/source', ...admin, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const source = rec.setSource(id, {
      url: req.body.url, token: req.body.token, clearToken: !!req.body.clearToken,
      autoSync: !!req.body.autoSync, intervalMin: req.body.intervalMin,
    });
    _audit(req, 'blueprint_set_source', id, { url: source.url, autoSync: source.autoSync, intervalMin: source.intervalMin, hasToken: source.hasToken });
    res.json(source);
  } catch (err) { res.status(400).json({ error: err.message }); }
}));

// Pull the blueprint's desired-state from its remote source now.
router.post('/:id/sync', ...admin, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!rec.get(id)) return res.status(404).json({ error: 'Blueprint not found' });
  try {
    const r = await rec.syncNow(id, req.user);
    _audit(req, 'blueprint_sync', id, { ok: r.ok, changed: r.changed, error: r.error });
    res.json(r);
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
}));

module.exports = router;
