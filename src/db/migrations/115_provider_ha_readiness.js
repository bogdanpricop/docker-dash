'use strict';

exports.up = function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_ha_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      provider_type TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      observed_bucket TEXT NOT NULL,
      overall_state TEXT NOT NULL,
      score INTEGER,
      snapshot_hash TEXT NOT NULL,
      snapshot_enc TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(host_id, observed_bucket),
      CHECK (provider_type IN ('proxmox','vsphere','xen')),
      CHECK (overall_state IN ('ready','degraded','blocked','not_configured','unsupported','unknown')),
      CHECK (score IS NULL OR (score BETWEEN 0 AND 100)),
      CHECK (length(snapshot_hash) = 64 AND snapshot_hash NOT GLOB '*[^0-9a-f]*'),
      CHECK (length(snapshot_enc) BETWEEN 16 AND 1048576)
    );

    CREATE INDEX IF NOT EXISTS idx_provider_ha_snapshots_host_time
      ON provider_ha_snapshots(host_id, observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_provider_ha_snapshots_state_time
      ON provider_ha_snapshots(overall_state, observed_at DESC);
  `);
};

exports.down = function down(db) {
  db.exec('DROP TABLE IF EXISTS provider_ha_snapshots;');
};
