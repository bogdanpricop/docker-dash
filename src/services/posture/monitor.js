'use strict';

// v8.9.40-alpha.1 — posture regression monitor. On each tick it scans, compares
// the global score/criticals to the PREVIOUS snapshot (delta, not a fixed
// baseline — so a persistent problem doesn't re-alert every cycle), raises an
// in-app notification + audit if it worsened, then stores the new snapshot.

function _db() { return require('../../db').getDb(); }

async function tick() {
  const posture = require('./index');
  let prev = null;
  try { prev = _db().prepare("SELECT score, critical FROM posture_snapshots WHERE host_id IS NULL ORDER BY captured_at DESC LIMIT 1").get(); } catch { /* first run */ }

  const r = await posture.scan();

  if (prev) {
    const critUp = (r.global.counts.critical || 0) - (prev.critical || 0);
    const scoreDrop = (prev.score || 100) - (r.global.score || 100);
    if (critUp > 0 || scoreDrop >= 10) {
      try {
        const { notifications } = require('../misc');
        notifications.create({
          userId: null, type: 'warning',
          title: 'Security posture regressed',
          message: `Estate score ${prev.score} → ${r.global.score}${critUp > 0 ? `, +${critUp} critical finding(s)` : ''}. Review Security → Posture.`,
          link: '#/posture',
        });
        require('../audit').log({ action: 'posture_regression', targetType: 'posture', targetId: 'estate', details: { from: prev.score, to: r.global.score, critUp }, username: 'system' });
      } catch { /* best-effort */ }
    }
  }

  try { posture.snapshot(r); } catch { /* best-effort */ }
  return r;
}

function start(intervalMs = 15 * 60 * 1000) {
  const t = setInterval(() => { tick().catch(() => {}); }, intervalMs);
  t.unref();
  setTimeout(() => { tick().catch(() => {}); }, 60 * 1000).unref(); // first run after boot settles
  return t;
}

module.exports = { tick, start };
