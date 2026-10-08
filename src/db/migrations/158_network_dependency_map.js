'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS network_dependency_address_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      provider_host_id INTEGER REFERENCES docker_hosts(id) ON DELETE SET NULL,
      observed_at TEXT NOT NULL,
      coverage_json TEXT NOT NULL,
      addresses_json TEXT NOT NULL,
      observation_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_network_dependency_address_time
      ON network_dependency_address_observations(observed_at DESC, provider_host_id);

    CREATE TABLE IF NOT EXISTS network_dependency_dns_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      records_json TEXT NOT NULL,
      observation_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK(expires_at > observed_at)
    );

    CREATE INDEX IF NOT EXISTS idx_network_dependency_dns_expiry
      ON network_dependency_dns_observations(expires_at, observed_at DESC);

    CREATE TABLE IF NOT EXISTS network_dependency_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_key TEXT NOT NULL,
      built_at TEXT NOT NULL,
      freshness_cutoff_at TEXT NOT NULL,
      parameters_json TEXT NOT NULL,
      nodes_json TEXT NOT NULL,
      edges_json TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      source_cursor_json TEXT NOT NULL,
      snapshot_hash TEXT NOT NULL UNIQUE,
      provider_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutations_started=0),
      network_calls_started INTEGER NOT NULL DEFAULT 0 CHECK(network_calls_started=0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_network_dependency_snapshot_scope
      ON network_dependency_snapshots(scope_key, built_at DESC, id DESC);
  `);
};

exports.down = function (db) {
  db.exec(`
    DROP TABLE IF EXISTS network_dependency_snapshots;
    DROP TABLE IF EXISTS network_dependency_dns_observations;
    DROP TABLE IF EXISTS network_dependency_address_observations;
  `);
};
