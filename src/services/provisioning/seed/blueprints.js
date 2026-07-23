'use strict';

// v8.17.0 (Onboarding — Phase 3) — a VALID synthetic estate-blueprint + run history.
//
// The doc is built to pass the reconciler's own `validateDoc()` unchanged
// (version:1, kind:'estate-blueprint', hosts keyed by REAL produced host ids,
// firewall rules that satisfy assertSafe — i.e. each constrains at least a source
// or a port — and containers restricted to `state:'running'` with names matching
// /^[\w.-]+$/). We validate through the reconciler itself rather than
// hand-rolling the shape, so the demo can never carry a doc the product rejects.
//
// `enforce` is ALWAYS 0: a synthetic blueprint must never auto-apply anything.

const { encrypt } = require('../../../utils/crypto');

function _buildDoc(ctx) {
  const { rng, refs, scenario } = ctx;
  const doc = { version: 1, kind: 'estate-blueprint', hosts: {} };
  const hosts = refs.hosts.slice(0, Math.min(6, refs.hosts.length));
  for (const h of hosts) {
    const running = (refs.running || []).filter((c) => c.hostId === h.id).slice(0, 5);
    // `busy-estate`/`multi-daemon-plant` deliberately declare MORE than reality so
    // the drift run has something to report.
    const declared = scenario.blueprintDrift ? running : running.slice(0, Math.max(1, running.length - 1));
    doc.hosts[String(h.id)] = {
      firewall: [
        { action: 'allow', scope: 'docker', source_ip: rng.rfc1918Cidr(), destination_port: 443, protocol: 'tcp', reason: 'Baseline HTTPS from internal' },
        { action: 'block', scope: 'host', source_ip: rng.testNetCidr(), destination_port: 22, protocol: 'tcp', reason: 'Block SSH from partner range' },
      ],
      containers: declared.map((c) => ({ name: c.name, state: 'running' })),
    };
  }
  return doc;
}

function generate(ctx) {
  const { db, rng, datasetId, profile, scenario, org, refs } = ctx;
  if (!refs.hosts.length) return { count: 0 };

  const { validateDoc } = require('../../reconciler');
  const insBp = db.prepare(`
    INSERT INTO blueprints (name, description, doc, enforce, is_active, created_by, created_at, updated_at,
                            last_plan_at, source_url, source_token_enc, source_auto_sync, seed_run_id)
    VALUES (?, ?, ?, 0, 1, 'demo-ops', ?, ?, ?, ?, ?, 0, ?)
  `);
  const insRun = db.prepare(
    'INSERT INTO blueprint_runs (blueprint_id, kind, summary, by, at, seed_run_id) VALUES (?, ?, ?, ?, ?, ?)',
  );

  let bpCount = 0;
  let runCount = 0;
  const runKinds = ['plan', 'apply', 'drift'];
  for (let i = 0; i < profile.blueprints; i++) {
    const doc = validateDoc(_buildDoc(ctx));   // throws if we ever emit an invalid doc
    const createdAt = rng.dateBetween(ctx.nowMs - 120 * 864e5, ctx.nowMs - 20 * 864e5);
    const bpId = Number(insBp.run(
      i === 0 ? `${org.name} estate baseline` : `${org.name} ${rng.pick(['edge', 'plant', 'core'])} baseline`,
      'Synthetic demo blueprint — safe to purge.',
      JSON.stringify(doc), createdAt, createdAt,
      ctx.toSqlTime(ctx.nowMs - rng.int(1, 6) * 864e5),
      // `.invalid` (RFC 6761) — a deliberately unresolvable sync source.
      `https://gitops.${org.slug}.invalid/blueprints/estate.json`,
      encrypt(`placeholder-gitops-token-${rng.hex(10)}`),
      datasetId,
    ).lastInsertRowid);
    bpCount += 1;

    const runsPerBp = Math.max(1, Math.floor(profile.blueprintRuns / profile.blueprints));
    for (let r = 0; r < runsPerBp; r++) {
      const kind = runKinds[r % runKinds.length];
      const summary = kind === 'drift' && scenario.blueprintDrift
        ? { create: rng.int(1, 4), remove: rng.int(0, 2), inSync: rng.int(3, 12), containerMissing: rng.int(0, 2) }
        : { create: 0, remove: 0, inSync: rng.int(4, 14), containerStart: 0 };
      insRun.run(bpId, kind, JSON.stringify(summary), 'demo-ops',
        ctx.toSqlTime(ctx.nowMs - rng.int(1, 30) * 864e5), datasetId);
      runCount += 1;
    }
  }

  ctx.count('blueprints', bpCount);
  ctx.count('blueprint_runs', runCount);
  return { count: bpCount + runCount };
}

module.exports = { generate };
