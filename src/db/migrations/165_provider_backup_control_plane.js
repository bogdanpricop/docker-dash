'use strict';

exports.up = function (db) {
  const executionColumns = new Set(db.prepare('PRAGMA table_info(provider_backup_executions)').all().map(row => row.name));
  const itemColumns = new Set(db.prepare('PRAGMA table_info(provider_backup_execution_items)').all().map(row => row.name));
  if (!executionColumns.has('contract_json')) {
    db.exec("ALTER TABLE provider_backup_executions ADD COLUMN contract_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!itemColumns.has('admission_json')) {
    db.exec("ALTER TABLE provider_backup_execution_items ADD COLUMN admission_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!itemColumns.has('integrity_json')) {
    db.exec("ALTER TABLE provider_backup_execution_items ADD COLUMN integrity_json TEXT NOT NULL DEFAULT '{}'");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_backup_integrity_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_item_id TEXT NOT NULL REFERENCES provider_backup_execution_items(id) ON DELETE CASCADE,
      recovery_point_id TEXT REFERENCES provider_recovery_points(canonical_id) ON DELETE RESTRICT,
      state TEXT NOT NULL CHECK(state IN ('verified', 'failed', 'pending', 'unknown')),
      methods_json TEXT NOT NULL DEFAULT '{}',
      protection_json TEXT NOT NULL DEFAULT '{}',
      evidence_hash TEXT NOT NULL CHECK(length(evidence_hash) = 64),
      observed_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(execution_item_id, evidence_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_provider_backup_integrity_item
      ON provider_backup_integrity_evidence(execution_item_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_provider_backup_integrity_point
      ON provider_backup_integrity_evidence(recovery_point_id, created_at DESC);
  `);
};

exports.down = function (db) {
  db.exec('DROP TABLE IF EXISTS provider_backup_integrity_evidence;');
  // The additive JSON columns intentionally remain during development downgrade.
  // Older releases ignore them and rebuilding operation tables is riskier.
};
