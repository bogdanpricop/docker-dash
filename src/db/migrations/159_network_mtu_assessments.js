'use strict';

exports.up = function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS network_mtu_assessments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      provider_host_id INTEGER REFERENCES docker_hosts(id) ON DELETE SET NULL,
      observed_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      assessed_at TEXT NOT NULL,
      coverage_json TEXT NOT NULL,
      paths_json TEXT NOT NULL,
      findings_json TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      assessment_hash TEXT NOT NULL UNIQUE,
      provider_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutations_started=0),
      network_calls_started INTEGER NOT NULL DEFAULT 0 CHECK(network_calls_started=0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK(expires_at > observed_at)
    );

    CREATE INDEX IF NOT EXISTS idx_network_mtu_assessments_time
      ON network_mtu_assessments(observed_at DESC, id DESC);
  `);
};

exports.down = function down(db) {
  db.exec('DROP TABLE IF EXISTS network_mtu_assessments;');
};
