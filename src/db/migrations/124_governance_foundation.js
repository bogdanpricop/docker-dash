'use strict';

// v8.49.0 — V4.6a governance foundation (B176–B185).
// Additive tables only. Existing tenants/user_tenants remain authoritative.

const PERMISSIONS = [
  ['governance.read', 'governance', 'read', 'View governance catalog and accessible scopes'],
  ['scope.manage', 'scope', 'manage', 'Create descendant governance scopes'],
  ['role.manage', 'role', 'manage', 'Create and edit custom governance roles'],
  ['binding.manage', 'binding', 'manage', 'Delegate roles within an authorized scope'],
  ['project.create', 'project', 'create', 'Create projects below an authorized scope'],
  ['project.read', 'project', 'read', 'View project membership, resources and quotas'],
  ['project.update', 'project', 'update', 'Update project metadata and lifecycle'],
  ['project.members.manage', 'project_member', 'manage', 'Add and remove project members'],
  ['project.resources.manage', 'project_resource', 'manage', 'Assign accounting resources to projects'],
  ['project.invitations.manage', 'project_invitation', 'manage', 'Create and revoke project invitations'],
  ['project.ownership.transfer', 'project_owner', 'transfer', 'Transfer project ownership'],
  ['project.quotas.manage', 'project_quota', 'manage', 'Configure project CPU, memory and storage quotas'],
];

