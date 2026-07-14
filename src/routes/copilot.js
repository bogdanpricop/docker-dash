'use strict';

// v8.9.43-alpha.1 — Ops Copilot routes. Briefing = any authenticated user; ask /
// config / test = admin + audited. The stored API key is never returned.

const { Router } = require('express');
const copilot = require('../services/copilot');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();
const admin = [requireAuth, requireRole('admin'), writeable];

// Light cache — briefing runs a posture scan + blueprint plans (+ optional LLM).
let _cache = { result: null, ts: 0, running: null };
const CACHE_MS = 60 * 1000;

router.get('/briefing', requireAuth, asyncHandler(async (req, res) => {
  const now = Date.now();
  if (req.query.fresh !== '1' && _cache.result && (now - _cache.ts) < CACHE_MS) return res.json(_cache.result);
  if (_cache.running) { try { return res.json(await _cache.running); } catch (e) { return res.status(500).json({ error: e.message }); } }
  _cache.running = copilot.briefing().then((r) => { _cache = { result: r, ts: Date.now(), running: null }; return r; }).catch((e) => { _cache.running = null; throw e; });
  try { res.json(await _cache.running); } catch (err) { res.status(500).json({ error: err.message }); }
}));

router.post('/ask', ...admin, asyncHandler(async (req, res) => {
  const question = req.body && req.body.question;
  try {
    const r = await copilot.ask(question, { userId: req.user.id });
    auditService.log({ userId: req.user.id, username: req.user.username, action: 'copilot_ask', targetType: 'copilot', targetId: 'estate', details: { q: String(question || '').slice(0, 200) }, ip: getClientIp(req) });
    res.json(r);
  } catch (err) { res.status(err.status && err.status < 500 ? err.status : 200).json({ error: err.message }); }
}));

router.get('/history', ...admin, asyncHandler(async (_req, res) => res.json(copilot.history({ limit: 50 }))));

router.delete('/history', ...admin, asyncHandler(async (req, res) => {
  const r = copilot.clearHistory({});
  auditService.log({ userId: req.user.id, username: req.user.username, action: 'copilot_history_clear', targetType: 'copilot', targetId: 'history', details: {}, ip: getClientIp(req) });
  res.json(r);
}));

router.get('/config', ...admin, asyncHandler(async (_req, res) => res.json(copilot.getConfig())));

router.post('/config', ...admin, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const cfg = copilot.setConfig({ enabled: !!b.enabled, base_url: b.base_url, model: b.model, api_key: b.api_key, clearKey: !!b.clearKey, user: req.user });
  auditService.log({ userId: req.user.id, username: req.user.username, action: 'copilot_config', targetType: 'copilot', targetId: 'config', details: { enabled: cfg.enabled, base_url: cfg.base_url, model: cfg.model, hasKey: cfg.hasKey }, ip: getClientIp(req) });
  _cache = { result: null, ts: 0, running: null };
  res.json(cfg);
}));

router.post('/config/test', ...admin, asyncHandler(async (req, res) => {
  try { res.json(await copilot.testConfig()); }
  catch (err) { res.status(200).json({ ok: false, error: err.message }); }
}));

module.exports = router;
