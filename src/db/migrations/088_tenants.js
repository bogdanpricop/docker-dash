'use strict';

// v8.15.0 (Onboarding & Provisioning Wizard — Phase 1 backend) — Tenant seam.
//
// Introduces the tenant model as a LOGICAL grouping + audit targetType, NOT a
// hard security boundary (see SECURITY.md "Known Security Tradeoffs" and
// plans/onboarding-security.md §C1). Existing single-tenant features keep
// working unchanged: `tenant_id` appears ONLY on these NEW tables — no retrofit
// of any existing table, no query-scoping middleware. The default tenant
// (id=1) is auto-seeded so the flat global pool everything reads today is
// simply "the default tenant".
//
// Tables:
//   tenants          — the tenant registry (+ partial unique index: one default)
//   tenant_settings  — EAV per-tenant config (regional keys land here)
//   user_tenants     — associate users to tenants WITHOUT altering `users`
//                      (shared user pool; absence of a row = default membership)
//
// CHECK-constrained enums (kind/usage_mode/status/role) are stable domains, so
// CHECK is safe; a growing domain (module_key, see 090) is validated in-service
// instead because SQLite can't ALTER a CHECK.

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      slug           TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      name           TEXT    NOT NULL,
      kind           TEXT    NOT NULL DEFAULT 'internal'
                              CHECK(kind IN ('client','plant','internal')),
      usage_mode     TEXT    NOT NULL DEFAULT 'production'
                              CHECK(usage_mode IN ('demo','trial','production')),
      status         TEXT    NOT NULL DEFAULT 'active'
                              CHECK(status IN ('active','provisioning','suspended')),
      is_default     INTEGER NOT NULL DEFAULT 0,
      trial_expires_at TEXT,
      created_by     TEXT,
      created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- At most one default tenant. Partial unique index only indexes is_default=1
    -- rows, so it enforces the singleton without constraining the many 0-rows.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_one_default
      ON tenants(is_default) WHERE is_default = 1;

    CREATE TABLE IF NOT EXISTS tenant_settings (
      tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      key        TEXT    NOT NULL,
      value      TEXT,
      updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tenant_id, key)              -- upsert target ON CONFLICT(tenant_id,key)
    );

    CREATE TABLE IF NOT EXISTS user_tenants (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      role       TEXT    NOT NULL DEFAULT 'viewer'
                          CHECK(role IN ('admin','operator','viewer')),
      is_owner   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, tenant_id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_tenants_tenant ON user_tenants(tenant_id);
  `);

  // Default-tenant seed. Fixed id=1 → code references DEFAULT_TENANT_ID = 1.
  // usage_mode='production' so existing installs are treated as production
  // (real connectivity, no synthetic data). No user_tenants seed here —
  // seedAdmin() runs AFTER migrations, and absence of a membership row is
  // defined to mean "member of the default tenant" (no backfill race).
  db.prepare(`
    INSERT OR IGNORE INTO tenants (id, slug, name, kind, usage_mode, status, is_default, created_by)
    VALUES (1, 'default', 'Default', 'internal', 'production', 'active', 1, 'system')
  `).run();
};
