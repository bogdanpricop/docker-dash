'use strict';

const PERMISSIONS = [
  ['edge_disaster.manage', 'edge_disaster', 'manage', 'Declare and resolve edge disasters with local mutation freeze'],
  ['edge_backup.manage', 'edge_backup_seed', 'manage', 'Manage signed offline backup seed and continuation evidence'],
  ['edge_compliance.manage', 'edge_compliance', 'manage', 'Manage privacy-preserving edge compliance summaries'],
  ['edge_topology.manage', 'edge_fault_domain', 'manage', 'Manage edge rack, power, network and storage failure domains'],
  ['edge_enrollment.manage', 'edge_enrollment', 'manage', 'Manage one-time hardware-bound edge agent enrollment'],
];

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS edge_disaster_declarations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES edge_sites(id) ON DELETE CASCADE,
      severity TEXT NOT NULL CHECK(severity IN ('major','critical')),
      reason TEXT NOT NULL,
      ticket_ref TEXT NOT NULL,
      notification_refs_json TEXT NOT NULL,
      runbook_envelope_id INTEGER NOT NULL REFERENCES edge_runbook_envelopes(id) ON DELETE RESTRICT,
      mutation_freeze INTEGER NOT NULL DEFAULT 1 CHECK(mutation_freeze=1),
      declaration_hash TEXT NOT NULL UNIQUE,
      signature TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','resolved')),
      declared_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      resolution_evidence_hash TEXT,
      declared_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS edge_disaster_notification_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      declaration_id INTEGER NOT NULL REFERENCES edge_disaster_declarations(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK(channel IN ('local_banner','email','sms','webhook')),
      recipient_ref TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','acknowledged')),
      external_delivery_started INTEGER NOT NULL DEFAULT 0 CHECK(external_delivery_started=0),
      acknowledged_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      acknowledged_at TEXT,
      UNIQUE(declaration_id,channel,recipient_ref)
    );

    CREATE TABLE IF NOT EXISTS edge_backup_seed_manifests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES edge_sites(id) ON DELETE CASCADE,
      dataset_ref TEXT NOT NULL,
      base_backup_ref TEXT NOT NULL,
      base_backup_digest TEXT NOT NULL,
      chunks_json TEXT NOT NULL,
      encryption_key_ref TEXT NOT NULL,
      media_ref TEXT NOT NULL,
      total_bytes INTEGER NOT NULL CHECK(total_bytes BETWEEN 1 AND 1125899906842624),
      expires_at TEXT NOT NULL,
      manifest_hash TEXT NOT NULL UNIQUE,
      signature TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('ready','blocked','complete')),
      transfer_started INTEGER NOT NULL DEFAULT 0 CHECK(transfer_started=0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS edge_backup_seed_checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seed_id INTEGER NOT NULL REFERENCES edge_backup_seed_manifests(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK(sequence >= 0),
      completed_chunk INTEGER NOT NULL CHECK(completed_chunk >= 0),
      transferred_bytes INTEGER NOT NULL CHECK(transferred_bytes >= 0),
      continuation_cursor TEXT NOT NULL,
      rolling_digest TEXT NOT NULL,
      media_identity_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('in_progress','complete')),
      checkpoint_hash TEXT NOT NULL UNIQUE,
      reported_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reported_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(seed_id,sequence)
    );

    CREATE TABLE IF NOT EXISTS edge_compliance_profiles (
      site_id INTEGER PRIMARY KEY REFERENCES edge_sites(id) ON DELETE CASCADE,
      required_controls_json TEXT NOT NULL,
      maximum_unknown INTEGER NOT NULL CHECK(maximum_unknown BETWEEN 0 AND 100),
      profile_hash TEXT NOT NULL,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS edge_compliance_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES edge_sites(id) ON DELETE CASCADE,
      passed_count INTEGER NOT NULL CHECK(passed_count >= 0),
      failed_count INTEGER NOT NULL CHECK(failed_count >= 0),
      unknown_count INTEGER NOT NULL CHECK(unknown_count >= 0),
      control_states_json TEXT NOT NULL,
      source_evidence_digest TEXT NOT NULL,
      posture TEXT NOT NULL CHECK(posture IN ('compliant','degraded','non_compliant','unknown')),
      sensitive_details_withheld INTEGER NOT NULL DEFAULT 1 CHECK(sensitive_details_withheld=1),
      snapshot_hash TEXT NOT NULL UNIQUE,
      observed_at TEXT NOT NULL,
      received_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      received_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS edge_fault_domains (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES edge_sites(id) ON DELETE CASCADE,
      domain_type TEXT NOT NULL CHECK(domain_type IN ('rack','power','network','storage')),
      domain_key TEXT NOT NULL,
      name TEXT NOT NULL,
      owner TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      domain_hash TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(site_id,domain_type,domain_key)
    );

    CREATE TABLE IF NOT EXISTS edge_fault_domain_members (
      domain_id INTEGER NOT NULL REFERENCES edge_fault_domains(id) ON DELETE CASCADE,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      PRIMARY KEY(domain_id,host_id)
    );

    CREATE TABLE IF NOT EXISTS edge_fault_domain_assessments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES edge_sites(id) ON DELETE CASCADE,
      workload_ref TEXT NOT NULL,
      host_ids_json TEXT NOT NULL,
      required_replicas INTEGER NOT NULL CHECK(required_replicas BETWEEN 1 AND 1000),
      domain_coverage_json TEXT NOT NULL,
      risks_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('resilient','at_risk','unknown')),
      assessment_hash TEXT NOT NULL UNIQUE,
      assessed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      assessed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS edge_enrollment_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES edge_sites(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      token_fingerprint TEXT NOT NULL,
      expected_hardware_json TEXT NOT NULL,
      runbook_allowlist_json TEXT NOT NULL,
      update_ring TEXT NOT NULL REFERENCES edge_update_rings(slug) ON DELETE RESTRICT,
      expires_at TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'issued' CHECK(state IN ('issued','redeemed','expired','revoked')),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      redeemed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS edge_enrollment_attestations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id INTEGER NOT NULL UNIQUE REFERENCES edge_enrollment_tokens(id) ON DELETE RESTRICT,
      site_id INTEGER NOT NULL REFERENCES edge_sites(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      hardware_claims_json TEXT NOT NULL,
      public_key_fingerprint TEXT NOT NULL,
      nonce TEXT NOT NULL,
      attestation_hash TEXT NOT NULL UNIQUE,
      bootstrap_signature TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'certificate_pending' CHECK(state IN ('certificate_pending','enrolled','rejected')),
      approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      received_at TEXT NOT NULL DEFAULT (datetime('now')),
      approved_at TEXT,
      UNIQUE(site_id,agent_id)
    );

    CREATE TABLE IF NOT EXISTS edge_enrolled_identities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attestation_id INTEGER NOT NULL UNIQUE REFERENCES edge_enrollment_attestations(id) ON DELETE RESTRICT,
      edge_agent_id INTEGER NOT NULL UNIQUE REFERENCES edge_agents(id) ON DELETE CASCADE,
      certificate_fingerprint TEXT NOT NULL UNIQUE,
      identity_hash TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','revoked')),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_edge_disaster_site ON edge_disaster_declarations(site_id,state,declared_at);
    CREATE INDEX IF NOT EXISTS idx_edge_seed_site ON edge_backup_seed_manifests(site_id,state,created_at);
    CREATE INDEX IF NOT EXISTS idx_edge_compliance_site ON edge_compliance_snapshots(site_id,observed_at);
    CREATE INDEX IF NOT EXISTS idx_edge_fault_domains_site ON edge_fault_domains(site_id,domain_type);
    CREATE INDEX IF NOT EXISTS idx_edge_enrollment_site ON edge_enrollment_tokens(site_id,state,expires_at);
  `);

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
