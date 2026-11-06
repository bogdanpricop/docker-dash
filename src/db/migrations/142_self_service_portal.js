'use strict';

const crypto = require('crypto');

const PERMISSIONS = [
  ['catalog.read', 'infrastructure_catalog', 'read', 'Browse published infrastructure service catalog offerings'],
  ['catalog.manage', 'infrastructure_catalog', 'manage', 'Create, version, publish and retire infrastructure offerings'],
  ['self_service.read', 'self_service_request', 'read', 'View project dashboards and self-service request timelines'],
  ['self_service.request', 'self_service_request', 'create', 'Request project-scoped infrastructure and lifecycle actions'],
  ['self_service.approve', 'self_service_request', 'approve', 'Approve or reject self-service infrastructure requests'],
  ['self_service.fulfill', 'self_service_request', 'fulfill', 'Preflight and submit approved requests to the provider operation engine'],
];

const ROLE_PERMISSIONS = {
  'project-viewer': ['catalog.read', 'self_service.read'],
  'project-operator': ['catalog.read', 'self_service.read', 'self_service.request'],
  'project-admin': ['catalog.read', 'self_service.read', 'self_service.request'],
  'site-admin': PERMISSIONS.map(item => item[0]),
};

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((out, key) => {
    out[key] = stable(value[key]); return out;
  }, {});
  return value;
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

