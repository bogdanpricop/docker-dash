'use strict';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_managed_volumes (
      id TEXT PRIMARY KEY CHECK(id GLOB 'ddv_vol_[0-9a-f]*'),
      schema_version TEXT NOT NULL DEFAULT '1.0',
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      vm_id TEXT NOT NULL REFERENCES provider_resource_identities(canonical_id) ON DELETE RESTRICT,
      provider_type TEXT NOT NULL,
      native_ref_hash TEXT NOT NULL,
      native_ref_enc TEXT NOT NULL,
      disk_id TEXT,
      label TEXT NOT NULL,
      storage_id TEXT REFERENCES provider_resource_identities(canonical_id) ON DELETE SET NULL,
      bus TEXT,
      unit_number INTEGER,
      capacity_bytes INTEGER NOT NULL CHECK(capacity_bytes > 0),
      lifecycle_state TEXT NOT NULL CHECK(lifecycle_state IN
        ('creating','attached','detached','moving','deleting','deleted','unknown')),
      create_operation_id TEXT REFERENCES provider_operations(id) ON DELETE SET NULL,
      last_operation_id TEXT REFERENCES provider_operations(id) ON DELETE SET NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      detached_at TEXT,
      deleted_at TEXT,
      UNIQUE(host_id, native_ref_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_provider_managed_volumes_vm
      ON provider_managed_volumes(host_id, vm_id, lifecycle_state, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_provider_managed_volumes_state
      ON provider_managed_volumes(host_id, lifecycle_state, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_provider_managed_volumes_disk
      ON provider_managed_volumes(host_id, vm_id, disk_id);
  `);
};

exports.down = function (db) {
  db.exec('DROP TABLE IF EXISTS provider_managed_volumes');
};
