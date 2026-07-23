'use strict';

// Step 7 — finalize (kind: db).
//
// Flips the tenant from 'provisioning' to 'active'. No explicit compensation —
// on rollback the whole tenant is cascade-deleted by create_tenant's
// compensation, so there is nothing to revert here. The run-level result_json
// summary is assembled by the engine after finalize completes.

module.exports = {
  key: 'finalize',
  kind: 'db',

  run(ctx) {
    const { db, tenantId } = ctx;
    db.prepare("UPDATE tenants SET status = 'active', updated_at = datetime('now') WHERE id = ?").run(tenantId);
    ctx.audit('tenant_update', 'tenant', String(tenantId), { status: 'active' });
    return { tenantActivated: true };
  },

  estimate() {
    return {};
  },
};
