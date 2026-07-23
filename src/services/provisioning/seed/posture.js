'use strict';

// v8.17.0 (Onboarding — Phase 3) — synthetic posture score trend + mutes.
//
// 081 deliberately does NOT persist findings (they are computed live so they can
// never drift from reality) — only score SNAPSHOTS (the trend sparkline) and
// MUTES. This module honours that: it seeds a believable daily score series per
// host plus a global rollup (host_id NULL), biased by the scenario so
// `busy-estate` visibly DIPS as its critical finding appears.

const { POSTURE_CHECKS } = require('./words');
const { sha256 } = require('../../../utils/crypto');

function _grade(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

function generate(ctx) {
  const { db, rng, datasetId, profile, scenario, refs } = ctx;
  if (!refs.hosts.length) return { count: 0 };

  const ins = db.prepare(`
    INSERT INTO posture_snapshots (host_id, score, grade, critical, high, medium, low, captured_at, seed_run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Spread the snapshot budget over a daily series; the last third carries the
  // scenario's drift so the sparkline tells the story.
  const total = profile.postureSnapshots;
  const series = Math.max(4, Math.ceil(total / (refs.hosts.length + 1)));
  const targets = [null, ...refs.hosts.map((h) => h.id)];   // null = global rollup
  let count = 0;

  outer:
  for (const hostId of targets) {
    for (let d = series - 1; d >= 0; d--) {
      if (count >= total) break outer;
      const progress = 1 - (d / Math.max(1, series - 1));
      const drifted = scenario.postureBase + scenario.postureDrift * progress;
      const score = Math.max(5, Math.min(100, Math.round(rng.gaussian(drifted, 2.5))));
      // Critical/high only materialise once the trend has drifted far enough.
      const critical = progress > 0.66 ? scenario.criticalFindings : 0;
      const high = progress > 0.4 ? scenario.highFindings : Math.max(0, scenario.highFindings - 1);
      ins.run(
        hostId, score, _grade(score), critical, high,
        rng.int(1, 5), rng.int(2, 9),
        ctx.toSqlTime(ctx.nowMs - d * 864e5), datasetId,
      );
      count += 1;
    }
  }
  ctx.count('posture_snapshots', count);

  // ── mutes (accepted low findings) ─────────────────────────────────────────
  let mutes = 0;
  if (profile.postureMutes > 0) {
    const insMute = db.prepare(`
      INSERT OR IGNORE INTO posture_mutes (finding_key, host_id, check_id, reason, muted_by, created_at, expires_at, seed_run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const lows = POSTURE_CHECKS.filter((c) => c.severity === 'low' || c.severity === 'medium');
    for (let i = 0; i < profile.postureMutes; i++) {
      const h = rng.pick(refs.hosts);
      const check = lows[i % lows.length];
      const key = sha256(`seed:${datasetId}:${check.id}:${h.id}:${i}`);
      const r = insMute.run(
        key, h.id, check.id, `Accepted risk — ${check.title} (synthetic demo)`, 'demo-ops',
        ctx.toSqlTime(ctx.nowMs - rng.int(1, 40) * 864e5),
        rng.bool(0.4) ? ctx.toSqlTime(ctx.nowMs + rng.int(10, 120) * 864e5) : null,
        datasetId,
      );
      if (r.changes) mutes += 1;
    }
  }
  ctx.count('posture_mutes', mutes);
  return { count: count + mutes };
}

module.exports = { generate };
