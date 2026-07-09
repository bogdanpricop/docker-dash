'use strict';

// v8.9.22-alpha.1 — Firewall service (MVP1). Ties validation + per-backend builders
// + execution channel + DB + audit into whitelisted operations. The DB is the
// source of truth for app-managed rules; each host rule is tagged APPFW uuid=… so
// it can be removed deterministically. A snapshot is taken before every mutation.

const crypto = require('../../utils/crypto');
const { assertSafe, validateExpiryMinutes } = require('./validate');
const backends = require('./backends');
const runner = require('./runner');
const lockout = require('./lockout');

function _db() { return require('../../db').getDb(); }

// Resolve a host into everything the firewall needs: channel + ssh port + backend
// hint + optional agent config (stored in daemon_config.firewallAgent).
function _resolveHost(hostId) {
  const row = _db().prepare('SELECT * FROM docker_hosts WHERE id = ?').get(hostId);
  if (!row) { const e = new Error(`Host ${hostId} not found`); e.status = 404; throw e; }
  let sshPort = 22;
  try {
    const { decryptSshConfig } = require('../host-config-crypto');
    const ssh = row.ssh_config ? decryptSshConfig(row.ssh_config) : null;
    if (ssh && ssh.port) sshPort = parseInt(ssh.port, 10) || 22;
  } catch { /* ignore */ }
  let agentCfg = null;
  if (row.daemon_config) {
    try {
      const { decryptDaemonConfig } = require('../vsphere');
      const dc = decryptDaemonConfig(row.daemon_config) || {};
      if (dc.firewallAgent && dc.firewallAgent.url) agentCfg = dc.firewallAgent;
    } catch { /* ignore */ }
  }
  const channel = agentCfg ? 'agent' : (row.connection_type === 'ssh' ? 'ssh' : 'local');
  return {
    id: row.id, name: row.name, connectionType: row.connection_type,
    daemonType: row.daemon_type || 'docker', sshPort, agentCfg, channel,
  };
}

// Detect the active backend on a host (firewalld → ufw → iptables).
async function _detect(host) {
  if (host.channel === 'agent') {
    const r = await runner.agentRequest(host.agentCfg, '/detect', {});
    return { backend: r.backend || null, raw: r.raw || '' };
  }
  for (const name of backends.DETECT_ORDER) {
    const be = backends.get(name);
    try {
      const out = await runner.runRead(host, be.buildDetect(), { timeoutMs: 8000 });
      if (name === 'firewalld' && !/running/i.test(out)) continue;
      if (name === 'ufw' && !/Status:\s*active/i.test(out)) continue;
      if (name === 'windows' && !/windows/i.test(out)) continue;
      return { backend: name, raw: out };
    } catch { /* not this backend, try next */ }
  }
  return { backend: null, raw: '' };
}

async function detectBackend(hostId) {
  const host = _resolveHost(hostId);
  const { backend } = await _detect(host);
  return { hostId, channel: host.channel, backend, available: !!backend, daemonType: host.daemonType };
}

async function listRules(hostId) {
  const host = _resolveHost(hostId);
  const dbRules = _db().prepare(
    'SELECT * FROM firewall_rules WHERE host_id = ? AND is_active = 1 ORDER BY created_at DESC'
  ).all(hostId);
  let backend = null, raw = '';
  try {
    const det = await _detect(host);
    backend = det.backend;
    if (host.channel === 'agent') {
      const r = await runner.agentRequest(host.agentCfg, '/list', {});
      raw = r.raw || ''; backend = r.backend || backend;
    } else if (backend) {
      raw = await runner.runRead(host, backends.get(backend).buildList(), { timeoutMs: 10000 });
    }
  } catch (e) { raw = `(could not read host rules: ${e.message})`; }

  // Drift detection: is each app-managed rule actually present on the host? The
  // rule uuid appears in the iptables/ufw/nft comment and the Windows DisplayName;
  // firewalld's list carries no uuid, so presence is unknown there.
  const canVerify = raw && backend && backend !== 'firewalld';
  for (const r of dbRules) {
    r._present = canVerify ? raw.includes(r.rule_uuid) : null;
  }
  const drift = dbRules.filter(r => r._present === false).map(r => r.rule_uuid);
  return { hostId, channel: host.channel, backend, available: !!backend, daemonType: host.daemonType, rules: dbRules, raw, drift };
}

