'use strict';

// Step 2 — set_regional (kind: db).
//
// Writes the regional quartet + format keys to tenant_settings (EAV), upserted
// by (tenant_id, key). No explicit compensation — the rows are tenant-owned and
// unwind via the create_tenant cascade on rollback.

// camelCase declaration key → snake_case tenant_settings key.
const KEY_MAP = {
  locale: 'locale',
  timezone: 'timezone',
  currency: 'currency',
  unitSystem: 'unit_system',
  dateFormat: 'date_format',
  numberFormat: 'number_format',
};

module.exports = {
  key: 'set_regional',
  kind: 'db',

  run(ctx) {
    const { db, decl, tenantId } = ctx;
    const r = decl.regional || {};
    const up = db.prepare(`
      INSERT INTO tenant_settings (tenant_id, key, value, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `);
    const written = [];
    for (const [camel, snake] of Object.entries(KEY_MAP)) {
      if (r[camel] !== undefined) {
        up.run(tenantId, snake, String(r[camel]));
        written.push(snake);
      }
    }
    if (written.length) ctx.audit('tenant_update', 'tenant', String(tenantId), { regional: written });
    return { keys: written };
  },

  estimate(ctx) {
    const r = (ctx.decl && ctx.decl.regional) || {};
    return { settings: Object.keys(KEY_MAP).filter((k) => r[k] !== undefined).length };
  },
};
