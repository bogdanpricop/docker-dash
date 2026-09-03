'use strict';

// v8.70.0 — V6.6a hardware and performance foundation (B376–B385).
// Evidence and desired-policy records only: no provider hardware mutation.

const PERMISSIONS = [
  ['hardware_inventory.read', 'hardware_inventory', 'read', 'View normalized host hardware and workload placement evidence'],
  ['hardware_performance.manage', 'hardware_performance', 'manage', 'Record hardware evidence and edit non-executing compatibility policies'],
];

exports.up = function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hardware_host_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      provider_type TEXT NOT NULL,
      cluster_ref TEXT NOT NULL,
      host_ref TEXT NOT NULL,
      model TEXT NOT NULL,
      generation TEXT,
      observed_at TEXT NOT NULL,
      source_json TEXT NOT NULL,
      hardware_json TEXT NOT NULL,
      compatibility_tags_json TEXT NOT NULL,
      evidence_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS hardware_cpu_compatibility_policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cluster_ref TEXT NOT NULL UNIQUE,
      provider_type TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('host-passthrough','cluster-baseline','vendor-compatibility','custom')),
      baseline_features_json TEXT NOT NULL DEFAULT '[]',
      adapter_state TEXT NOT NULL CHECK(adapter_state IN ('plan_ready','inventory_only','unsupported')),
      policy_state TEXT NOT NULL CHECK(policy_state IN ('ready','blocked')),
      blockers_json TEXT NOT NULL DEFAULT '[]',
      change_plan_json TEXT NOT NULL,
      plan_hash TEXT NOT NULL UNIQUE,
      provider_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutations_started=0),
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_hardware_snapshots_host_time
      ON hardware_host_snapshots(host_id,observed_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS idx_hardware_snapshots_cluster_time
      ON hardware_host_snapshots(cluster_ref,observed_at DESC,id DESC);
  `);

  const insertPermission = db.prepare(`INSERT OR IGNORE INTO governance_permissions
    (permission_key,resource_type,verb,description) VALUES (?,?,?,?)`);
  for (const permission of PERMISSIONS) insertPermission.run(...permission);
  const siteAdmin = db.prepare("SELECT id FROM governance_roles WHERE slug='site-admin'").get();
  if (siteAdmin) {
    const grant = db.prepare('INSERT OR IGNORE INTO governance_role_permissions (role_id,permission_key) VALUES (?,?)');
    for (const permission of PERMISSIONS) grant.run(siteAdmin.id, permission[0]);
  }
};

exports._PERMISSIONS = PERMISSIONS;