const SEEDS = [
  {
    slug: 'standard-vm', name: 'Standard VM', kind: 'vm', owner: 'Platform Engineering',
    description: 'Policy-scoped virtual machine created from an administrator-approved provider template.',
    form: { fields: [
      { key: 'name', label: 'VM name', type: 'string', required: true, minLength: 2, maxLength: 80, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' },
      { key: 'cpu', label: 'vCPU', type: 'integer', required: true, minimum: 1, maximum: 32, default: 2 },
      { key: 'memoryGiB', label: 'Memory (GiB)', type: 'integer', required: true, minimum: 1, maximum: 256, default: 4 },
      { key: 'storageGiB', label: 'Storage (GiB)', type: 'integer', required: true, minimum: 10, maximum: 4096, default: 40 },
      { key: 'environment', label: 'Environment', type: 'enum', required: true, options: ['nonproduction', 'production'], default: 'nonproduction' },
      { key: 'backup', label: 'Daily backup', type: 'boolean', default: true, visibleWhen: { field: 'environment', equals: 'production' } },
    ] },
    compatibility: { providerTypes: ['proxmox', 'vsphere', 'xen'], note: 'An administrator must bind at least one approved template target before requests can be submitted.' },
    offering: { requestKind: 'vm_provision', targets: [] },
    cost: { currency: 'EUR', period: 'month', base: 0, perCpu: 4.5, perMemoryGiB: 1.8, perStorageGiB: 0.08, backup: 3 },
  },
  {
    slug: 'compose-application', name: 'Compose Application', kind: 'application', owner: 'Platform Engineering',
    description: 'Curated application offering with policy-visible inputs and compatibility metadata.',
    form: { fields: [{ key: 'name', label: 'Application name', type: 'string', required: true, minLength: 2, maxLength: 80 }] },
    compatibility: { runtimes: ['docker-compose'], fulfillment: 'catalog-workflow-required' },
    offering: { requestKind: 'application', targets: [] }, cost: { currency: 'EUR', period: 'month', base: 0 },
  },
  {
    slug: 'managed-cluster', name: 'Managed Cluster', kind: 'cluster', owner: 'Platform Engineering',
    description: 'Versioned cluster offering reserved for an administrator-configured fulfillment workflow.',
    form: { fields: [{ key: 'name', label: 'Cluster name', type: 'string', required: true, minLength: 2, maxLength: 80 }] },
    compatibility: { runtimes: ['kubernetes'], fulfillment: 'catalog-workflow-required' },
    offering: { requestKind: 'cluster', targets: [] }, cost: { currency: 'EUR', period: 'month', base: 0 },
  },
];

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS infrastructure_catalog_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('vm','application','cluster')),
      owner TEXT NOT NULL,
      description TEXT NOT NULL,
      lifecycle TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle IN ('active','deprecated','retired')),
      current_version_id INTEGER,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS infrastructure_catalog_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES infrastructure_catalog_items(id) ON DELETE CASCADE,
      version TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','published','deprecated','retired')),
      changelog TEXT NOT NULL,
      compatibility_json TEXT NOT NULL,
      form_schema_json TEXT NOT NULL,
      offering_json TEXT NOT NULL,
      cost_model_json TEXT NOT NULL,
      version_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      published_at TEXT,
      UNIQUE(item_id,version)
    );

    CREATE TABLE IF NOT EXISTS self_service_project_policies (
      tenant_id INTEGER PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
      allowed_item_slugs_json TEXT NOT NULL DEFAULT '[]',
      allowed_actions_json TEXT NOT NULL DEFAULT '["start","shutdown","reboot","snapshot","console"]',
      maximum_risk INTEGER NOT NULL DEFAULT 3 CHECK(maximum_risk BETWEEN 1 AND 4),
      require_approval INTEGER NOT NULL DEFAULT 1 CHECK(require_approval IN (0,1)),
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS self_service_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_key TEXT NOT NULL UNIQUE,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      catalog_version_id INTEGER REFERENCES infrastructure_catalog_versions(id) ON DELETE RESTRICT,
      request_kind TEXT NOT NULL CHECK(request_kind IN ('vm_provision','lifecycle')),
      action_key TEXT NOT NULL,
      resource_ref TEXT,
      request_json TEXT NOT NULL,
      normalized_diff_json TEXT NOT NULL,
      cost_preview_json TEXT NOT NULL,
      hidden_target_json TEXT NOT NULL DEFAULT '{}',
      risk INTEGER NOT NULL CHECK(risk BETWEEN 1 AND 4),
      approval_request_id INTEGER UNIQUE REFERENCES governance_approval_requests(id) ON DELETE RESTRICT,
      provider_operation_id TEXT,
      state TEXT NOT NULL DEFAULT 'requested' CHECK(state IN ('requested','approved','rejected','running','validated','failed','cancelled','expired')),
      requested_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      fulfilled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      expires_at TEXT NOT NULL,
      validated_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS self_service_request_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL REFERENCES self_service_requests(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      state TEXT NOT NULL,
      event_type TEXT NOT NULL,
      message TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(request_id,sequence)
    );

    CREATE TABLE IF NOT EXISTS self_service_basket_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_key TEXT NOT NULL,
      resource_kind TEXT NOT NULL CHECK(resource_kind IN ('virtual-machine','container','image','volume','network')),
      host_id INTEGER,
      resource_ref TEXT NOT NULL,
      display_name TEXT NOT NULL,
      compatibility_json TEXT NOT NULL DEFAULT '{}',
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id,item_key)
    );

    CREATE INDEX IF NOT EXISTS idx_catalog_versions_item ON infrastructure_catalog_versions(item_id,state,created_at);
    CREATE INDEX IF NOT EXISTS idx_self_service_requests_project ON self_service_requests(tenant_id,state,created_at);
    CREATE INDEX IF NOT EXISTS idx_self_service_requests_approval ON self_service_requests(approval_request_id);
    CREATE INDEX IF NOT EXISTS idx_self_service_events_request ON self_service_request_events(request_id,sequence);
    CREATE INDEX IF NOT EXISTS idx_self_service_basket_user ON self_service_basket_items(user_id,added_at);
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

  const insertItem = db.prepare(`INSERT OR IGNORE INTO infrastructure_catalog_items
    (slug,name,kind,owner,description,lifecycle) VALUES (?,?,?,?,?,'active')`);
  const itemBySlug = db.prepare('SELECT id FROM infrastructure_catalog_items WHERE slug=?');
  const insertVersion = db.prepare(`INSERT OR IGNORE INTO infrastructure_catalog_versions
    (item_id,version,state,changelog,compatibility_json,form_schema_json,offering_json,cost_model_json,version_hash,published_at)
    VALUES (?,'1.0.0','published','Initial curated offering',?,?,?,?,?,datetime('now'))`);
  for (const seed of SEEDS) {
    insertItem.run(seed.slug, seed.name, seed.kind, seed.owner, seed.description);
    const item = itemBySlug.get(seed.slug);
    const content = { slug: seed.slug, version: '1.0.0', compatibility: seed.compatibility, form: seed.form, offering: seed.offering, cost: seed.cost };
    insertVersion.run(item.id, JSON.stringify(seed.compatibility), JSON.stringify(seed.form), JSON.stringify(seed.offering), JSON.stringify(seed.cost), digest(content));
    const version = db.prepare("SELECT id FROM infrastructure_catalog_versions WHERE item_id=? AND version='1.0.0'").get(item.id);
    db.prepare('UPDATE infrastructure_catalog_items SET current_version_id=COALESCE(current_version_id,?) WHERE id=?').run(version.id, item.id);
  }
};

exports._PERMISSIONS = PERMISSIONS;
exports._ROLE_PERMISSIONS = ROLE_PERMISSIONS;
exports._SEEDS = SEEDS;
exports._stable = stable;
