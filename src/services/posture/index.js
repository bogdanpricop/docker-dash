'use strict';

// v8.9.37-alpha.1 — Security Posture service. Runs the check registry across the
// active estate, dedupes + scores the findings (weighted penalty → 0-100 + A-F),
// applies acknowledgements (mutes), and stores a score snapshot per scan for the
// trend. Findings are computed LIVE and never persisted.

const crypto = require('crypto');
const log = require('../../utils/logger')('posture');

function _db() { return require('../../db').getDb(); }

const SEV_WEIGHT = { critical: 40, high: 20, medium: 8, low: 3, info: 0 };
const SEV_RANK = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };

function _key(f) {
  return crypto.createHash('sha256')
    .update(`${f.checkId}|${f.hostId == null ? '' : f.hostId}|${f.subject || ''}`)
    .digest('hex').slice(0, 16);
}

function _grade(score) {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 55) return 'C';
  if (score >= 35) return 'D';
  return 'F';
}

function _score(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  let penalty = 0;
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] || 0) + 1;
    penalty += SEV_WEIGHT[f.severity] || 0;
  }
  const score = Math.max(0, Math.min(100, 100 - penalty));
  return { score, grade: _grade(score), counts };
}

function _dedupe(findings) {
  const byKey = new Map();
  for (const f of findings) {
    const k = _key(f);
    const prev = byKey.get(k);
    if (!prev || (SEV_RANK[f.severity] || 0) > (SEV_RANK[prev.severity] || 0)) byKey.set(k, f);
  }
  return [...byKey.values()];
}

function _activeMuteKeys(db) {
  const rows = db.prepare("SELECT finding_key FROM posture_mutes WHERE expires_at IS NULL OR expires_at > datetime('now')").all();
  return new Set(rows.map(r => r.finding_key));
}

// Resolves to the host's daemon info, or null if it errors or takes too long.
const DAEMON_INFO_TIMEOUT_MS = 3000;
function _boundedInfo(hostId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), DAEMON_INFO_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    require('../docker').getInfo(hostId)
      .then((info) => { clearTimeout(timer); resolve(info); })
      .catch(() => { clearTimeout(timer); resolve(null); });
  });
}

async function scan() {
  const db = _db();
  const hosts = db.prepare('SELECT * FROM docker_hosts WHERE is_active = 1').all();
  // Per-scan firewall cache so fw-drift and fw-exposed-port share ONE listRules
  // (SSH) call per host instead of two.
  const _fwCache = new Map();
  // v8.94.0 — same idea for daemon info: the isolation check needs the host's
  // registered OCI runtimes, and any future check that wants `docker info`
  // should share the one call rather than adding another round trip per host.
  const _infoCache = new Map();
  const ctx = {
    db, hosts, log,
    firewall: {
      async info(hostId) {
        if (!_fwCache.has(hostId)) {
          try { _fwCache.set(hostId, await require('../firewall').listRules(hostId)); }
          catch { _fwCache.set(hostId, null); }
        }
        return _fwCache.get(hostId);
      },
    },
    docker: {
      // Bounded and best-effort. `docker info` against an unreachable daemon can
      // sit for a long time, and this scan feeds the Copilot context, which has
      // its own latency budget — an unreachable host must degrade the scan, not
      // stall it. The promise is cached rather than the value so concurrent
      // checks share one call instead of racing to start their own.
      info(hostId) {
        if (!_infoCache.has(hostId)) _infoCache.set(hostId, _boundedInfo(hostId));
        return _infoCache.get(hostId);
      },
    },
  };
  const { ALL } = require('./checks');

  let findings = [];
  for (const chk of ALL) {
    try {
      const fs = await chk.run(ctx);
      if (Array.isArray(fs)) {
        for (const f of fs) findings.push({ ...f, category: f.category || chk.category });
      }
    } catch (e) { log.debug('posture check failed', { check: chk.id, error: e.message }); }
  }

  findings = _dedupe(findings);
  const muteKeys = _activeMuteKeys(db);
  findings = findings.map(f => ({ ...f, key: _key(f), muted: muteKeys.has(_key(f)) }))
    .sort((a, b) => (SEV_RANK[b.severity] || 0) - (SEV_RANK[a.severity] || 0));

  const open = findings.filter(f => !f.muted);
  const global = _score(open);
  const hostScores = hosts.map(h => {
    const hf = open.filter(f => f.hostId === h.id);
    return { hostId: h.id, name: h.name, daemonType: h.daemon_type || 'docker', ..._score(hf) };
  });

  return {
    global, hosts: hostScores, findings,
    coverage: { totalHosts: hosts.length },
    generatedAt: new Date().toISOString(),
  };
}

