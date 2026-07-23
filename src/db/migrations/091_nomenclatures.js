'use strict';

// v8.16.0 (Onboarding & Provisioning Wizard — Phase 2) — Per-tenant nomenclatures.
//
// Nomenclatures are the small per-tenant lookup lists an environment needs on day
// one: regions, currencies, units, industries, plant types, environments,
// severities. Templates pre-fill them; the `seed_nomenclatures` provisioning step
// upserts them by the natural key (tenant_id, kind, code) so a re-applied
// declaration converges instead of duplicating.
//
// `kind` is deliberately NOT CHECK-constrained — the set of kinds grows in code
// (src/services/provisioning/nomenclatures.js NOMENCLATURE_KINDS, same rationale
// as tenant_modules.module_key in 090: SQLite can't ALTER a CHECK). The service
// validates it at write time.
//
// NOTE (Phase 3): the synthetic-row tag column `seed_run_id` is deliberately NOT
// added here. Migration 093 adds it uniformly, PRAGMA-guarded, to every seedable
// table at once (see plans/onboarding-architecture.md §1.6/§1.7) so the tagging
// mechanism has exactly one definition site.

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nomenclatures (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      kind       TEXT    NOT NULL,   -- region|currency|unit|industry|plant_type|environment|severity|...
      code       TEXT    NOT NULL,
      label      TEXT    NOT NULL,
      sort       INTEGER NOT NULL DEFAULT 0,
      meta_json  TEXT,
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, kind, code)   -- upsert target ON CONFLICT(tenant_id, kind, code)
    );
    CREATE INDEX IF NOT EXISTS idx_nomenclatures_tenant_kind ON nomenclatures(tenant_id, kind);
  `);
};
