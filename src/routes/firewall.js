'use strict';

// v8.9.22-alpha.1 — Firewall management routes (MVP1). Per-host, admin-only,
// audited, whitelisted operations. Operational failures (backend missing, apply
// rejected) return { ok:false, error } (HTTP 200) so the UI can guide; only auth
// and bad-input are hard HTTP errors.

const { Router } = require('express');
const { getDb } = require('../db');
const fw = require('../services/firewall');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();
// RBAC tiers (v8.9.28):
//  viewer   → read status/rules/audit (any authenticated user)
//  operator → add TEMPORARY rules, remove/extend their OWN rules, snapshot
//  admin    → everything (permanent rules, reconcile, rollback, agent config)
const admin = [requireAuth, requireRole('admin')];
const adminWrite = [requireAuth, requireRole('admin'), writeable];
const operatorWrite = [requireAuth, requireRole('operator', 'admin'), writeable];

function _hostId(req) { return parseInt(req.params.hostId, 10); }

function _audit(req, action, hostId, details, success, error) {
  auditService.log({
    userId: req.user && req.user.id, username: req.user && req.user.username,
    action, targetType: 'firewall', targetId: String(hostId),
    details: { ...details, success, error: error || undefined }, ip: getClientIp(req),
  });
}

// ── Read ──────────────────────────────────────────────────────────────────
router.get('/:hostId/status', requireAuth, asyncHandler(async (req, res) => {
  try { res.json(await fw.detectBackend(_hostId(req))); }
  catch (err) { res.status(err.status || 500).json({ error: err.message }); }
}));

router.get('/:hostId/rules', requireAuth, asyncHandler(async (req, res) => {
  try { res.json(await fw.listRules(_hostId(req))); }
  catch (err) { res.status(err.status || 500).json({ error: err.message }); }
}));

router.get('/:hostId/audit', requireAuth, asyncHandler(async (req, res) => {
  const hostId = _hostId(req);
  const db = getDb();
  const rules = db.prepare('SELECT * FROM firewall_rules WHERE host_id = ? ORDER BY created_at DESC LIMIT 200').all(hostId);
  const snapshots = db.prepare('SELECT id, backend, created_at, created_by, reason FROM firewall_snapshots WHERE host_id = ? ORDER BY created_at DESC LIMIT 50').all(hostId);
  res.json({ hostId, rules, snapshots });
}));

// ── Mutations (whitelisted) ─────────────────────────────────────────────────
async function _apply(req, res, spec, action) {
  const hostId = _hostId(req);
  // Operators may only add TEMPORARY rules; permanent rules are admin-only.
  if (req.user && req.user.role !== 'admin' && !(req.body && req.body.expires_in_minutes)) {
    return res.status(403).json({ ok: false, error: 'Operators can only add temporary rules — set an expiry (minutes). Ask an admin for permanent rules.' });
  }
  try {
    const r = await fw.applyRule(hostId, { ...spec, reason: req.body && req.body.reason, expires_in_minutes: req.body && req.body.expires_in_minutes }, req.user, getClientIp(req));
    _audit(req, 'firewall_apply_rule', hostId, { op: action, spec, backend: r.backend, rule_uuid: r.rule && r.rule.rule_uuid }, true);
    res.json(r);
  } catch (err) {
    _audit(req, 'firewall_apply_rule', hostId, { op: action, spec }, false, err.message);
    res.status(err.status && err.status < 500 ? err.status : 200).json({ ok: false, error: err.message });
  }
}

router.post('/:hostId/allow-ip', ...operatorWrite, asyncHandler((req, res) =>
  _apply(req, res, { action: 'allow', scope: req.body.scope || 'host', source_ip: req.body.source_ip, destination_port: req.body.destination_port, protocol: req.body.protocol }, 'allow-ip')));

router.post('/:hostId/block-ip', ...operatorWrite, asyncHandler((req, res) =>
  _apply(req, res, { action: 'block', scope: req.body.scope || 'host', source_ip: req.body.source_ip, destination_port: req.body.destination_port, protocol: req.body.protocol }, 'block-ip')));

router.post('/:hostId/open-port', ...operatorWrite, asyncHandler((req, res) =>
  _apply(req, res, { action: 'allow', scope: req.body.scope || 'host', destination_port: req.body.destination_port, protocol: req.body.protocol }, 'open-port')));

router.post('/:hostId/close-port', ...operatorWrite, asyncHandler((req, res) =>
  _apply(req, res, { action: 'block', scope: req.body.scope || 'host', destination_port: req.body.destination_port, protocol: req.body.protocol }, 'close-port')));

router.post('/:hostId/allow-container-port', ...operatorWrite, asyncHandler((req, res) =>
  _apply(req, res, { action: 'allow', scope: 'docker', source_ip: req.body.source_ip, destination_port: req.body.destination_port, protocol: req.body.protocol }, 'allow-container-port')));

// Generic add-rule (Add-rule form): action + scope + fields from body.
router.post('/:hostId/rule', ...operatorWrite, asyncHandler((req, res) =>
  _apply(req, res, { action: req.body.action, scope: req.body.scope || 'host', source_ip: req.body.source_ip, destination_port: req.body.destination_port, protocol: req.body.protocol }, 'add-rule')));

