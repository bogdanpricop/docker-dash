'use strict';

const PERMISSIONS = [
  ['kubernetes_virtualization_changes.manage', 'kubernetes_virtualization_changes', 'manage', 'Plan, approve and execute guarded KubeVirt resource creation'],
  ['kubernetes_storage.manage', 'kubernetes_storage', 'manage', 'Inspect CDI, CSI and virtualization storage capabilities'],
  ['kubernetes_network_intent.manage', 'kubernetes_network_intent', 'manage', 'Inspect Multus, NMState and VM exposure evidence'],
];

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kubernetes_virtualization_change_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      change_kind TEXT NOT NULL CHECK(change_kind IN ('datavolume_create','template_instantiate')),
      namespace TEXT NOT NULL,
      resource_name TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      prerequisites_json TEXT NOT NULL,
      dry_run_response_json TEXT NOT NULL,
      desired_hash TEXT NOT NULL,
      plan_hash TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL DEFAULT 'validated' CHECK(state IN ('validated','executing','succeeded','failed','stale')),
      approval_id INTEGER REFERENCES infrastructure_approval_requests(id) ON DELETE SET NULL,
      operation_ref TEXT,
      execution_evidence_json TEXT,
      requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      executed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      executed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS kubernetes_virtualization_operation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL REFERENCES kubernetes_virtualization_change_plans(id) ON DELETE CASCADE,
      operation_ref TEXT NOT NULL,
      event_type TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed','stale')),
      evidence_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS kubernetes_virtualization_migration_policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      bandwidth_per_migration TEXT NOT NULL,
      parallel_migrations_per_cluster INTEGER NOT NULL CHECK(parallel_migrations_per_cluster BETWEEN 1 AND 100),
      parallel_outbound_per_node INTEGER NOT NULL CHECK(parallel_outbound_per_node BETWEEN 1 AND 20),
      completion_timeout_per_gib INTEGER NOT NULL CHECK(completion_timeout_per_gib BETWEEN 1 AND 86400),
      progress_timeout_seconds INTEGER NOT NULL CHECK(progress_timeout_seconds BETWEEN 1 AND 86400),
      allow_auto_converge INTEGER NOT NULL DEFAULT 0,
      allow_post_copy INTEGER NOT NULL DEFAULT 0,
      policy_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(host_id,name)
    );

    CREATE TABLE IF NOT EXISTS kubernetes_virtualization_convergence_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('datavolumes','templates','node_drain','csi_snapshots','multus','nmstate','vm_exposure')),
      namespace_scope TEXT,
      evidence_json TEXT NOT NULL,
      evidence_hash TEXT NOT NULL,
      snapshot_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_kubevirt_change_host_state ON kubernetes_virtualization_change_plans(host_id,state,created_at);
    CREATE INDEX IF NOT EXISTS idx_kubevirt_operation_plan ON kubernetes_virtualization_operation_events(plan_id,id);
    CREATE INDEX IF NOT EXISTS idx_kubevirt_migration_policy_host ON kubernetes_virtualization_migration_policies(host_id,name);
    CREATE INDEX IF NOT EXISTS idx_kubevirt_convergence_host_kind ON kubernetes_virtualization_convergence_snapshots(host_id,evidence_kind,created_at);
  `);

  const insert = db.prepare(`INSERT OR IGNORE INTO governance_permissions
    (permission_key,resource_type,verb,description) VALUES (?,?,?,?)`);
  for (const permission of PERMISSIONS) insert.run(...permission);
  const siteAdmin = db.prepare("SELECT id FROM governance_roles WHERE slug='site-admin'").get();
  if (siteAdmin) {
    const grant = db.prepare('INSERT OR IGNORE INTO governance_role_permissions (role_id,permission_key) VALUES (?,?)');
    for (const permission of PERMISSIONS) grant.run(siteAdmin.id, permission[0]);
  }
};

exports._PERMISSIONS = PERMISSIONS;