// Re-apply app-managed rules that have drifted off the host (removed manually or
// lost on a daemon/container restart). Reuses each rule's ORIGINAL uuid so the
// DB row and host tag stay in sync — no new rows created.
async function reconcile(hostId, _user) {
  const info = await listRules(hostId);
  const missing = (info.rules || []).filter(r => r._present === false);
  if (!missing.length) return { reapplied: 0, failed: 0, total: 0 };
  const host = _resolveHost(hostId);
  let reapplied = 0, failed = 0;
  for (const row of missing) {
    const spec = { action: row.action, scope: row.scope, source_ip: row.source_ip || undefined, destination_port: row.destination_port || undefined, protocol: row.protocol || 'tcp', reason: row.reason || undefined };
    try {
      if (host.channel === 'agent') {
        const r = await runner.agentRequest(host.agentCfg, '/apply', { spec, uuid: row.rule_uuid, reason: row.reason });
        if (r && r.ok === false) throw new Error(r.error || 'agent apply failed');
      } else {
        const be = backends.get(row.backend);
        if (!be) throw new Error(`Unknown backend "${row.backend}"`);
        const built = be.buildApply(spec, { uuid: row.rule_uuid, reason: row.reason });
        const res = await runner.runCommands(host, built.commands, { timeoutMs: 20000 });
        if (res.exitCode !== 0) throw new Error(res.stderr || `exit ${res.exitCode}`);
      }
      reapplied++;
    } catch { failed++; }
  }
  return { reapplied, failed, total: missing.length };
}

async function snapshot(hostId, user, reason) {
  const host = _resolveHost(hostId);
  const det = await _detect(host);
  if (!det.backend && host.channel !== 'agent') throw new Error('No firewall backend detected on this host');
  let content, backend = det.backend;
  if (host.channel === 'agent') {
    const r = await runner.agentRequest(host.agentCfg, '/snapshot', {});
    content = r.content || ''; backend = r.backend || backend;
  } else {
    content = await runner.runRead(host, backends.get(backend).buildSnapshot(), { timeoutMs: 15000 });
  }
  const info = _db().prepare(
    'INSERT INTO firewall_snapshots (host_id, backend, snapshot_content, created_by, reason) VALUES (?,?,?,?,?)'
  ).run(hostId, backend || 'unknown', content || '', (user && user.username) || 'system', reason || null);
  return { id: info.lastInsertRowid, backend, hostId };
}

