'use strict';

exports.up = function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS network_public_ip_lifecycle_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_key TEXT NOT NULL,
      provider_type TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('allocate','map','unmap','release')),
      public_address TEXT,
      plan_json TEXT NOT NULL,
      blockers_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('ready','blocked')),
      plan_hash TEXT NOT NULL UNIQUE,
      provider_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutations_started=0),
      external_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(external_mutations_started=0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_network_public_ip_plan_scope
      ON network_public_ip_lifecycle_plans(scope_key, created_at DESC, id DESC);
  `);
};

exports.down = function down(db) {
  db.exec('DROP TABLE IF EXISTS network_public_ip_lifecycle_plans;');
};
