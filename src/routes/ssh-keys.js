'use strict';

// v8.9.16-alpha.1 — SSH Key Deployer routes (System → Tools). Admin-only,
// audit-logged. No new deps: Node crypto keygen + existing ssh2 for deploy.

const { Router } = require('express');
const { getDb } = require('../db');
const keygen = require('../services/ssh-keygen');
const deploy = require('../services/ssh-deploy');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();

// Generate a keypair. Returns the private key ONCE (for download / storage);
// it is never persisted here.
router.post('/generate', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  const { type, bits, comment } = req.body || {};
  const kp = keygen.generateKeyPair({ type, bits: parseInt(bits, 10) || undefined, comment });
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'ssh_key_generate', targetType: 'ssh_key', targetId: kp.fingerprint,
    details: { type: kp.type, comment: kp.comment }, ip: getClientIp(req),
  });
  // publicKey + fingerprint are safe; privateKey travels once over the
  // authenticated session for the user to download / store.
  res.json(kp);
}));

// Deploy a public key to a target's authorized_keys over SSH.
router.post('/deploy', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  const { targetType, connection, publicKey } = req.body || {};
  if (!publicKey) return res.status(400).json({ error: 'publicKey is required' });
  if (!connection || !connection.host || !connection.user) {
    return res.status(400).json({ error: 'connection.host and connection.user are required' });
  }
  try {
    const result = await deploy.deployPublicKey({ targetType, connection, publicKey });
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'ssh_key_deploy', targetType: 'ssh_key', targetId: connection.host,
      details: { targetType, user: connection.user, path: result.path, alreadyPresent: result.alreadyPresent },
      ip: getClientIp(req),
    });
    res.json(result);
  } catch (err) {
    // Deploy failures are expected (SSH off, wrong password) — 200 with ok:false
    // so the wizard can show the manual-instructions fallback cleanly.
    res.json({ ok: false, error: err.message });
  }
}));

// Verify a freshly-deployed key works (connect with the private key).
router.post('/test', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const { connection, privateKey, passphrase } = req.body || {};
  if (!connection || !privateKey) return res.status(400).json({ error: 'connection + privateKey required' });
  try { res.json(await deploy.testKey({ connection, privateKey, passphrase })); }
  catch (err) { res.json({ ok: false, error: err.message }); }
}));

// Attach a (just-deployed) private key to an existing vSphere host so the SSH
// console / Hardware tab can use it. Stored encrypted in daemon_config.sshConfig.
router.post('/attach-vsphere', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  const { hostId, sshConfig } = req.body || {};
  if (!hostId || !sshConfig || !sshConfig.privateKey || !sshConfig.host || !sshConfig.user) {
    return res.status(400).json({ error: 'hostId + sshConfig{host,user,privateKey} required' });
  }
  const db = getDb();
  const row = db.prepare('SELECT * FROM docker_hosts WHERE id = ?').get(hostId);
  if (!row || row.daemon_type !== 'vsphere') return res.status(400).json({ error: 'Not a vSphere host' });
  const vsphere = require('../services/vsphere');
  const cfg = vsphere.decryptDaemonConfig(row.daemon_config);
  cfg.sshConfig = {
    host: sshConfig.host, port: parseInt(sshConfig.port, 10) || 22,
    user: sshConfig.user, privateKey: sshConfig.privateKey,
  };
  db.prepare('UPDATE docker_hosts SET daemon_config = ?, updated_at = ? WHERE id = ?')
    .run(vsphere.encryptDaemonConfig(cfg), new Date().toISOString(), hostId);
  auditService.log({
    userId: req.user.id, username: req.user.username,
    action: 'ssh_key_attach_vsphere', targetType: 'host', targetId: String(hostId),
    details: { host: sshConfig.host, user: sshConfig.user }, ip: getClientIp(req),
  });
  res.json({ ok: true });
}));

// List vSphere hosts (for the "attach to host" dropdown in the wizard).
router.get('/vsphere-hosts', requireAuth, requireRole('admin'), asyncHandler(async (_req, res) => {
  const rows = getDb().prepare(`SELECT id, name FROM docker_hosts WHERE daemon_type = 'vsphere' AND is_active = 1`).all();
  res.json(rows);
}));

module.exports = router;
