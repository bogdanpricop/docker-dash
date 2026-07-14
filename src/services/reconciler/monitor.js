'use strict';

// v8.9.42-alpha.1 — Reconciler drift monitor. Every N min it plans each ACTIVE
// blueprint; if reality drifted (rules to create/remove), it raises a notification
// (delta-deduped per blueprint) + audit. If the blueprint has enforce=1 (opt-in),
// it auto-applies to converge. Best-effort, unref'd.

function _db() { return require('../../db').getDb(); }

// blueprintId -> last-alerted drift signature ('' = in sync)
const _lastDrift = new Map();

async function tick() {
  const rec = require('./index');
  let blueprints = [];
  try { blueprints = _db().prepare('SELECT id, name, enforce FROM blueprints WHERE is_active = 1').all(); } catch { return { checked: 0 }; }
  let alerted = 0;
  for (const bp of blueprints) {
    let full;
    try { full = rec.get(bp.id); } catch { continue; }
    if (!full || !full.doc) continue;
    let p;
    try { p = await rec.plan(full.doc); } catch { continue; }
    const drift = p.summary.create + p.summary.remove + (p.summary.containerStart || 0);
    const sig = `${p.summary.create}/${p.summary.remove}/${p.summary.containerStart || 0}`;
    const prev = _lastDrift.get(bp.id) || '';

    if (drift > 0) {
      if (bp.enforce) {
        try {
          const r = await rec.apply(full.doc, { username: 'system-enforce' });
          rec.recordRun(bp.id, 'apply', { enforce: true, applied: r.applied, removed: r.removed, failed: r.failed }, 'system-enforce');
          require('../audit').log({ action: 'blueprint_enforce_apply', targetType: 'blueprint', targetId: String(bp.id), details: { applied: r.applied, removed: r.removed, failed: r.failed }, username: 'system' });
        } catch { /* retry next cycle */ }
      } else if (sig !== prev) {
        try {
          const { notifications } = require('../misc');
          notifications.create({ userId: null, type: 'warning', title: `Blueprint drift: ${full.name}`, message: `Reality drifted from the blueprint — ${p.summary.create} to create, ${p.summary.remove} to remove. Review Reconciler.`, link: '#/blueprints' });
          require('../audit').log({ action: 'blueprint_drift', targetType: 'blueprint', targetId: String(bp.id), details: { create: p.summary.create, remove: p.summary.remove }, username: 'system' });
          rec.recordRun(bp.id, 'drift', p.summary, 'system');
          alerted++;
        } catch { /* best-effort */ }
      }
    }
    _lastDrift.set(bp.id, drift > 0 ? sig : '');
  }
  return { checked: blueprints.length, alerted };
}

function start(intervalMs = 15 * 60 * 1000) {
  const t = setInterval(() => { tick().catch(() => {}); }, intervalMs);
  t.unref();
  setTimeout(() => { tick().catch(() => {}); }, 90 * 1000).unref();
  return t;
}

module.exports = { tick, start };
