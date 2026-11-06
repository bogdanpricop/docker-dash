'use strict';

// v8.50.0 — V4.6b identity and policy governance (B186–B195).
// Additive control-plane state only; no provider resources are mutated.

const EXTENDED_METRICS = [
  'nic_count', 'network_count', 'public_ip_count', 'security_group_count',
  'snapshot_count', 'snapshot_bytes', 'backup_count', 'backup_bytes',
  'gpu_count', 'device_count', 'accelerator_seconds',
];

const PERMISSIONS = [
  ['project.capacity.manage', 'project_capacity', 'manage', 'Configure extended quotas and capacity accounting'],
  ['quota.request', 'quota_request', 'create', 'Request a time-bound project quota increase'],
  ['quota.approve', 'quota_request', 'approve', 'Approve project quota increases within an authorized scope'],
  ['identity.manage', 'identity_realm', 'manage', 'Manage identity federation and workload trust policies'],
  ['service_tokens.manage', 'service_token', 'manage', 'Issue, rotate, and revoke short-lived service tokens'],
  ['approval_policy.manage', 'approval_policy', 'manage', 'Manage one/two-person approval policies'],
  ['blackout.manage', 'blackout_window', 'manage', 'Manage mutation blackout windows and emergency policy'],
];

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS governance_project_extended_quotas (
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      metric TEXT NOT NULL CHECK(metric IN (${EXTENDED_METRICS.map(metric => `'${metric}'`).join(',')})),
      soft_limit INTEGER CHECK(soft_limit IS NULL OR soft_limit >= 0),
      hard_limit INTEGER CHECK(hard_limit IS NULL OR hard_limit >= 0),
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tenant_id, metric),
      CHECK(soft_limit IS NULL OR hard_limit IS NULL OR soft_limit <= hard_limit)
    );

    CREATE TABLE IF NOT EXISTS governance_project_capacity_allocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      provider_host_id INTEGER NOT NULL DEFAULT 0,
      resource_type TEXT NOT NULL,
      resource_key TEXT NOT NULL,
      metric TEXT NOT NULL CHECK(metric IN (${EXTENDED_METRICS.map(metric => `'${metric}'`).join(',')})),
      amount INTEGER NOT NULL CHECK(amount >= 0),
      profile TEXT,
      policy_key TEXT,
      expires_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(provider_host_id, resource_type, resource_key, metric)
    );
    CREATE INDEX IF NOT EXISTS idx_governance_capacity_project
      ON governance_project_capacity_allocations(tenant_id, metric);

    CREATE TABLE IF NOT EXISTS governance_approval_policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      scope_id INTEGER REFERENCES governance_scopes(id) ON DELETE CASCADE,
      action_pattern TEXT NOT NULL,
      environment TEXT NOT NULL DEFAULT 'any' CHECK(environment IN ('any','production','nonproduction')),
      minimum_risk INTEGER NOT NULL DEFAULT 1 CHECK(minimum_risk BETWEEN 1 AND 4),
      approvals_required INTEGER NOT NULL DEFAULT 1 CHECK(approvals_required IN (1,2)),
      requester_cannot_approve INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_governance_approval_policy_match
      ON governance_approval_policies(enabled, environment, minimum_risk);

    CREATE TABLE IF NOT EXISTS governance_approval_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_id INTEGER REFERENCES governance_approval_policies(id) ON DELETE SET NULL,
      scope_id INTEGER REFERENCES governance_scopes(id) ON DELETE SET NULL,
      tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      action_key TEXT NOT NULL,
      environment TEXT NOT NULL CHECK(environment IN ('production','nonproduction')),
      risk INTEGER NOT NULL CHECK(risk BETWEEN 1 AND 4),
      payload_hash TEXT NOT NULL,
      summary_json TEXT NOT NULL DEFAULT '{}',
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','executing','consumed','rejected','expired','cancelled')),
      approvals_required INTEGER NOT NULL CHECK(approvals_required IN (1,2)),
      requester_cannot_approve INTEGER NOT NULL DEFAULT 1,
      requested_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      reason TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      executing_at TEXT,
      consumed_at TEXT,
      outcome_status INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_governance_approval_requests_state
      ON governance_approval_requests(state, expires_at);

    CREATE TABLE IF NOT EXISTS governance_approval_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL REFERENCES governance_approval_requests(id) ON DELETE CASCADE,
      approver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      decision TEXT NOT NULL CHECK(decision IN ('approve','reject')),
      comment TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(request_id, approver_id)
    );

    CREATE TABLE IF NOT EXISTS governance_quota_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      approval_request_id INTEGER NOT NULL UNIQUE REFERENCES governance_approval_requests(id) ON DELETE CASCADE,
      requested_limits_json TEXT NOT NULL,
      duration_seconds INTEGER NOT NULL CHECK(duration_seconds BETWEEN 300 AND 2592000),
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','active','rejected','expired','cancelled')),
      requested_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      reason TEXT NOT NULL,
      applied_at TEXT,
      effective_until TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS governance_quota_grants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quota_request_id INTEGER NOT NULL REFERENCES governance_quota_requests(id) ON DELETE CASCADE,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      metric TEXT NOT NULL,
      soft_limit INTEGER,
      hard_limit INTEGER,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(quota_request_id, metric),
      CHECK(soft_limit IS NULL OR soft_limit >= 0),
      CHECK(hard_limit IS NULL OR hard_limit >= 0),
      CHECK(soft_limit IS NULL OR hard_limit IS NULL OR soft_limit <= hard_limit)
    );
    CREATE INDEX IF NOT EXISTS idx_governance_quota_grants_active
      ON governance_quota_grants(tenant_id, metric, expires_at);

    CREATE TABLE IF NOT EXISTS governance_identity_realms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      protocol TEXT NOT NULL CHECK(protocol IN ('oidc','saml')),
      login_url TEXT NOT NULL,
      issuer_url TEXT,
      metadata_url TEXT,
      entity_id TEXT,
      default_role TEXT NOT NULL DEFAULT 'viewer' CHECK(default_role IN ('admin','operator','viewer')),
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS governance_identity_realm_domains (
      domain TEXT PRIMARY KEY COLLATE NOCASE,
      realm_id INTEGER NOT NULL REFERENCES governance_identity_realms(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS governance_service_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      principal TEXT NOT NULL,
      token_prefix TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      scopes_json TEXT NOT NULL,
      tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT,
      rotated_from INTEGER REFERENCES governance_service_tokens(id) ON DELETE SET NULL,
      issued_via TEXT NOT NULL DEFAULT 'manual' CHECK(issued_via IN ('manual','rotation','workload_exchange')),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_governance_service_token_hash
      ON governance_service_tokens(token_hash);

    CREATE TABLE IF NOT EXISTS governance_scim_resources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      resource_type TEXT NOT NULL CHECK(resource_type IN ('User','Group')),
      local_id INTEGER NOT NULL,
      external_id TEXT,
      realm_slug TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      last_synced_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(resource_type, local_id),
      UNIQUE(resource_type, external_id, realm_slug)
    );

    CREATE TABLE IF NOT EXISTS governance_workload_identity_trusts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      issuer TEXT NOT NULL,
      audience TEXT NOT NULL,
      subject_pattern TEXT NOT NULL,
      identity_kind TEXT NOT NULL CHECK(identity_kind IN ('oidc','spiffe','aws','azure','gcp')),
      jwks_json TEXT NOT NULL,
      scopes_json TEXT NOT NULL,
      tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      token_ttl_seconds INTEGER NOT NULL DEFAULT 900 CHECK(token_ttl_seconds BETWEEN 60 AND 3600),
      max_assertion_ttl_seconds INTEGER NOT NULL DEFAULT 3600 CHECK(max_assertion_ttl_seconds BETWEEN 60 AND 86400),
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(issuer, audience, subject_pattern)
    );

    CREATE TABLE IF NOT EXISTS governance_workload_assertions (
      assertion_hash TEXT PRIMARY KEY,
      trust_id INTEGER NOT NULL REFERENCES governance_workload_identity_trusts(id) ON DELETE CASCADE,
      subject_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      exchanged_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_governance_workload_assertions_expiry
      ON governance_workload_assertions(expires_at);

    CREATE TABLE IF NOT EXISTS governance_blackout_windows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      scope_id INTEGER REFERENCES governance_scopes(id) ON DELETE CASCADE,
      action_pattern TEXT NOT NULL DEFAULT '*',
      environment TEXT NOT NULL DEFAULT 'any' CHECK(environment IN ('any','production','nonproduction')),
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      reason TEXT NOT NULL,
      allow_emergency_override INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK(ends_at > starts_at)
    );
    CREATE INDEX IF NOT EXISTS idx_governance_blackout_active
      ON governance_blackout_windows(enabled, starts_at, ends_at);

    CREATE TABLE IF NOT EXISTS governance_blackout_exceptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      window_id INTEGER NOT NULL REFERENCES governance_blackout_windows(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      action_key TEXT NOT NULL,
      reason TEXT NOT NULL,
      ticket TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const permissionInsert = db.prepare(`INSERT OR IGNORE INTO governance_permissions
    (permission_key, resource_type, verb, description) VALUES (?, ?, ?, ?)`);
  for (const permission of PERMISSIONS) permissionInsert.run(...permission);

  const roleId = db.prepare('SELECT id FROM governance_roles WHERE slug = ?');
  const rolePermission = db.prepare(`INSERT OR IGNORE INTO governance_role_permissions
    (role_id, permission_key) VALUES (?, ?)`);
  const projectAdmin = roleId.get('project-admin');
  const siteAdmin = roleId.get('site-admin');
  for (const permission of ['project.capacity.manage', 'quota.request']) {
    if (projectAdmin) rolePermission.run(projectAdmin.id, permission);
  }
  for (const permission of ['project.capacity.manage', 'quota.request', 'quota.approve']) {
    if (siteAdmin) rolePermission.run(siteAdmin.id, permission);
  }
};

exports._EXTENDED_METRICS = EXTENDED_METRICS;
exports._PERMISSIONS = PERMISSIONS;