router.post('/:hostId/remove-rule', ...operatorWrite, asyncHandler(async (req, res) => {
  const hostId = _hostId(req);
  try {
    const r = await fw.removeRule(hostId, req.body.rule_uuid, req.user);
    _audit(req, 'firewall_remove_rule', hostId, { rule_uuid: req.body.rule_uuid }, true);
    res.json(r);
  } catch (err) {
    _audit(req, 'firewall_remove_rule', hostId, { rule_uuid: req.body.rule_uuid }, false, err.message);
    res.json({ ok: false, error: err.message });
  }
}));

router.post('/:hostId/extend-rule', ...operatorWrite, asyncHandler(async (req, res) => {
  const hostId = _hostId(req);
  try {
    const r = await fw.extendRule(hostId, req.body.rule_uuid, req.body.minutes, req.user);
    _audit(req, 'firewall_extend_rule', hostId, { rule_uuid: req.body.rule_uuid, minutes: req.body.minutes }, true);
    res.json(r);
  } catch (err) {
    _audit(req, 'firewall_extend_rule', hostId, { rule_uuid: req.body.rule_uuid }, false, err.message);
    res.json({ ok: false, error: err.message });
  }
}));

router.post('/:hostId/reconcile', ...adminWrite, asyncHandler(async (req, res) => {
  const hostId = _hostId(req);
  try {
    const r = await fw.reconcile(hostId, req.user);
    _audit(req, 'firewall_reconcile', hostId, r, true);
    res.json(r);
  } catch (err) {
    _audit(req, 'firewall_reconcile', hostId, {}, false, err.message);
    res.json({ ok: false, error: err.message });
  }
}));

router.post('/:hostId/snapshot', ...operatorWrite, asyncHandler(async (req, res) => {
  const hostId = _hostId(req);
  try {
    const r = await fw.snapshot(hostId, req.user, (req.body && req.body.reason) || 'manual');
    _audit(req, 'firewall_snapshot', hostId, { snapshotId: r.id, backend: r.backend }, true);
    res.json(r);
  } catch (err) {
    _audit(req, 'firewall_snapshot', hostId, {}, false, err.message);
    res.json({ ok: false, error: err.message });
  }
}));

router.post('/:hostId/rollback', ...adminWrite, asyncHandler(async (req, res) => {
  const hostId = _hostId(req);
  try {
    const r = await fw.rollback(hostId, parseInt(req.body.snapshotId, 10), req.user);
    _audit(req, 'firewall_rollback', hostId, { snapshotId: req.body.snapshotId }, true);
    res.json(r);
  } catch (err) {
    _audit(req, 'firewall_rollback', hostId, { snapshotId: req.body.snapshotId }, false, err.message);
    res.json({ ok: false, error: err.message });
  }
}));

// ── Agent channel config ────────────────────────────────────────────────────
// Store {url, token} for a host's firewall-agent, encrypted in daemon_config.
// The token is write-only (never returned).
router.get('/:hostId/agent-config', ...admin, asyncHandler(async (req, res) => {
  const hostId = _hostId(req);
  const row = getDb().prepare('SELECT daemon_config FROM docker_hosts WHERE id = ?').get(hostId);
  if (!row) return res.status(404).json({ error: 'Host not found' });
  let cfg = {};
  try { const { decryptDaemonConfig } = require('../services/vsphere'); cfg = decryptDaemonConfig(row.daemon_config) || {}; } catch { /* ignore */ }
  const fa = cfg.firewallAgent || null;
  res.json({ configured: !!(fa && fa.url), url: fa ? fa.url : null, mtls: !!(fa && fa.tls && fa.tls.cert) });
}));

router.post('/:hostId/agent-config', ...adminWrite, asyncHandler(async (req, res) => {
  const hostId = _hostId(req);
  const db = getDb();
  const row = db.prepare('SELECT daemon_config FROM docker_hosts WHERE id = ?').get(hostId);
  if (!row) return res.status(404).json({ error: 'Host not found' });
  const { decryptDaemonConfig, encryptDaemonConfig } = require('../services/vsphere');
  let cfg = {};
  try { cfg = decryptDaemonConfig(row.daemon_config) || {}; } catch { /* ignore */ }
  if (req.body && req.body.remove) {
    delete cfg.firewallAgent;
  } else {
    const url = String((req.body && req.body.url) || '').trim();
    let token = String((req.body && req.body.token) || '').trim();
    const existing = cfg.firewallAgent || {};
    if (!token && existing.token) token = existing.token; // keep current token if left blank
    if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: 'url must start with http:// or https://' });
    if (token.length < 16) return res.status(400).json({ error: 'token must be at least 16 chars' });
    const next = { url, token };
    // Optional mutual TLS: client cert + key (+ CA to verify the agent's cert).
    const tls = (req.body && req.body.tls) || {};
    if (tls.cert && tls.key) {
      next.tls = { cert: tls.cert, key: tls.key, ca: tls.ca || undefined };
    } else if (tls.keep && existing.tls) {
      next.tls = existing.tls; // keep existing certs when not re-pasted
    }
    cfg.firewallAgent = next;
  }
  db.prepare('UPDATE docker_hosts SET daemon_config = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(encryptDaemonConfig(cfg), hostId);
  _audit(req, 'firewall_agent_config', hostId, { url: cfg.firewallAgent ? cfg.firewallAgent.url : null, removed: !!(req.body && req.body.remove) }, true);
  res.json({ ok: true, configured: !!cfg.firewallAgent });
}));

module.exports = router;