// Persist the score (global + per host) for the trend sparkline.
function snapshot(result) {
  const db = _db();
  const ins = db.prepare(`INSERT INTO posture_snapshots (host_id, score, grade, critical, high, medium, low)
    VALUES (?,?,?,?,?,?,?)`);
  const g = result.global;
  ins.run(null, g.score, g.grade, g.counts.critical, g.counts.high, g.counts.medium, g.counts.low);
  for (const h of result.hosts) {
    ins.run(h.hostId, h.score, h.grade, h.counts.critical, h.counts.high, h.counts.medium, h.counts.low);
  }
}

function trend(hostId, limit) {
  const db = _db();
  if (hostId == null) {
    return db.prepare('SELECT * FROM posture_snapshots WHERE host_id IS NULL ORDER BY captured_at DESC LIMIT ?').all(limit || 200).reverse();
  }
  return db.prepare('SELECT * FROM posture_snapshots WHERE host_id = ? ORDER BY captured_at DESC LIMIT ?').all(hostId, limit || 200).reverse();
}

function listMutes() {
  return _db().prepare('SELECT * FROM posture_mutes ORDER BY created_at DESC').all();
}

function mute({ findingKey, hostId, checkId, reason, user, minutes }) {
  if (!findingKey) throw new Error('findingKey is required');
  // datetime('now', NULL) yields NULL → a permanent mute; a modifier → expiring.
  let mod = null;
  if (minutes) { const m = parseInt(minutes, 10); if (Number.isInteger(m) && m > 0) mod = `+${m} minutes`; }
  _db().prepare(`INSERT INTO posture_mutes (finding_key, host_id, check_id, reason, muted_by, expires_at)
    VALUES (?,?,?,?,?, datetime('now', ?))
    ON CONFLICT(finding_key) DO UPDATE SET
      reason = excluded.reason, muted_by = excluded.muted_by, expires_at = excluded.expires_at, created_at = datetime('now')`)
    .run(findingKey, hostId ?? null, checkId ?? null, reason || null, (user && user.username) || 'system', mod);
  return { ok: true, findingKey };
}

function unmute(findingKey) {
  _db().prepare('DELETE FROM posture_mutes WHERE finding_key = ?').run(findingKey);
  return { ok: true, findingKey };
}

// One-click remediation dispatcher. Only SAFE actions are one-click — anything
// that could create exposure or lock out the admin stays guided (link-only).
// Currently: fw-reconcile (re-apply the admin's own drifted firewall rules).
async function remediate(action, user) {
  if (!action || typeof action !== 'object') throw new Error('action is required');
  switch (action.type) {
    case 'fw-reconcile': {
      const hostId = parseInt(action.hostId, 10);
      if (!hostId) throw new Error('hostId required');
      const r = await require('../firewall').reconcile(hostId, user);
      return { ok: true, action: action.type, result: r };
    }
    default:
      throw new Error(`Unsupported remediation "${action.type}"`);
  }
}

module.exports = {
  scan, snapshot, trend, mute, unmute, listMutes, remediate,
  _internals: { _key, _grade, _score, _dedupe },
};