async function applyRule(hostId, rawSpec, user, requesterIp) {
  const spec = assertSafe(rawSpec);
  const host = _resolveHost(hostId);
  const det = await _detect(host);
  const backendName = det.backend || (host.channel === 'agent' ? (await runner.agentRequest(host.agentCfg, '/detect', {})).backend : null);
  if (!backendName) throw new Error('No firewall backend detected on this host');
  if (backends.HOST_ONLY.has(backendName) && (spec.scope === 'docker' || spec.scope === 'container')) {
    throw new Error(`${backendName} cannot filter Docker published ports (they bypass it via NAT). Use host scope, or manage this host with iptables/DOCKER-USER.`);
  }
  lockout.check({ sshPort: host.sshPort, spec, adminIps: [], requesterIp });

  // Snapshot before mutating (best effort — don't block the change if it fails).
  try { await snapshot(hostId, user, 'pre-apply'); } catch { /* ignore */ }

  const uuid = crypto.generateToken(12);
  let built;
  if (host.channel === 'agent') {
    const r = await runner.agentRequest(host.agentCfg, '/apply', { spec, uuid, reason: spec.reason });
    if (r && r.ok === false) throw new Error(r.error || 'agent apply failed');
    built = r.built || { chain: null, comment_tag: `APPFW uuid=${uuid}`, rule_expression: r.rule_expression || '' };
  } else {
    const be = backends.get(backendName);
    built = be.buildApply(spec, { uuid, reason: spec.reason });
    const res = await runner.runCommands(host, built.commands, { timeoutMs: 20000 });
    if (res.exitCode !== 0) throw new Error(res.stderr || `apply failed (exit ${res.exitCode})`);
  }

  // Temporary rule? (auto-expiry cleanup job removes it later.)
  let isTemp = 0, mins = null;
  if (rawSpec && rawSpec.expires_in_minutes != null && rawSpec.expires_in_minutes !== '') {
    mins = parseInt(rawSpec.expires_in_minutes, 10);
    if (!validateExpiryMinutes(mins)) throw new Error('expires_in_minutes must be 1..10080');
    isTemp = 1;
  }

  const info = _db().prepare(`INSERT INTO firewall_rules
    (rule_uuid, host_id, backend, scope, action, source_ip, destination_port, protocol, chain_name, rule_expression, comment_tag, reason, created_by, is_temporary, is_active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(
    uuid, hostId, backendName, spec.scope, spec.action,
    spec.source_ip || null, spec.destination_port || null, spec.protocol || null,
    built.chain || null, built.rule_expression || null, built.comment_tag || null,
    spec.reason || null, (user && user.username) || 'system', isTemp
  );
  if (isTemp) {
    _db().prepare("UPDATE firewall_rules SET expires_at = datetime('now', ?) WHERE id = ?")
      .run(`+${mins} minutes`, info.lastInsertRowid);
  }
  const rule = _db().prepare('SELECT * FROM firewall_rules WHERE id = ?').get(info.lastInsertRowid);
  return { ok: true, rule, backend: backendName };
}

// Host-side removal only (build + run/agent). Caller updates the DB.
async function _hostRemove(host, row) {
  if (host.channel === 'agent') {
    const r = await runner.agentRequest(host.agentCfg, '/remove', { rule: row });
    if (r && r.ok === false) throw new Error(r.error || 'agent remove failed');
    return;
  }
  const be = backends.get(row.backend);
  if (!be) throw new Error(`Unknown backend "${row.backend}"`);
  const res = await runner.runCommands(host, be.buildRemove(row).commands, { timeoutMs: 20000 });
  if (res.exitCode !== 0) throw new Error(res.stderr || `remove failed (exit ${res.exitCode})`);
}

// Remove expired temporary rules from every host. Best-effort; a host that's
// unreachable leaves its rule active and it's retried next cycle. Called on an
// interval from server.js.
async function cleanupExpired() {
  const rows = _db().prepare(
    "SELECT * FROM firewall_rules WHERE is_active = 1 AND is_temporary = 1 AND expires_at IS NOT NULL AND expires_at <= datetime('now')"
  ).all();
  if (!rows.length) return { removed: 0 };
  const auditService = require('../audit');
  const byHost = {};
  for (const r of rows) (byHost[r.host_id] = byHost[r.host_id] || []).push(r);
  let removed = 0;
  for (const hid of Object.keys(byHost)) {
    let host;
    try { host = _resolveHost(parseInt(hid, 10)); } catch { continue; }
    for (const row of byHost[hid]) {
      try {
        await _hostRemove(host, row);
        _db().prepare("UPDATE firewall_rules SET is_active = 0, removed_by = 'system-expiration', removed_at = datetime('now') WHERE id = ?").run(row.id);
        auditService.log({ action: 'firewall_expire_rule', targetType: 'firewall', targetId: String(hid), details: { rule_uuid: row.rule_uuid, backend: row.backend }, username: 'system' });
        removed++;
      } catch { /* leave active; retry next cycle */ }
    }
  }
  return { removed };
}

// Extend (or set) a rule's expiry from now.
async function extendRule(hostId, uuid, minutes, _user) {
  const mins = parseInt(minutes, 10);
  if (!validateExpiryMinutes(mins)) throw new Error('minutes must be 1..10080');
  const row = _db().prepare('SELECT id FROM firewall_rules WHERE host_id = ? AND rule_uuid = ? AND is_active = 1').get(hostId, uuid);
  if (!row) throw new Error('Rule not found');
  _db().prepare("UPDATE firewall_rules SET is_temporary = 1, expires_at = datetime('now', ?) WHERE id = ?").run(`+${mins} minutes`, row.id);
  return { ok: true, rule_uuid: uuid };
}

async function removeRule(hostId, uuid, user) {
  const row = _db().prepare('SELECT * FROM firewall_rules WHERE host_id = ? AND rule_uuid = ? AND is_active = 1').get(hostId, uuid);
  if (!row) throw new Error('Rule not found (or already removed)');
  const host = _resolveHost(hostId);
  try { await snapshot(hostId, user, 'pre-remove'); } catch { /* ignore */ }
  await _hostRemove(host, row);
  _db().prepare('UPDATE firewall_rules SET is_active = 0, removed_by = ?, removed_at = datetime(\'now\') WHERE id = ?')
    .run((user && user.username) || 'system', row.id);
  return { ok: true, rule_uuid: uuid };
}

// MVP1 rollback: iptables only (iptables-restore). Other backends store the
// snapshot for manual restore and report that automated rollback lands in MVP2.
async function rollback(hostId, snapshotId, user) {
  const snap = _db().prepare('SELECT * FROM firewall_snapshots WHERE id = ? AND host_id = ?').get(snapshotId, hostId);
  if (!snap) throw new Error('Snapshot not found');
  const host = _resolveHost(hostId);
  if (snap.backend !== 'iptables') {
    throw new Error(`Automated rollback for "${snap.backend}" is not available yet (MVP2). The snapshot is stored for manual restore.`);
  }
  const b64 = Buffer.from(snap.snapshot_content || '', 'utf8').toString('base64');
  const cmd = { bin: 'sh', argv: ['-c', `printf %s '${b64}' | base64 -d | iptables-restore`] };
  const res = await runner.runCommands(host, [cmd], { timeoutMs: 20000 });
  if (res.exitCode !== 0) throw new Error(res.stderr || `rollback failed (exit ${res.exitCode})`);
  // Deactivate app rules created after this snapshot (host state was reset).
  _db().prepare('UPDATE firewall_rules SET is_active = 0, removed_by = ?, removed_at = datetime(\'now\') WHERE host_id = ? AND is_active = 1 AND created_at > ?')
    .run((user && user.username) || 'system', hostId, snap.created_at);
  return { ok: true, snapshotId };
}

module.exports = { detectBackend, listRules, applyRule, removeRule, snapshot, rollback, cleanupExpired, extendRule, reconcile, _internals: { _resolveHost, _detect, _hostRemove } };
