'use strict';

// Step 3 — seed_nomenclatures (kind: db). v8.16.0, Phase 2.
//
// Upserts the declaration's nomenclatures[] (template defaults merged under the
// user's explicit entries — see template-merge.js) into `nomenclatures` for the
// run's tenant, keyed on the natural key UNIQUE(tenant_id, kind, code) so a
// re-applied declaration converges instead of duplicating.
//
// Compensation deletes ONLY the rows THIS run inserted. Rows that already
// existed (and were merely refreshed) are left alone — the checkpoint records
// the two sets separately, so rolling back a re-run can never remove a
// nomenclature that predates it. The cascade from create_tenant is still the
// backstop when the whole tenant goes away.

module.exports = {
  key: 'seed_nomenclatures',
  kind: 'db',

  run(ctx) {
    const { db, decl, tenantId } = ctx;
    const list = decl.nomenclatures || [];
    if (!list.length) return { tenantId, inserted: [], updated: 0 };

    const find = db.prepare('SELECT id FROM nomenclatures WHERE tenant_id = ? AND kind = ? AND code = ?');
    const upsert = db.prepare(`
      INSERT INTO nomenclatures (tenant_id, kind, code, label, sort, meta_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, kind, code) DO UPDATE SET
        label = excluded.label, sort = excluded.sort, meta_json = excluded.meta_json
    `);

    const inserted = [];
    let updated = 0;
    for (const n of list) {
      const pre = find.get(tenantId, n.kind, n.code);
      upsert.run(tenantId, n.kind, n.code, n.label, n.sort || 0, n.meta ? JSON.stringify(n.meta) : null);
      if (pre) updated += 1;
      else inserted.push({ kind: n.kind, code: n.code });
    }

    ctx.audit('nomenclature_seed', 'tenant', String(tenantId), {
      total: list.length, inserted: inserted.length, updated,
    });
    return { tenantId, inserted, updated };
  },

  compensate(ctx, cp) {
    const { db } = ctx;
    const tenantId = (cp && cp.tenantId) || ctx.tenantId;
    const inserted = (cp && cp.inserted) || [];
    if (!tenantId || !inserted.length) return;
    const del = db.prepare('DELETE FROM nomenclatures WHERE tenant_id = ? AND kind = ? AND code = ?');
    for (const n of inserted) del.run(tenantId, n.kind, n.code); // idempotent: a second pass deletes nothing
  },

  estimate(ctx) {
    const list = (ctx.decl && ctx.decl.nomenclatures) || [];
    return { nomenclatures: list.length };
  },
};
