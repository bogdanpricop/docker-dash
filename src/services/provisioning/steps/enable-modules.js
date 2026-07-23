'use strict';

// Step 3 — enable_modules (kind: db).
//
// Upserts tenant_modules for the DEPENDENCY-CLOSED set of requested modules
// (enabling `firewall` auto-enables `hosts`). module_key is validated against
// MODULE_CATALOG in-service (the column is not CHECK-constrained). No explicit
// compensation — cascades via create_tenant on rollback.

const catalog = require('../catalog');

function _requestedKeys(decl) {
  return (decl.modules || []).filter((m) => m.enabled !== false).map((m) => m.key);
}

module.exports = {
  key: 'enable_modules',
  kind: 'db',

  run(ctx) {
    const { db, decl, tenantId } = ctx;
    const closure = catalog.resolveDependencies(_requestedKeys(decl)); // throws on unknown key
    const up = db.prepare(`
      INSERT INTO tenant_modules (tenant_id, module_key, enabled, updated_at)
      VALUES (?, ?, 1, datetime('now'))
      ON CONFLICT(tenant_id, module_key) DO UPDATE SET enabled = 1, updated_at = datetime('now')
    `);
    for (const k of closure) up.run(tenantId, k);
    if (closure.length) ctx.audit('tenant_update', 'tenant', String(tenantId), { modules: closure });
    return { modules: closure };
  },

  estimate(ctx) {
    try {
      return { modules: catalog.resolveDependencies(_requestedKeys(ctx.decl)).length };
    } catch {
      return { modules: 0 };
    }
  },
};
