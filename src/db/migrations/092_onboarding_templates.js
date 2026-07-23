'use strict';

// v8.16.0 (Onboarding & Provisioning Wizard — Phase 2) — Onboarding templates.
//
// A template pre-fills a declaration: modules, regional defaults, nomenclatures,
// suggested roles/users shape and free-text notes. Two provenances:
//
//   is_builtin = 1  — authored as a JSON file under src/db/onboarding-templates/
//                     and UPSERTed at startup by
//                     src/services/provisioning/templates.js (howto-loader
//                     pattern). The FILE is the source of truth: it overrides the
//                     DB row on every boot.
//   is_builtin = 0  — custom, created through POST /api/onboarding/templates
//                     ("save as template" from a declaration, secrets stripped).
//
// `key` is the PRIMARY KEY (TEXT) so the loader's UPSERT target is the natural
// key and a custom template can never shadow a built-in one.
//
// spec_json is validated by validateTemplateSpec() before every write (whitelist,
// proto-pollution guard, bounded sizes) — templates are untrusted input too, even
// the file-authored ones (defense in depth, plans/onboarding-security.md §C6/T8).

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS onboarding_templates (
      key         TEXT PRIMARY KEY,              -- stable identifier, referenced by declaration.template
      name        TEXT NOT NULL,
      description TEXT,
      industry    TEXT,
      version     TEXT NOT NULL DEFAULT '1.0.0', -- semver, authored in the file
      spec_json   TEXT NOT NULL,                 -- validated prefill: modules/regional/nomenclatures/roles/users/notes
      is_builtin  INTEGER NOT NULL DEFAULT 0,    -- 1 = file-authored (file overrides DB), 0 = custom
      created_by  TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_onboarding_templates_builtin ON onboarding_templates(is_builtin);
  `);
};
