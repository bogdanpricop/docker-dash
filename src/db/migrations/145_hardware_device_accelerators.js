'use strict';

const PERMISSIONS = [
  ['hardware_devices.manage', 'hardware_device', 'manage', 'Record device evidence and create non-executing accelerator allocation plans'],
];

exports.up = function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hardware_device_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      observed_at TEXT NOT NULL,
      inventory_json TEXT NOT NULL,
      evidence_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS hardware_device_allocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      device_kind TEXT NOT NULL CHECK(device_kind IN ('pci','sriov_vf','gpu','vgpu')),
      device_ref TEXT NOT NULL,
      profile_name TEXT,
      target_resource_key TEXT NOT NULL,
      tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL,
      state TEXT NOT NULL DEFAULT 'planned' CHECK(state IN ('planned','released')),
      constraints_json TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      plan_hash TEXT NOT NULL UNIQUE,
      provider_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutations_started=0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      released_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_hardware_device_active_allocation
      ON hardware_device_allocations(host_id,device_ref) WHERE state='planned' AND device_kind!='vgpu';
    CREATE TABLE IF NOT EXISTS hardware_accelerator_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      device_ref TEXT NOT NULL,
      resource_key TEXT,
      observed_at TEXT NOT NULL,
      metrics_json TEXT NOT NULL,
      evidence_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS hardware_accelerator_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      device_ref TEXT NOT NULL,
      profile_name TEXT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      purpose TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','cancelled','expired')),
      reservation_hash TEXT NOT NULL UNIQUE,
      provider_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutations_started=0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_hardware_device_snapshot_host ON hardware_device_snapshots(host_id,observed_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS idx_hardware_accelerator_metrics_device ON hardware_accelerator_metrics(device_ref,observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_hardware_accelerator_reservation_window ON hardware_accelerator_reservations(host_id,device_ref,starts_at,ends_at);
  `);
  const insert = db.prepare(`INSERT OR IGNORE INTO governance_permissions
    (permission_key,resource_type,verb,description) VALUES (?,?,?,?)`);
  for (const permission of PERMISSIONS) insert.run(...permission);
  const role = db.prepare("SELECT id FROM governance_roles WHERE slug='site-admin'").get();
  if (role) db.prepare('INSERT OR IGNORE INTO governance_role_permissions (role_id,permission_key) VALUES (?,?)').run(role.id, PERMISSIONS[0][0]);
};

exports._PERMISSIONS = PERMISSIONS;
