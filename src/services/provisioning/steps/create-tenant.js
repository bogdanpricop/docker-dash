'use strict';

// Step 1 — create_tenant (kind: db, the saga PIVOT).
//
// Inserts the tenants row (status='provisioning'; finalize flips it to 'active').
// Natural-key idempotency on slug: a re-run adopts the existing tenant instead
// of duplicating. Compensation is the big cascade — DELETE the tenant, whose
// ON DELETE CASCADE unwinds all tenant-owned state (tenant_settings,
// tenant_modules, user_tenants). It REFUSES is_default=1 (the default tenant can
// never be deleted by rollback) and never deletes a tenant that pre-existed the run.
//
// v8.18.0 (Phase 4) — a `trial` tenant gets a `trial_expires_at` set here at
// creation (DD_TRIAL_DAYS env, default 14 days out). The trial-monitor sweeps
// expired trials to `suspended`; extend-trial / promote-to-production reactivate.

/** Trial length in days (DD_TRIAL_DAYS, default 14). */
function _trialDays() {
  const n = parseInt(process.env.DD_TRIAL_DAYS, 10);
  return Number.isFinite(n) && n > 0 ? n : 14;
}

module.exports = {
  key: 'create_tenant',
  kind: 'db',

  run(ctx) {
    const { db, decl } = ctx;
    const t = decl.tenant;
    const createdBy = (ctx.user && ctx.user.username) || 'system';

    const existing = db.prepare('SELECT id, is_default, usage_mode FROM tenants WHERE slug = ? COLLATE NOCASE').get(t.slug);
    let tenantId;
    let created;
    if (existing) {
      tenantId = existing.id;
      created = false;
      // Idempotent re-apply: refresh name/kind but NEVER touch is_default/status here.
      db.prepare("UPDATE tenants SET name = ?, kind = ?, updated_at = datetime('now') WHERE id = ?")
        .run(t.name, t.kind, tenantId);
      // v8.17.0 (Phase 3) — a re-apply that CHANGES the mode of an existing tenant
      // is a mode transition, so it must go through the one guarded mutator. When
      // the target is `production` the promotion gate refuses while any live
      // synthetic batch or placeholder credential exists (security C4 / TC-03).
      if (existing.usage_mode !== decl.mode) {
        require('../promotion').setUsageMode(tenantId, decl.mode, { user: ctx.user, ip: ctx.ip, db });
      }
    } else {
      // A trial tenant is born with an expiry N days out; other modes leave it NULL.
      const trialExpires = decl.mode === 'trial'
        ? db.prepare(`SELECT datetime('now', '+${_trialDays()} days') AS t`).get().t
        : null;
      const r = db.prepare(`
        INSERT INTO tenants (slug, name, kind, usage_mode, status, is_default, trial_expires_at, created_by)
        VALUES (?, ?, ?, ?, 'provisioning', 0, ?, ?)
      `).run(t.slug, t.name, t.kind, decl.mode, trialExpires, createdBy);
      tenantId = Number(r.lastInsertRowid);
      created = true;
    }

    ctx.setTenantId(tenantId); // persists provisioning_runs.tenant_id in this same txn
    ctx.audit('tenant_create', 'tenant', String(tenantId), { slug: t.slug, name: t.name, kind: t.kind, created });
    return { tenantId, created };
  },

  compensate(ctx, cp) {
    const { db } = ctx;
    const id = cp && cp.tenantId;
    if (!id) return;
    const row = db.prepare('SELECT is_default FROM tenants WHERE id = ?').get(id);
    if (!row) return; // already gone — idempotent
    if (row.is_default) {
      // Hard guardrail (security C4): the default tenant is never deleted by rollback.
      throw new Error('refusing to delete default tenant (is_default=1)');
    }
    if (!cp.created) {
      ctx.log.warn('create_tenant compensate: tenant pre-existed the run, not deleting', { tenantId: id });
      return;
    }
    db.prepare('DELETE FROM tenants WHERE id = ? AND is_default = 0').run(id); // cascade unwinds owned children
  },

  estimate() {
    return { tenants: 1 };
  },
};
