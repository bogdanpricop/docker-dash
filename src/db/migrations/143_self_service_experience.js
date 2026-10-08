'use strict';

const PERMISSIONS = [
  ['portal.branding.manage', 'portal_branding', 'manage', 'Configure organization and project self-service branding'],
  ['portal.support.read', 'portal_support', 'read', 'Use contextual help and privacy-safe troubleshooting bundles'],
  ['portal.incident.manage', 'portal_incident', 'manage', 'Acknowledge and temporarily pause personal incident notifications'],
  ['feedback.manage', 'product_feedback', 'manage', 'Control personal opt-in product feedback counters'],
];

const ROLE_PERMISSIONS = {
  'project-viewer': ['portal.support.read', 'feedback.manage'],
  'project-operator': ['portal.support.read', 'portal.incident.manage', 'feedback.manage'],
  'project-admin': ['portal.support.read', 'portal.incident.manage', 'feedback.manage'],
  'site-admin': PERMISSIONS.map(item => item[0]),
};

const HELP_TOPICS = [
  ['proxmox-vm-power', 'proxmox', 'power', 'Proxmox VM power operations', 'Power requests use a durable VM identity and a provider preflight before submission.', ['Confirm the VM is not locked by backup, migration or replication.', 'A guest shutdown depends on a responsive guest agent; forced stop is not a self-service default.'], 'Refresh VM status and recent provider tasks; do not retry while a task is still running.'],
  ['vsphere-vm-power', 'vsphere', 'power', 'vSphere VM power operations', 'Power requests are task-backed and reconciled against the native vCenter task.', ['vCenter permissions and VM connection state are checked at execution time.', 'Guest shutdown requires VMware Tools; power-off is a separate higher-risk action.'], 'Read the native task state and VM connection state before requesting another action.'],
  ['xen-vm-power', 'xen', 'power', 'Xen VM power operations', 'The active Xen management plane determines whether the request uses XO, XAPI or local xl.', ['Pool master changes can invalidate a short-lived plan.', 'Graceful shutdown depends on guest tools and provider support.'], 'Refresh the VM and management-plane capability evidence.'],
  ['vm-snapshot', '*', 'snapshot', 'Snapshot safety', 'Snapshots are short-term change checkpoints, not backups.', ['Provider consolidation may continue after the visible task completes.', 'Available storage and existing snapshot chains affect safety.'], 'Inspect current snapshot state and free storage before creating another snapshot.'],
  ['vm-console', '*', 'console', 'Console access', 'Console authorization creates a short-lived, user-bound launch path and does not expose provider credentials.', ['Clipboard and file transfer depend on provider capability.', 'Console sessions are audited and expire automatically.'], 'Refresh authorization if the launch path expired; never share the URL.'],
  ['vm-provision', '*', 'provision', 'VM provisioning', 'Catalog inputs are validated, costed and bound to an immutable offering version before approval.', ['Fabric targets remain administrator-managed and are intentionally hidden.', 'Quota is checked again before the durable provider operation is submitted.'], 'Run a new read-only fulfillment preflight if inventory or quota changed.'],
];

exports.up = function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS portal_branding_profiles (
      scope_key TEXT PRIMARY KEY,
      tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      display_name TEXT NOT NULL,
      logo_url TEXT,
      accent_color TEXT NOT NULL DEFAULT '#4f8cff',
      support_url TEXT,
      help_url TEXT,
      updated_by INTEGER REFERENCES users(id),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK(scope_key='organization' OR scope_key=printf('project:%d',tenant_id))
    );

    CREATE TABLE IF NOT EXISTS self_service_help_topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_key TEXT NOT NULL UNIQUE,
      provider_type TEXT NOT NULL DEFAULT '*',
      action_key TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      caveats_json TEXT NOT NULL DEFAULT '[]',
      next_safe_test TEXT NOT NULL,
      updated_by INTEGER REFERENCES users(id),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS self_service_troubleshooting_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL UNIQUE,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      request_id INTEGER NOT NULL REFERENCES self_service_requests(id) ON DELETE CASCADE,
      checklist_json TEXT NOT NULL,
      support_bundle_json TEXT NOT NULL,
      bundle_hash TEXT NOT NULL,
      next_safe_test_json TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS self_service_incident_states (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      incident_key TEXT NOT NULL,
      acknowledged_at TEXT,
      paused_until TEXT,
      note TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(user_id,incident_key)
    );

    CREATE TABLE IF NOT EXISTS product_feedback_preferences (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
      usage_enabled INTEGER NOT NULL DEFAULT 1 CHECK(usage_enabled IN (0,1)),
      failure_enabled INTEGER NOT NULL DEFAULT 1 CHECK(failure_enabled IN (0,1)),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS product_feedback_daily (
      event_date TEXT NOT NULL,
      event_key TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('success','failure','cancelled')),
      provider_type TEXT NOT NULL DEFAULT 'unknown',
      event_count INTEGER NOT NULL DEFAULT 0,
      first_recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(event_date,event_key,outcome,provider_type)
    );

    CREATE INDEX IF NOT EXISTS idx_self_service_help_context ON self_service_help_topics(provider_type,action_key);
    CREATE INDEX IF NOT EXISTS idx_self_service_troubleshooting_request ON self_service_troubleshooting_sessions(request_id,created_at);
    CREATE INDEX IF NOT EXISTS idx_product_feedback_daily_date ON product_feedback_daily(event_date,event_key);
  `);

  const permissionInsert = db.prepare(`INSERT OR IGNORE INTO governance_permissions
    (permission_key,resource_type,verb,description) VALUES (?,?,?,?)`);
  for (const permission of PERMISSIONS) permissionInsert.run(...permission);
  const roleId = db.prepare('SELECT id FROM governance_roles WHERE slug=?');
  const grant = db.prepare('INSERT OR IGNORE INTO governance_role_permissions (role_id,permission_key) VALUES (?,?)');
  for (const [slug, permissions] of Object.entries(ROLE_PERMISSIONS)) {
    const role = roleId.get(slug);
    if (role) for (const permission of permissions) grant.run(role.id, permission);
  }

  const help = db.prepare(`INSERT OR IGNORE INTO self_service_help_topics
    (topic_key,provider_type,action_key,title,summary,caveats_json,next_safe_test) VALUES (?,?,?,?,?,?,?)`);
  for (const item of HELP_TOPICS) help.run(item[0], item[1], item[2], item[3], item[4], JSON.stringify(item[5]), item[6]);
};

exports._PERMISSIONS = PERMISSIONS;
exports._ROLE_PERMISSIONS = ROLE_PERMISSIONS;
exports._HELP_TOPICS = HELP_TOPICS;
