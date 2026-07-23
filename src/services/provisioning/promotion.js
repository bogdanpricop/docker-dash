'use strict';

// v8.17.0 (Onboarding — Phase 3) — the demo/trial → production PROMOTION GATE.
//
// This is the OUTBOUND half of the two-sided lock described in
// plans/onboarding-security.md C4 / TC-03:
//   * inbound  — `seed.generate()` refuses to write synthetic rows into a
//                `usage_mode='production'` tenant (seed/index.js assertSeedable);
//   * outbound — `assertProductionReady()` refuses to MAKE a tenant production
//                while any live synthetic batch or placeholder credential exists.
// Neither guard depends on the other, so defeating one still leaves the estate
// safe: fake hosts/containers/alerts can never become indistinguishable from real
// operational data, and a generated placeholder credential can never be trusted
// as a real one.
//
// The gate is a SERVER-SIDE checklist that returns a structured remediation list
// (mirroring the `server.js` production boot-guard style: refuse AND tell the
// operator exactly how to fix it) — never a client-only check.

const { getDb } = require('../../db');
const auditService = require('../audit');
const seed = require('./seed');

/** Thrown when a tenant cannot be promoted. Carries the remediation list. */
class PromotionBlockedError extends Error {
  constructor(message, blockers) {
    super(message);
    this.name = 'PromotionBlockedError';
    this.status = 409;
    this.code = 'PROMOTION_BLOCKED';
    this.blockers = blockers;
  }
}

// Credential-bearing tables whose synthetic rows are, by construction, PLACEHOLDER
// secrets (fake strings written through the real crypto path). A tagged row in any
// of them is a `is_placeholder=1` secret in the security model's terms.
const PLACEHOLDER_SECRET_TABLES = [
  { table: 'docker_hosts', label: 'host SSH/daemon credentials' },
  { table: 'registries', label: 'registry credentials' },
  { table: 'blueprints', label: 'blueprint GitOps tokens' },
];

/**
 * Evaluate production-readiness WITHOUT throwing.
 * @returns {{ok:boolean, tenantId:number, usageMode:string, blockers:{code:string,message:string,remediation:string,detail?:object}[]}}
 */
function checkProductionReady(tenantId, { db: dbOverride } = {}) {
  const db = dbOverride || getDb();
  const tenant = db.prepare('SELECT id, slug, name, usage_mode FROM tenants WHERE id = ?').get(tenantId);
  if (!tenant) { const e = new Error(`tenant ${tenantId} not found`); e.status = 404; throw e; }

  const blockers = [];

  // 1. Any LIVE seed batch (status='active') for this tenant.
  const live = db.prepare(
    "SELECT id, profile, scenario, row_count FROM seed_datasets WHERE tenant_id = ? AND status = 'active' ORDER BY id",
  ).all(tenantId);
  if (live.length) {
    blockers.push({
      code: 'live_seed_batch',
      message: `${live.length} synthetic dataset(s) are still live for this tenant `
        + `(${live.reduce((s, d) => s + d.row_count, 0)} tagged rows).`,
      remediation: 'Purge the demo data (Summary → Purge demo data, or POST /api/onboarding/tenants/:id/seed/purge) before promoting.',
      detail: { datasets: live.map((d) => ({ id: d.id, profile: d.profile, scenario: d.scenario, rows: d.row_count })) },
    });
  }

  // 2. Any PLACEHOLDER credential left behind (a tagged row in a secret-bearing
  //    table). Normally implied by (1), but checked independently so a partially
  //    purged batch can never sneak a fake credential into production.
  // Scoped to THIS tenant's datasets — another tenant's demo batch must never
  // block an unrelated tenant's promotion.
  const placeholders = [];
  for (const { table, label } of PLACEHOLDER_SECRET_TABLES) {
    let row;
    try {
      row = db.prepare(`
        SELECT COUNT(*) AS c FROM ${table}
        WHERE seed_run_id IN (SELECT id FROM seed_datasets WHERE tenant_id = ?)
      `).get(tenantId);
    } catch { continue; } // table/column absent on this install
    if (row && row.c) placeholders.push({ table, label, count: row.c });
  }
  if (placeholders.length) {
    blockers.push({
      code: 'placeholder_secret',
      message: `Generated placeholder credentials still exist (${placeholders.map((p) => `${p.count} ${p.label}`).join(', ')}).`,
      remediation: 'Purge the synthetic rows and register real hosts/registries with real credentials before promoting.',
      detail: { placeholders },
    });
  }

  return { ok: blockers.length === 0, tenantId, usageMode: tenant.usage_mode, tenantSlug: tenant.slug, blockers };
}

/**
 * Throwing form. Call this from EVERY path that would set a tenant's usage_mode
 * to 'production'.
 * @throws {PromotionBlockedError} with `.blockers` = the remediation list
 */
function assertProductionReady(tenantId, opts = {}) {
  const result = checkProductionReady(tenantId, opts);
  if (!result.ok) {
    throw new PromotionBlockedError(
      `tenant "${result.tenantSlug}" cannot be switched to production: `
      + result.blockers.map((b) => b.message).join(' '),
      result.blockers,
    );
  }
  return result;
}

/**
 * The ONLY sanctioned mutator of `tenants.usage_mode`. Runs the gate whenever the
 * target mode is 'production' and audits every transition.
 * @returns {{tenantId:number, from:string, to:string, changed:boolean}}
 */
function setUsageMode(tenantId, mode, { user, ip, db: dbOverride } = {}) {
  const db = dbOverride || getDb();
  if (!['demo', 'trial', 'production'].includes(mode)) {
    const e = new Error(`invalid usage_mode ${JSON.stringify(mode)}`); e.status = 400; throw e;
  }
  const tenant = db.prepare('SELECT id, slug, usage_mode FROM tenants WHERE id = ?').get(tenantId);
  if (!tenant) { const e = new Error(`tenant ${tenantId} not found`); e.status = 404; throw e; }
  if (tenant.usage_mode === mode) return { tenantId, from: mode, to: mode, changed: false };

  if (mode === 'production') assertProductionReady(tenantId, { db }); // throws with remediation

  db.prepare("UPDATE tenants SET usage_mode = ?, updated_at = datetime('now') WHERE id = ?").run(mode, tenantId);
  auditService.log({
    userId: user && user.id,
    username: (user && user.username) || 'system',
    action: 'tenant_promote',
    targetType: 'tenant',
    targetId: String(tenantId),
    details: { slug: tenant.slug, from: tenant.usage_mode, to: mode, gatePassed: mode === 'production' },
    ip: ip || null,
  });
  return { tenantId, from: tenant.usage_mode, to: mode, changed: true };
}

/**
 * Convenience for the wizard's Summary action: purge every live batch, then
 * promote. Purging is itself audited by the routes/step that call it, so this
 * only wraps the ordering.
 */
function purgeAndPromote(tenantId, { user, ip, db: dbOverride } = {}) {
  const db = dbOverride || getDb();
  const purged = seed.purgeAll(tenantId, { db });
  const result = setUsageMode(tenantId, 'production', { user, ip, db });
  return { ...result, purged: purged.purged, purgedRows: purged.total };
}

module.exports = {
  checkProductionReady, assertProductionReady, setUsageMode, purgeAndPromote,
  PromotionBlockedError, PLACEHOLDER_SECRET_TABLES,
};
