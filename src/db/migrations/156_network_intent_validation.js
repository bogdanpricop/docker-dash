'use strict';

// B125 — immutable cross-resource network intent validation evidence.
exports.up = function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS network_intent_validations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_key TEXT NOT NULL,
      intent_version TEXT NOT NULL,
      intent_json TEXT NOT NULL,
      findings_json TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      verdict TEXT NOT NULL CHECK(verdict IN ('pass','fail','unknown')),
      intent_hash TEXT NOT NULL,
      validation_hash TEXT NOT NULL UNIQUE,
      provider_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutations_started=0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_network_intent_validation_scope
      ON network_intent_validations(scope_key, created_at DESC);
  `);
};

exports.down = function down() {};
