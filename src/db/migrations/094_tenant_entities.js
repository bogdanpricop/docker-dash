'use strict';

// v8.18.0 (Onboarding & Provisioning Wizard — Phase 4) — tenant entities & relations.
//
// A GENERIC, template-definable domain-entity model + relationships between
// entities. Deliberately data-model-agnostic (feature-spec §I step 6): the
// SAME two tables carry a homelab's Site→Host→Service, an MSP's
// Client→Environment→Stack, or a plant's Site→Department→Line — the shape is
// data, not schema. `entity_type` / `relation_type` are validated against a
// known set IN-SERVICE (catalog.js ENTITY_TYPES / RELATION_TYPES), NOT with a
// CHECK — the domain grows in code and SQLite cannot ALTER a CHECK (same
// rationale as tenant_modules.module_key, 090).
//
// ── The seed_run_id tag (identical mechanism to 093) ────────────────────────
// Both tables carry a NULLABLE `seed_run_id`. REAL rows (written by the
// seed_entities provisioning step from a template — real tenant config) are
// NULL; SYNTHETIC rows (the demo generator, seed/entities.js) are tagged with
// the batch id. Purge is `DELETE ... WHERE seed_run_id = ?` and `NULL = x` is
// never true in SQL, so a real entity is STRUCTURALLY unreachable by a purge.
// This mirrors `nomenclatures` exactly (both hold real template rows AND
// synthetic generator rows in the same table). Both tables are added to the
// SEED_TABLES allow-list (seed/tables.js) so the manifest-driven purge and the
// mock generator both know about them.
//
// Deliberately NO `REFERENCES seed_datasets(id)` on seed_run_id — same reason
// as 093: a RESTRICT-ing FK would turn a tenant delete (incl. a provisioning
// rollback) into a hard failure, and ON DELETE SET NULL would silently UNTAG a
// synthetic row (untagged synthetic == indistinguishable from real). Integrity
// is enforced by the static SEED_TABLES allow-list instead.
//
// FK direction check: 094 → tenants (088) + tenant_entity_relations → tenant_entities
// (same file). All parents exist before children in ascending migration order. ✔

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_entities (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      entity_type  TEXT    NOT NULL,   -- validated in-service (catalog.ENTITY_TYPES)
      code         TEXT    NOT NULL,
      name         TEXT    NOT NULL,
      meta_json    TEXT,
      seed_run_id  INTEGER,            -- NULL = real; tagged = synthetic (see header)
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, entity_type, code)   -- upsert target; structural dedup
    );
    CREATE INDEX IF NOT EXISTS idx_tenant_entities_tenant_type ON tenant_entities(tenant_id, entity_type);
    -- Partial index: only synthetic rows are indexed, so it costs nothing on a
    -- real install (every real row is NULL and therefore absent from the index).
    CREATE INDEX IF NOT EXISTS idx_tenant_entities_seed_run ON tenant_entities(seed_run_id) WHERE seed_run_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS tenant_entity_relations (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id      INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      from_entity_id INTEGER NOT NULL REFERENCES tenant_entities(id) ON DELETE CASCADE,
      to_entity_id   INTEGER NOT NULL REFERENCES tenant_entities(id) ON DELETE CASCADE,
      relation_type  TEXT    NOT NULL,   -- validated in-service (catalog.RELATION_TYPES)
      meta_json      TEXT,
      seed_run_id    INTEGER,            -- NULL = real; tagged = synthetic
      created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, from_entity_id, to_entity_id, relation_type)  -- upsert / dedup target
    );
    CREATE INDEX IF NOT EXISTS idx_tenant_entity_relations_tenant ON tenant_entity_relations(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_tenant_entity_relations_seed_run ON tenant_entity_relations(seed_run_id) WHERE seed_run_id IS NOT NULL;
  `);
};
