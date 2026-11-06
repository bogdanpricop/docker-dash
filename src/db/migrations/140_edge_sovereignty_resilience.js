'use strict';

const PERMISSIONS = [
  ['edge_sovereignty.manage', 'edge_sovereignty', 'manage', 'Manage edge data-residency policy and transfer decisions'],
  ['edge_identity.manage', 'edge_identity', 'manage', 'Manage disconnected identity cache and site-local vault references'],
  ['edge_resilience.manage', 'edge_resilience', 'manage', 'Manage edge topology, reservations, console and remote-hands plans'],
  ['edge_bmc.manage', 'edge_bmc', 'manage', 'Manage BMC inventory and approved out-of-band recovery plans'],
];

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS edge_data_residency_policies (
      site_id INTEGER PRIMARY KEY REFERENCES edge_sites(id) ON DELETE CASCADE,
      zone TEXT NOT NULL,
      category_rules_json TEXT NOT NULL,
      fail_closed INTEGER NOT NULL DEFAULT 1 CHECK(fail_closed=1),
      policy_hash TEXT NOT NULL,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS edge_residency_evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES edge_sites(id) ON DELETE CASCADE,
      data_category TEXT NOT NULL CHECK(data_category IN ('inventory','logs','metrics','backups')),
      destination_jurisdiction TEXT NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('allowed','blocked')),
      reason TEXT NOT NULL,
      policy_hash TEXT NOT NULL,
      evaluation_hash TEXT NOT NULL UNIQUE,
      evaluated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      evaluated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS edge_identity_cache_policies (
      site_id INTEGER PRIMARY KEY REFERENCES edge_sites(id) ON DELETE CASCADE,
      issuer_ref TEXT NOT NULL,
      normal_ttl_seconds INTEGER NOT NULL CHECK(normal_ttl_seconds BETWEEN 60 AND 900),
      emergency_ttl_seconds INTEGER NOT NULL CHECK(emergency_ttl_seconds BETWEEN 60 AND 300),
      normal_scopes_json TEXT NOT NULL,
      emergency_scopes_json TEXT NOT NULL,
      require_four_eyes_emergency INTEGER NOT NULL DEFAULT 1 CHECK(require_four_eyes_emergency=1),
      policy_hash TEXT NOT NULL,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS edge_identity_grants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES edge_sites(id) ON DELETE CASCADE,
      subject_ref TEXT NOT NULL,
      assertion_hash TEXT NOT NULL,
      scopes_json TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('normal','emergency')),
      reason TEXT,
      ticket_ref TEXT,
      expires_at TEXT NOT NULL,
      grant_hash TEXT NOT NULL UNIQUE,
      signature TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending_activation','active','expired','revoked')),
      activated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      activated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS edge_vault_adapters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES edge_sites(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      provider_kind TEXT NOT NULL CHECK(provider_kind IN ('hashicorp_vault','cyberark','local_tpm','kubernetes')),
      endpoint_ref TEXT NOT NULL,
      namespace_ref TEXT,
      auth_method TEXT NOT NULL CHECK(auth_method IN ('mtls','workload_identity','tpm_attestation','service_account')),
      certificate_fingerprint TEXT,
      allowed_purposes_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','held','retired')),
      config_hash TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(site_id,name)
    );

    CREATE TABLE IF NOT EXISTS edge_secret_resolution_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      adapter_id INTEGER NOT NULL REFERENCES edge_vault_adapters(id) ON DELETE RESTRICT,
      agent_id INTEGER NOT NULL REFERENCES edge_agents(id) ON DELETE RESTRICT,
      secret_ref TEXT NOT NULL,
      purpose TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      plan_hash TEXT NOT NULL UNIQUE,
      signature TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'issued' CHECK(state IN ('issued','expired','revoked')),
      provider_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutations_started=0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS edge_single_node_profiles (
      site_id INTEGER PRIMARY KEY REFERENCES edge_sites(id) ON DELETE CASCADE,
      minimum_cpu_millicores INTEGER NOT NULL,
      minimum_memory_mib INTEGER NOT NULL,
      minimum_storage_gib INTEGER NOT NULL,
      require_external_backup INTEGER NOT NULL DEFAULT 1,
      require_maintenance_window INTEGER NOT NULL DEFAULT 1,
      automatic_upgrade INTEGER NOT NULL DEFAULT 0 CHECK(automatic_upgrade=0),
      profile_hash TEXT NOT NULL,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS edge_single_node_assessments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES edge_sites(id) ON DELETE CASCADE,
      observed_json TEXT NOT NULL,
      checks_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('ready','blocked')),
      assessment_hash TEXT NOT NULL UNIQUE,
      assessed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      assessed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS edge_quorum_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES edge_sites(id) ON DELETE CASCADE,
      cluster_ref TEXT NOT NULL,
      members_json TEXT NOT NULL,
      required_votes INTEGER NOT NULL,
      available_votes INTEGER NOT NULL,
      risks_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('healthy','at_risk','lost')),
      evidence_hash TEXT NOT NULL UNIQUE,
      observed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      observed_at TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS edge_resource_reservation_policies (
      site_id INTEGER PRIMARY KEY REFERENCES edge_sites(id) ON DELETE CASCADE,
      system_cpu_millicores INTEGER NOT NULL,
      system_memory_mib INTEGER NOT NULL,
      system_storage_gib INTEGER NOT NULL,
      max_workload_percent INTEGER NOT NULL CHECK(max_workload_percent BETWEEN 10 AND 90),
      eviction_free_storage_percent INTEGER NOT NULL CHECK(eviction_free_storage_percent BETWEEN 5 AND 50),
      policy_hash TEXT NOT NULL,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS edge_resource_reservation_assessments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES edge_sites(id) ON DELETE CASCADE,
      capacity_json TEXT NOT NULL,
      workload_json TEXT NOT NULL,
      headroom_json TEXT NOT NULL,
      checks_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('compliant','blocked')),
      assessment_hash TEXT NOT NULL UNIQUE,
      assessed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      assessed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS edge_console_profiles (
      site_id INTEGER PRIMARY KEY REFERENCES edge_sites(id) ON DELETE CASCADE,
      transport_order_json TEXT NOT NULL,
      max_bandwidth_kbps INTEGER NOT NULL CHECK(max_bandwidth_kbps BETWEEN 8 AND 10000),
      max_fps INTEGER NOT NULL CHECK(max_fps BETWEEN 1 AND 30),
      color_depth INTEGER NOT NULL CHECK(color_depth IN (8,16,24)),
      adaptive_quality INTEGER NOT NULL DEFAULT 1,
      clipboard_enabled INTEGER NOT NULL DEFAULT 0 CHECK(clipboard_enabled=0),
      file_transfer_enabled INTEGER NOT NULL DEFAULT 0 CHECK(file_transfer_enabled=0),
      idle_ttl_seconds INTEGER NOT NULL CHECK(idle_ttl_seconds BETWEEN 60 AND 3600),
      profile_hash TEXT NOT NULL,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS edge_remote_hands_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES edge_sites(id) ON DELETE CASCADE,
      target_ref TEXT NOT NULL,
      bmc_endpoint_id INTEGER REFERENCES edge_bmc_endpoints(id) ON DELETE SET NULL,
      checklist_json TEXT NOT NULL,
      console_ref TEXT,
      expires_at TEXT NOT NULL,
      plan_hash TEXT NOT NULL UNIQUE,
      signature TEXT NOT NULL,
      approval_id INTEGER REFERENCES infrastructure_approval_requests(id) ON DELETE RESTRICT,
      state TEXT NOT NULL CHECK(state IN ('pending_approval','ready_for_local_operator','expired','cancelled')),
      provider_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutations_started=0),
      requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      authorized_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      authorized_at TEXT
    );

    CREATE TABLE IF NOT EXISTS edge_bmc_endpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES edge_sites(id) ON DELETE CASCADE,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      protocol TEXT NOT NULL CHECK(protocol IN ('redfish','ipmi')),
      endpoint_ref TEXT NOT NULL,
      vault_adapter_id INTEGER NOT NULL REFERENCES edge_vault_adapters(id) ON DELETE RESTRICT,
      credential_ref TEXT NOT NULL,
      certificate_fingerprint TEXT,
      owner TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','held','retired')),
      config_hash TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(site_id,host_id)
    );

    CREATE TABLE IF NOT EXISTS edge_bmc_inventory_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bmc_endpoint_id INTEGER NOT NULL REFERENCES edge_bmc_endpoints(id) ON DELETE CASCADE,
      power_state TEXT NOT NULL CHECK(power_state IN ('on','off','unknown')),
      manufacturer TEXT,
      model TEXT,
      serial_number TEXT,
      firmware_json TEXT NOT NULL,
      sensors_json TEXT NOT NULL,
      health TEXT NOT NULL CHECK(health IN ('ok','warning','critical','unknown')),
      evidence_hash TEXT NOT NULL UNIQUE,
      observed_at TEXT NOT NULL,
      received_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      received_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS edge_bmc_recovery_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bmc_endpoint_id INTEGER NOT NULL REFERENCES edge_bmc_endpoints(id) ON DELETE RESTRICT,
      action_key TEXT NOT NULL CHECK(action_key IN ('power_cycle','power_on','power_off','nmi','boot_once')),
      safeguards_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      ticket_ref TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      plan_hash TEXT NOT NULL UNIQUE,
      signature TEXT NOT NULL,
      approval_id INTEGER REFERENCES infrastructure_approval_requests(id) ON DELETE RESTRICT,
      state TEXT NOT NULL CHECK(state IN ('blocked','pending_approval','ready_for_edge_agent','expired','cancelled')),
      provider_mutations_started INTEGER NOT NULL DEFAULT 0 CHECK(provider_mutations_started=0),
      requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      authorized_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      authorized_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_edge_residency_site ON edge_residency_evaluations(site_id,evaluated_at);
    CREATE INDEX IF NOT EXISTS idx_edge_identity_grants_site ON edge_identity_grants(site_id,state,expires_at);
    CREATE INDEX IF NOT EXISTS idx_edge_quorum_site ON edge_quorum_snapshots(site_id,observed_at);
    CREATE INDEX IF NOT EXISTS idx_edge_bmc_inventory ON edge_bmc_inventory_snapshots(bmc_endpoint_id,observed_at);
  `);

  const syncColumns = new Set(db.prepare('PRAGMA table_info(edge_sync_plans)').all().map(row => row.name));
  if (!syncColumns.has('destination_jurisdiction')) db.exec('ALTER TABLE edge_sync_plans ADD COLUMN destination_jurisdiction TEXT');
  if (!syncColumns.has('residency_evidence_json')) db.exec("ALTER TABLE edge_sync_plans ADD COLUMN residency_evidence_json TEXT NOT NULL DEFAULT '[]'");

  const permissionInsert = db.prepare(`INSERT OR IGNORE INTO governance_permissions
    (permission_key,resource_type,verb,description) VALUES (?,?,?,?)`);
  for (const permission of PERMISSIONS) permissionInsert.run(...permission);
  const siteAdmin = db.prepare("SELECT id FROM governance_roles WHERE slug='site-admin'").get();
  if (siteAdmin) {
    const grant = db.prepare('INSERT OR IGNORE INTO governance_role_permissions (role_id,permission_key) VALUES (?,?)');
    for (const permission of PERMISSIONS) grant.run(siteAdmin.id, permission[0]);
  }
};

exports._PERMISSIONS = PERMISSIONS;
