'use strict';

// v8.9.37-alpha.1 — Security Posture routes. Read is any authenticated user;
// mute/unmute/rescan are admin + audited. Scan is cached briefly (checks make
// live SSH/SOAP calls).

const { Router } = require('express');
const posture = require('../services/posture');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();
const admin = [requireAuth, requireRole('admin'), writeable];

const CACHE_MS = 60 * 1000;
let _cache = { result: null, ts: 0, running: null };

async function _scan(force) {
  const now = Date.now();
  if (!force && _cache.result && (now - _cache.ts) < CACHE_MS) return _cache.result;
  if (_cache.running) return _cache.running; // coalesce concurrent scans
  _cache.running = posture.scan().then((r) => { _cache = { result: r, ts: Date.now(), running: null }; return r; })
    .catch((e) => { _cache.running = null; throw e; });
  return _cache.running;
}

router.get('/', requireAuth, asyncHandler(async (_req, res) => {
  try { res.json(await _scan(false)); }
  catch (err) { res.status(500).json({ error: err.message }); }
}));

router.post('/rescan', ...admin, asyncHandler(async (req, res) => {
  try {
    const r = await _scan(true);
    try { posture.snapshot(r); } catch { /* snapshot is best-effort */ }
    auditService.log({ userId: req.user.id, username: req.user.username, action: 'posture_rescan', targetType: 'posture', targetId: 'estate', details: { score: r.global.score, grade: r.global.grade }, ip: getClientIp(req) });
    res.json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
}));

router.get('/trend', requireAuth, asyncHandler(async (req, res) => {
  const hostId = req.query.hostId != null && req.query.hostId !== '' ? parseInt(req.query.hostId, 10) : null;
  res.json({ points: posture.trend(hostId, parseInt(req.query.limit, 10) || 200) });
}));

router.get('/mutes', requireAuth, asyncHandler(async (_req, res) => {
  res.json({ mutes: posture.listMutes() });
}));

router.post('/mute', ...admin, asyncHandler(async (req, res) => {
  const { findingKey, hostId, checkId, reason, minutes } = req.body || {};
  try {
    const r = posture.mute({ findingKey, hostId, checkId, reason, minutes, user: req.user });
    auditService.log({ userId: req.user.id, username: req.user.username, action: 'posture_mute', targetType: 'posture', targetId: findingKey, details: { checkId, reason, minutes }, ip: getClientIp(req) });
    res.json(r);
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
}));

router.post('/unmute', ...admin, asyncHandler(async (req, res) => {
  const { findingKey } = req.body || {};
  posture.unmute(findingKey);
  auditService.log({ userId: req.user.id, username: req.user.username, action: 'posture_unmute', targetType: 'posture', targetId: findingKey, details: {}, ip: getClientIp(req) });
  res.json({ ok: true, findingKey });
}));

module.exports = router;
