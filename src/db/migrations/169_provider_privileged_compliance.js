'use strict';

const PERMISSIONS = [
  ['privileged.elevation.request', 'privileged_elevation', 'request', 'Request an MFA-bound just-in-time privileged grant'],
  ['privileged.elevation.approve', 'privileged_elevation', 'approve', 'Independently approve a just-in-time privileged grant'],
  ['privileged.break_glass.request', 'break_glass', 'request', 'Request temporary break-glass access'],
  ['privileged.break_glass.approve', 'break_glass', 'approve', 'Independently approve temporary break-glass access'],
  ['privileged.break_glass.review', 'break_glass', 'review', 'Close and review break-glass access'],
  ['privileged.session_recording.read', 'remote_session', 'read', 'View remote-session recording metadata'],
  ['data.classification.manage', 'data_classification', 'manage', 'Classify provider resources and their policy projection'],
  ['compliance.evidence.export', 'compliance_evidence', 'export', 'Create signed compliance evidence bundles'],
  ['compliance.mapping.manage', 'compliance_mapping', 'manage', 'Map evidence subjects to control frameworks'],
  ['recovery.ransomware_posture.manage', 'ransomware_posture', 'manage', 'Record ransomware recovery posture evidence'],
];

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_privileged_step_up_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      succeeded INTEGER NOT NULL CHECK(succeeded IN (0,1)),
      attempted_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_provider_step_up_attempts_subject
      ON provider_privileged_step_up_attempts(user_id,host_id,attempted_at DESC);

    CREATE TABLE IF NOT EXISTS provider_privileged_elevation_grants (
      id TEXT PRIMARY KEY CHECK(id GLOB 'ppjg_[0-9a-f]*'),
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      scope_id INTEGER NOT NULL REFERENCES governance_scopes(id) ON DELETE RESTRICT,
      permission_key TEXT NOT NULL REFERENCES governance_permissions(permission_key) ON DELETE RESTRICT,
      requested_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      mfa_verified_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','active','revoked','expired','rejected')),
      approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      approved_at TEXT,
      token_hash TEXT UNIQUE,
      claimed_at TEXT,
      revoked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      revoked_at TEXT,
      grant_hash TEXT NOT NULL UNIQUE CHECK(length(grant_hash) = 64),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK(approved_by IS NULL OR approved_by <> requested_by)
    );
    CREATE INDEX IF NOT EXISTS idx_provider_privileged_grants_subject
      ON provider_privileged_elevation_grants(requested_by,host_id,state,expires_at);
    CREATE INDEX IF NOT EXISTS idx_provider_privileged_grants_scope
      ON provider_privileged_elevation_grants(scope_id,permission_key,state,expires_at);

    CREATE TABLE IF NOT EXISTS provider_break_glass_requests (
      id TEXT PRIMARY KEY CHECK(id GLOB 'ppbg_[0-9a-f]*'),
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      scope_id INTEGER NOT NULL REFERENCES governance_scopes(id) ON DELETE RESTRICT,
      requested_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      ticket_ref TEXT NOT NULL,
      notification_refs_json TEXT NOT NULL,
      recording_policy TEXT NOT NULL CHECK(recording_policy IN ('metadata','screen')),
      recording_policy_ref TEXT,
      recording_consent_at TEXT,
      expires_at TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','active','closed','rejected','reviewed','expired')),
      approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      approved_at TEXT,
      activation_token_hash TEXT UNIQUE,
      activated_at TEXT,
      closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      closed_at TEXT,
      review_outcome TEXT CHECK(review_outcome IS NULL OR review_outcome IN ('expected','needs_follow_up','policy_violation')),
      review_notes TEXT,
      reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TEXT,
      request_hash TEXT NOT NULL UNIQUE CHECK(length(request_hash) = 64),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK(approved_by IS NULL OR approved_by <> requested_by)
    );
    CREATE INDEX IF NOT EXISTS idx_provider_break_glass_host
      ON provider_break_glass_requests(host_id,state,expires_at);
    CREATE INDEX IF NOT EXISTS idx_provider_break_glass_subject
      ON provider_break_glass_requests(requested_by,state,expires_at);

    CREATE TABLE IF NOT EXISTS provider_resource_classifications (
      id TEXT PRIMARY KEY CHECK(id GLOB 'pprc_[0-9a-f]*'),
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      scope_id INTEGER NOT NULL REFERENCES governance_scopes(id) ON DELETE RESTRICT,
      resource_kind TEXT NOT NULL CHECK(resource_kind IN ('endpoint','host','virtualMachine','artifact','recoveryPoint')),
      resource_id TEXT NOT NULL,
      classification TEXT NOT NULL CHECK(classification IN ('public','internal','confidential','restricted')),
      policy_json TEXT NOT NULL,
      classification_hash TEXT NOT NULL CHECK(length(classification_hash) = 64),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(host_id,resource_kind,resource_id)
    );
    CREATE INDEX IF NOT EXISTS idx_provider_classifications_host
      ON provider_resource_classifications(host_id,classification,updated_at DESC);

    CREATE TABLE IF NOT EXISTS provider_compliance_control_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      scope_id INTEGER NOT NULL REFERENCES governance_scopes(id) ON DELETE RESTRICT,
      subject_kind TEXT NOT NULL CHECK(subject_kind IN ('security_finding','classification','ransomware_posture','privileged_access','remote_session')),
      subject_key TEXT NOT NULL,
      framework TEXT NOT NULL CHECK(framework IN ('CIS','NIST','ISO27001','SOC2','DORA')),
      control_ref TEXT NOT NULL,
      rationale TEXT NOT NULL,
      mapping_hash TEXT NOT NULL UNIQUE CHECK(length(mapping_hash) = 64),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(host_id,subject_kind,subject_key,framework,control_ref)
    );
    CREATE INDEX IF NOT EXISTS idx_provider_compliance_mappings_subject
      ON provider_compliance_control_mappings(host_id,subject_kind,subject_key);

    CREATE TABLE IF NOT EXISTS provider_compliance_exports (
      id TEXT PRIMARY KEY CHECK(id GLOB 'ppce_[0-9a-f]*'),
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      scope_id INTEGER NOT NULL REFERENCES governance_scopes(id) ON DELETE RESTRICT,
      format TEXT NOT NULL CHECK(format IN ('json','pdf')),
      classification TEXT NOT NULL CHECK(classification IN ('public','internal','confidential','restricted')),
      bundle_hash TEXT NOT NULL UNIQUE CHECK(length(bundle_hash) = 64),
      signature TEXT NOT NULL CHECK(length(signature) = 64),
      signature_algorithm TEXT NOT NULL DEFAULT 'HMAC-SHA256' CHECK(signature_algorithm = 'HMAC-SHA256'),
      summary_json TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_provider_compliance_exports_host
      ON provider_compliance_exports(host_id,created_at DESC);

    CREATE TABLE IF NOT EXISTS provider_ransomware_posture_observations (
      id TEXT PRIMARY KEY CHECK(id GLOB 'pprp_[0-9a-f]*'),
      host_id INTEGER NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
      scope_id INTEGER NOT NULL REFERENCES governance_scopes(id) ON DELETE RESTRICT,
      source TEXT NOT NULL CHECK(source IN ('provider','imported_evidence','computed')),
      factors_json TEXT NOT NULL,
      score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100),
      confidence TEXT NOT NULL CHECK(confidence IN ('low','medium','high')),
      evidence_hash TEXT NOT NULL UNIQUE CHECK(length(evidence_hash) = 64),
      observed_at TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_provider_ransomware_posture_host
      ON provider_ransomware_posture_observations(host_id,observed_at DESC);
  `);

  const columns = new Set(db.prepare('PRAGMA table_info(provider_console_sessions)').all().map(row => row.name));
  if (!columns.has('recording_policy')) {
    db.exec("ALTER TABLE provider_console_sessions ADD COLUMN recording_policy TEXT NOT NULL DEFAULT 'metadata' CHECK(recording_policy IN ('metadata','screen'))");
  }
  if (!columns.has('recording_policy_ref')) {
    db.exec('ALTER TABLE provider_console_sessions ADD COLUMN recording_policy_ref TEXT');
  }
  if (!columns.has('recording_consent_at')) {
    db.exec('ALTER TABLE provider_console_sessions ADD COLUMN recording_consent_at TEXT');
  }
  if (!columns.has('recording_state')) {
    db.exec("ALTER TABLE provider_console_sessions ADD COLUMN recording_state TEXT NOT NULL DEFAULT 'metadata_only' CHECK(recording_state IN ('metadata_only','screen_requested','screen_active','screen_unavailable'))");
  }

  const insert = db.prepare(`INSERT OR IGNORE INTO governance_permissions
    (permission_key,resource_type,verb,description) VALUES (?,?,?,?)`);
  for (const permission of PERMISSIONS) insert.run(...permission);
};

exports.down = function (db) {
  db.exec(`
    DROP TABLE IF EXISTS provider_ransomware_posture_observations;
    DROP TABLE IF EXISTS provider_compliance_exports;
    DROP TABLE IF EXISTS provider_compliance_control_mappings;
    DROP TABLE IF EXISTS provider_resource_classifications;
    DROP TABLE IF EXISTS provider_break_glass_requests;
    DROP TABLE IF EXISTS provider_privileged_elevation_grants;
    DROP TABLE IF EXISTS provider_privileged_step_up_attempts;
  `);
  // Console metadata columns remain during a development downgrade; older
  // releases ignore additive columns and rebuilding the session table is riskier.
};

exports._PERMISSIONS = PERMISSIONS;
