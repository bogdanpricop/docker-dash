'use strict';

// v8.9.43-alpha.1 — cross-layer context assembler for the Ops Copilot. Gathers a
// BOUNDED, secret-free bundle from signals docker-dash already computes (posture
// scan, blueprint drift, host inventory, recent audit). This is the differentiator
// — the correlated context no SaaS can build without telemetry. Nothing here
// contains a password/key/token; only names, findings, versions, counts.

const log = require('../../utils/logger')('copilot');

function _db() { return require('../../db').getDb(); }

async function assemble() {
  const db = _db();
  const out = { generatedAt: new Date().toISOString(), findings: [], hosts: [], blueprints: [], recentAudit: [] };

  // Posture (score + top open findings) — reuse the aggregator.
  try {
    const scan = await require('../posture').scan();
    out.score = scan.global.score; out.grade = scan.global.grade; out.counts = scan.global.counts;
    const hostName = new Map((scan.hosts || []).map(h => [h.hostId, h.name]));
    out.findings = (scan.findings || []).filter(f => !f.muted).slice(0, 12).map(f => ({
      severity: f.severity, checkId: f.checkId, title: f.title,
      host: f.hostId != null ? (hostName.get(f.hostId) || `host ${f.hostId}`) : null,
      detail: f.detail,
      remediation: f.remediation ? { label: f.remediation.label, link: f.remediation.link } : null,
    }));
    out.hostScores = (scan.hosts || []).map(h => ({ name: h.name, grade: h.grade, score: h.score }));
  } catch (e) { log.debug('posture context failed', { error: e.message }); }

  // Host inventory (no secrets).
  try {
    out.hosts = db.prepare('SELECT name, daemon_type, connection_type FROM docker_hosts WHERE is_active = 1').all()
      .map(h => ({ name: h.name, type: h.daemon_type || 'docker', transport: h.connection_type }));
  } catch { /* ignore */ }

  // Blueprint (reconciler) drift.
  try {
    const rec = require('../reconciler');
    const bps = db.prepare('SELECT id, name FROM blueprints WHERE is_active = 1').all();
    for (const bp of bps) {
      try {
        const full = rec.get(bp.id);
        if (!full || !full.doc) continue;
        const p = await rec.plan(full.doc);
        if ((p.summary.create + p.summary.remove) > 0) out.blueprints.push({ name: bp.name, create: p.summary.create, remove: p.summary.remove });
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }

  // Recent activity (action names only — no payloads/secrets).
  try {
    out.recentAudit = db.prepare("SELECT action, target_type, username, created_at FROM audit_log ORDER BY created_at DESC LIMIT 15").all()
      .map(a => ({ action: a.action, target: a.target_type, by: a.username, at: a.created_at }));
  } catch { /* ignore */ }

  return out;
}

module.exports = { assemble };