const BUILTIN_ROLES = [
  ['project-viewer', 'Project Viewer', 'Read-only project access', ['governance.read', 'project.read']],
  ['project-operator', 'Project Operator', 'Operate project membership and accounting resources', [
    'governance.read', 'project.read', 'project.update', 'project.resources.manage',
  ]],
  ['project-admin', 'Project Admin', 'Administer one project without organization privileges', [
    'governance.read', 'binding.manage', 'project.read', 'project.update',
    'project.members.manage', 'project.resources.manage', 'project.invitations.manage',
    'project.ownership.transfer', 'project.quotas.manage',
  ]],
  ['site-admin', 'Site Admin', 'Administer scopes and projects below one delegated site', [
    'governance.read', 'scope.manage', 'binding.manage', 'project.create', 'project.read',
    'project.update', 'project.members.manage', 'project.resources.manage',
    'project.invitations.manage', 'project.ownership.transfer', 'project.quotas.manage',
  ]],
];

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS governance_permissions (
      permission_key TEXT PRIMARY KEY,
      resource_type TEXT NOT NULL,
      verb TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS governance_roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      description TEXT,
      is_builtin INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS governance_role_permissions (
      role_id INTEGER NOT NULL REFERENCES governance_roles(id) ON DELETE CASCADE,
      permission_key TEXT NOT NULL REFERENCES governance_permissions(permission_key) ON DELETE RESTRICT,
      PRIMARY KEY (role_id, permission_key)
    );

    CREATE TABLE IF NOT EXISTS governance_scopes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_type TEXT NOT NULL CHECK(scope_type IN ('organization','site','provider','cluster','project','resource')),
      scope_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      parent_id INTEGER REFERENCES governance_scopes(id) ON DELETE RESTRICT,
      tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(scope_type, scope_key),
      CHECK((scope_type = 'organization' AND parent_id IS NULL) OR (scope_type <> 'organization' AND parent_id IS NOT NULL)),
      CHECK((scope_type = 'project' AND tenant_id IS NOT NULL) OR scope_type <> 'project')
    );
    CREATE INDEX IF NOT EXISTS idx_governance_scopes_parent ON governance_scopes(parent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_governance_scopes_tenant
      ON governance_scopes(tenant_id) WHERE scope_type = 'project';

    CREATE TABLE IF NOT EXISTS governance_role_bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role_id INTEGER NOT NULL REFERENCES governance_roles(id) ON DELETE CASCADE,
      scope_id INTEGER NOT NULL REFERENCES governance_scopes(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
      expires_at TEXT,
      granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK((user_id IS NOT NULL) + (team_id IS NOT NULL) = 1)
    );
    CREATE INDEX IF NOT EXISTS idx_governance_bindings_user ON governance_role_bindings(user_id, scope_id);
    CREATE INDEX IF NOT EXISTS idx_governance_bindings_team ON governance_role_bindings(team_id, scope_id);

    CREATE TABLE IF NOT EXISTS governance_project_resources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      provider_host_id INTEGER NOT NULL DEFAULT 0,
      resource_type TEXT NOT NULL,
      resource_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      cpu_millicores INTEGER NOT NULL DEFAULT 0 CHECK(cpu_millicores >= 0),
      memory_bytes INTEGER NOT NULL DEFAULT 0 CHECK(memory_bytes >= 0),
      storage_bytes INTEGER NOT NULL DEFAULT 0 CHECK(storage_bytes >= 0),
      metadata_json TEXT NOT NULL DEFAULT '{}',
      assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(provider_host_id, resource_type, resource_key)
    );
    CREATE INDEX IF NOT EXISTS idx_governance_resources_tenant ON governance_project_resources(tenant_id);

    CREATE TABLE IF NOT EXISTS governance_project_quotas (
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      metric TEXT NOT NULL CHECK(metric IN ('cpu_millicores','memory_bytes','storage_bytes')),
      soft_limit INTEGER CHECK(soft_limit IS NULL OR soft_limit >= 0),
      hard_limit INTEGER CHECK(hard_limit IS NULL OR hard_limit >= 0),
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tenant_id, metric),
      CHECK(soft_limit IS NULL OR hard_limit IS NULL OR soft_limit <= hard_limit)
    );

    CREATE TABLE IF NOT EXISTS governance_project_invitations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      email TEXT,
      email_domain TEXT,
      member_role TEXT NOT NULL DEFAULT 'viewer' CHECK(member_role IN ('admin','operator','viewer')),
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      accepted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      accepted_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK(email IS NOT NULL OR email_domain IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_governance_invitations_tenant ON governance_project_invitations(tenant_id);
  `);

  const permissionInsert = db.prepare(`
    INSERT OR IGNORE INTO governance_permissions
      (permission_key, resource_type, verb, description) VALUES (?, ?, ?, ?)
  `);
  for (const permission of PERMISSIONS) permissionInsert.run(...permission);

  const roleInsert = db.prepare(`
    INSERT OR IGNORE INTO governance_roles (slug, name, description, is_builtin)
    VALUES (?, ?, ?, 1)
  `);
  const roleId = db.prepare('SELECT id FROM governance_roles WHERE slug = ?');
  const rolePermission = db.prepare(`
    INSERT OR IGNORE INTO governance_role_permissions (role_id, permission_key) VALUES (?, ?)
  `);
  for (const [slug, name, description, permissions] of BUILTIN_ROLES) {
    roleInsert.run(slug, name, description);
    const role = roleId.get(slug);
    for (const permission of permissions) rolePermission.run(role.id, permission);
  }

  db.prepare(`
    INSERT OR IGNORE INTO governance_scopes
      (id, scope_type, scope_key, display_name, parent_id, metadata_json)
    VALUES (1, 'organization', 'default', 'Docker Dash', NULL, '{}')
  `).run();

  const projects = db.prepare('SELECT id, slug, name FROM tenants ORDER BY id').all();
  const projectScope = db.prepare(`
    INSERT OR IGNORE INTO governance_scopes
      (scope_type, scope_key, display_name, parent_id, tenant_id, metadata_json)
    VALUES ('project', ?, ?, 1, ?, '{}')
  `);
  for (const project of projects) projectScope.run(`tenant:${project.id}`, project.name, project.id);
};

exports._PERMISSIONS = PERMISSIONS;
exports._BUILTIN_ROLES = BUILTIN_ROLES;
