'use strict';

// v8.15.0 (Onboarding & Provisioning Wizard — Phase 1 backend) — Per-tenant module enablement.
//
// Which app modules a tenant has switched on. `module_key` is deliberately NOT
// CHECK-constrained — the enable-able catalog grows in code
// (src/services/provisioning/catalog.js, mirrors audit-actions-list.js) and
// SQLite cannot ALTER a CHECK without the writable_schema dance. The service
// validates module_key against MODULE_CATALOG at write time
// (see plans/onboarding-architecture.md §1.3 / §4.1).

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_modules (
      tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      module_key  TEXT    NOT NULL,        -- validated against MODULE_CATALOG in the service, NOT CHECK
      enabled     INTEGER NOT NULL DEFAULT 1,
      config_json TEXT,                    -- module-specific JSON config
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tenant_id, module_key)  -- upsert target ON CONFLICT(tenant_id, module_key)
    );
  `);
};
