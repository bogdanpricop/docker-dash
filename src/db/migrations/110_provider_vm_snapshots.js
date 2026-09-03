'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_vm_snapshots (
      canonical_id TEXT PRIMARY KEY CHECK(canonical_id GLOB 'dds_snap_[0-9a-f]*'),
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      vm_id TEXT NOT NULL REFERENCES provider_resource_identities(canonical_id) ON DELETE CASCADE,
      provider_type TEXT NOT NULL,
      native_ref_hash TEXT NOT NULL,
      native_ref_enc TEXT NOT NULL,
      snapshot_uuid TEXT,
      snapshot_name TEXT NOT NULL,
      description TEXT,
      created_at TEXT,
      parent_id TEXT REFERENCES provider_vm_snapshots(canonical_id) ON DELETE SET NULL,
      is_current INTEGER NOT NULL DEFAULT 0 CHECK(is_current IN (0, 1)),
      consistency TEXT NOT NULL DEFAULT 'unknown' CHECK(consistency IN ('crash', 'quiesced', 'unknown')),
      integrity_state TEXT NOT NULL DEFAULT 'unknown' CHECK(integrity_state IN ('valid', 'orphan_parent', 'cycle', 'unknown')),
      is_present INTEGER NOT NULL DEFAULT 1 CHECK(is_present IN (0, 1)),
      observed_at TEXT NOT NULL,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(host_id, vm_id, native_ref_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_provider_vm_snapshots_vm_present
      ON provider_vm_snapshots(host_id, vm_id, is_present, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_provider_vm_snapshots_name
      ON provider_vm_snapshots(host_id, vm_id, snapshot_name COLLATE NOCASE);
  `);
};

exports.down = function (db) {
  db.exec('DROP TABLE IF EXISTS provider_vm_snapshots');
};
