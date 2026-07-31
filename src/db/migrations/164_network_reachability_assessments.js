'use strict';

exports.up = function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS network_reachability_assessments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_key TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'simulation' CHECK(mode='simulation'),
      protocol TEXT NOT NULL CHECK(protocol IN ('tcp','udp','icmp','icmpv6')),
      destination_port INTEGER NOT NULL CHECK(destination_port BETWEEN 0 AND 65535),
      source_json TEXT NOT NULL,
      destination_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      verdict TEXT NOT NULL CHECK(verdict IN ('pass','fail','unknown')),
      assessment_hash TEXT NOT NULL UNIQUE,
      network_calls_started INTEGER NOT NULL DEFAULT 0 CHECK(network_calls_started=0),
      provider_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutations_started=0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_network_reachability_scope
      ON network_reachability_assessments(scope_key, created_at DESC, id DESC);
  `);
};

exports.down = function down(db) {
  db.exec('DROP TABLE IF EXISTS network_reachability_assessments;');
};
