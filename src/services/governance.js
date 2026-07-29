'use strict';

// v8.49.0 — V4.6a governance foundation (B176–B185).
// This service is deliberately accounting-only: it never changes provider
// resources. Project assignments are an explicit, audited control-plane view.

const crypto = require('crypto');
const { getDb } = require('../db');
const teamsService = require('./teams');

const PROJECT_MEMBER_ROLES = new Set(['admin', 'operator', 'viewer']);
const QUOTA_METRICS = ['cpu_millicores', 'memory_bytes', 'storage_bytes'];
const SCOPE_CHILDREN = Object.freeze({
  organization: new Set(['site', 'provider', 'project']),
  site: new Set(['provider', 'cluster', 'project']),
  provider: new Set(['cluster', 'project', 'resource']),
  cluster: new Set(['project', 'resource']),
  project: new Set(['resource']),
  resource: new Set(),
});
const MEMBER_ROLE_BINDINGS = Object.freeze({
  viewer: 'project-viewer',
  operator: 'project-operator',
  admin: 'project-admin',
});

class GovernanceError extends Error {
  constructor(message, status = 400, code, details) {
    super(message);
    this.name = 'GovernanceError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(message, status = 400, code, details) {
  return new GovernanceError(message, status, code, details);
}

function integer(value, field, { min = 0, required = true } = {}) {
  if (value === null || value === undefined || value === '') {
    if (!required) return null;
    throw fail(`${field} is required`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min) throw fail(`${field} must be a non-negative safe integer`);
  return parsed;
}

function text(value, field, max = 160, { required = true } = {}) {
  const normalized = String(value || '').trim().replace(/[\r\n\t]+/g, ' ');
  if (!normalized && required) throw fail(`${field} is required`);
  if (normalized.length > max) throw fail(`${field} is too long`);
  return normalized || null;
}

function iso(value, field, { required = false, future = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw fail(`${field} is required`);
    return null;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw fail(`${field} must be a valid timestamp`);
  if (future && parsed <= Date.now()) throw fail(`${field} must be in the future`);
  return new Date(parsed).toISOString();
}

function projectSlug(value) {
  const slug = text(value, 'slug', 80).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/.test(slug)) {
    throw fail('slug must contain 3–80 lowercase letters, digits, or hyphens');
  }
  return slug;
}

class GovernanceService {
  constructor(dbProvider = getDb) {
    this._dbProvider = dbProvider;
  }

  _db() { return this._dbProvider(); }

  _scope(scopeId) {
    const id = integer(scopeId, 'scopeId', { min: 1 });
    const scope = this._db().prepare('SELECT * FROM governance_scopes WHERE id = ?').get(id);
    if (!scope) throw fail('Governance scope not found', 404);
    return scope;
  }

  _project(tenantId) {
    const id = integer(tenantId, 'tenantId', { min: 1 });
    const project = this._db().prepare('SELECT * FROM tenants WHERE id = ?').get(id);
    if (!project) throw fail('Project not found', 404);
    return project;
  }

  _scopeChain(scopeId) {
    const chain = [];
    const seen = new Set();
    let current = this._scope(scopeId);
    while (current) {
      if (seen.has(current.id)) throw fail('Governance scope hierarchy contains a cycle', 409);
      seen.add(current.id);
      chain.push(current);
      current = current.parent_id == null ? null
        : this._db().prepare('SELECT * FROM governance_scopes WHERE id = ?').get(current.parent_id);
    }
    return chain;
  }

  listPermissions() {
    return this._db().prepare(`SELECT permission_key, resource_type, verb, description
      FROM governance_permissions ORDER BY permission_key`).all().map(permission => ({
      ...permission,
      key: permission.permission_key,
      resourceType: permission.resource_type,
    }));
  }

  catalog(user) {
    if (!user?.id) throw fail('Authenticated user is required', 401);
    return {
      globalAdmin: user.role === 'admin',
      permissions: this.listPermissions(),
      roles: this.listRoles(),
      scopeTypes: Object.keys(SCOPE_CHILDREN),
      quotaMetrics: [...QUOTA_METRICS],
    };
  }

  subjects(user) {
    if (!user?.id) throw fail('Authenticated user is required', 401);
    if (user.role !== 'admin') {
      const canDelegateSomewhere = this.listScopes(user).some(scope => this.can(user, scope.id, 'binding.manage'));
      if (!canDelegateSomewhere) throw fail('Insufficient governance permission', 403, 'GOVERNANCE_FORBIDDEN');
    }
    return {
      users: this._db().prepare(`SELECT id, username, display_name, email FROM users
        WHERE is_active = 1 ORDER BY username`).all(),
      teams: this._db().prepare('SELECT id, name, description FROM teams ORDER BY name COLLATE NOCASE').all(),
    };
  }

  listRoles() {
    const roles = this._db().prepare(`SELECT id, slug, name, description, is_builtin, created_by, created_at, updated_at
      FROM governance_roles ORDER BY is_builtin DESC, name COLLATE NOCASE`).all();
    const permissions = this._db().prepare(`SELECT role_id, permission_key FROM governance_role_permissions
      ORDER BY permission_key`).all();
    const grouped = new Map();
    for (const row of permissions) {
      if (!grouped.has(row.role_id)) grouped.set(row.role_id, []);
      grouped.get(row.role_id).push(row.permission_key);
    }
    const bindingCounts = new Map(this._db().prepare(`SELECT role_id, COUNT(*) AS count
      FROM governance_role_bindings GROUP BY role_id`).all()
      .map(row => [row.role_id, Number(row.count)]));
    return roles.map(role => ({
      ...role,
      is_builtin: !!role.is_builtin,
      isBuiltin: !!role.is_builtin,
      createdBy: role.created_by,
      createdAt: role.created_at,
      updatedAt: role.updated_at,
      bindingCount: bindingCounts.get(role.id) || 0,
      permissions: grouped.get(role.id) || [],
    }));
  }

  _role(roleId) {
    const role = this._db().prepare('SELECT * FROM governance_roles WHERE id = ?').get(integer(roleId, 'roleId', { min: 1 }));
    if (!role) throw fail('Governance role not found', 404);
    role.is_builtin = !!role.is_builtin;
    role.isBuiltin = role.is_builtin;
    role.permissions = this._db().prepare(`SELECT permission_key FROM governance_role_permissions
      WHERE role_id = ? ORDER BY permission_key`).all(role.id).map(row => row.permission_key);
    return role;
  }

  _validatePermissionSet(permissions) {
    if (!Array.isArray(permissions) || !permissions.length) throw fail('At least one catalog permission is required');
    const unique = [...new Set(permissions.map(permission => String(permission || '').trim()))];
    const known = new Set(this.listPermissions().map(permission => permission.permission_key));
    if (unique.some(permission => !known.has(permission))) throw fail('Role contains an unknown catalog permission', 400, 'UNKNOWN_PERMISSION');
    return unique.sort();
  }

  createRole({ slug, name, description, permissions }, actor) {
    if (!actor?.id) throw fail('Authenticated user is required', 401);
    if (actor.role !== 'admin') this.assertCan(actor, 1, 'role.manage');
    const safeSlug = projectSlug(slug);
    const safeName = text(name, 'name', 120);
    const safeDescription = text(description, 'description', 600, { required: false });
    const permissionSet = this._validatePermissionSet(permissions);
    const db = this._db();
    return db.transaction(() => {
      const result = db.prepare(`INSERT INTO governance_roles (slug, name, description, created_by)
        VALUES (?, ?, ?, ?)`).run(safeSlug, safeName, safeDescription, actor.id);
      const roleId = Number(result.lastInsertRowid);
      const insert = db.prepare('INSERT INTO governance_role_permissions (role_id, permission_key) VALUES (?, ?)');
      for (const permission of permissionSet) insert.run(roleId, permission);
      return this._role(roleId);
    })();
  }

  updateRole(roleId, { name, description, permissions }, actor) {
    if (!actor?.id) throw fail('Authenticated user is required', 401);
    if (actor.role !== 'admin') this.assertCan(actor, 1, 'role.manage');
    const role = this._role(roleId);
    if (role.is_builtin) throw fail('Built-in governance roles cannot be edited', 409, 'BUILTIN_ROLE_IMMUTABLE');
    const db = this._db();
    const nextName = name === undefined ? role.name : text(name, 'name', 120);
    const nextDescription = description === undefined ? role.description : text(description, 'description', 600, { required: false });
    const nextPermissions = permissions === undefined ? role.permissions : this._validatePermissionSet(permissions);
    return db.transaction(() => {
      db.prepare(`UPDATE governance_roles SET name = ?, description = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(nextName, nextDescription, role.id);
      db.prepare('DELETE FROM governance_role_permissions WHERE role_id = ?').run(role.id);
      const insert = db.prepare('INSERT INTO governance_role_permissions (role_id, permission_key) VALUES (?, ?)');
      for (const permission of nextPermissions) insert.run(role.id, permission);
      return this._role(role.id);
    })();
  }

  deleteRole(roleId, actor) {
    if (!actor?.id) throw fail('Authenticated user is required', 401);
    if (actor.role !== 'admin') this.assertCan(actor, 1, 'role.manage');
    const role = this._role(roleId);
    if (role.is_builtin) throw fail('Built-in governance roles cannot be deleted', 409, 'BUILTIN_ROLE_IMMUTABLE');
    const bindings = this._db().prepare('SELECT COUNT(*) AS count FROM governance_role_bindings WHERE role_id = ?').get(role.id).count;
    if (bindings) throw fail('Role is still assigned to one or more subjects', 409);
    this._db().prepare('DELETE FROM governance_roles WHERE id = ?').run(role.id);
    return { ok: true };
  }

  listScopes(user) {
    if (!user?.id) throw fail('Authenticated user is required', 401);
    const scopes = this._db().prepare(`SELECT s.*, parent.scope_key AS parent_key, parent.display_name AS parent_name,
      (SELECT COUNT(*) FROM governance_scopes child WHERE child.parent_id = s.id) AS child_count
      FROM governance_scopes s LEFT JOIN governance_scopes parent ON parent.id = s.parent_id
      ORDER BY s.scope_type, s.display_name COLLATE NOCASE`).all().map(scope => ({
      ...scope,
      type: scope.scope_type,
      key: scope.scope_key,
      name: scope.display_name,
      parentId: scope.parent_id,
      parentName: scope.parent_name,
      tenantId: scope.tenant_id,
      childCount: Number(scope.child_count || 0),
      metadata: this._json(scope.metadata_json),
    }));
    const visible = user.role === 'admin'
      ? scopes
      : scopes.filter(scope => this.can(user, scope.id, 'governance.read'));
    return visible.map(scope => ({
      ...scope,
      effectivePermissions: [...this.effectivePermissions(user, scope.id)],
    }));
  }

  createScope({ scopeType, type: legacyType, scopeKey, key: legacyKey, displayName, name: legacyName, parentId, metadata }, actor) {
    const type = String(scopeType || legacyType || '').trim().toLowerCase();
    if (!Object.hasOwn(SCOPE_CHILDREN, type) || type === 'organization' || type === 'project') {
      throw fail('scopeType must be a non-project descendant scope');
    }
    const parent = this._scope(parentId);
    if (!actor?.id) throw fail('Authenticated user is required', 401);
    if (actor.role !== 'admin') this.assertCan(actor, parent.id, 'scope.manage');
    if (!SCOPE_CHILDREN[parent.scope_type].has(type)) {
      throw fail(`A ${type} scope cannot be created below ${parent.scope_type}`, 409);
    }
    const key = text(scopeKey || legacyKey, 'scopeKey', 160);
    const name = text(displayName || legacyName, 'displayName', 160);
    const metadataJson = this._metadata(metadata);
    try {
      const result = this._db().prepare(`INSERT INTO governance_scopes
        (scope_type, scope_key, display_name, parent_id, metadata_json, created_by)
        VALUES (?, ?, ?, ?, ?, ?)`).run(type, key, name, parent.id, metadataJson, actor.id);
      return this._scope(Number(result.lastInsertRowid));
    } catch (err) {
      if (/unique/i.test(err.message)) throw fail('A governance scope with this type and key already exists', 409);
      throw err;
    }
  }

  effectivePermissions(user, scopeId) {
    if (!user?.id) throw fail('Authenticated user is required', 401);
    if (user.role === 'admin') return new Set(['*']);
    const chain = this._scopeChain(scopeId);
    const ids = chain.map(scope => scope.id);
    const teams = teamsService.teamsForUser(user.id);
    const subjectSql = teams.length
      ? '(b.user_id = ? OR b.team_id IN (' + teams.map(() => '?').join(',') + '))'
      : 'b.user_id = ?';
    const rows = this._db().prepare(`SELECT DISTINCT rp.permission_key
      FROM governance_role_bindings b
      JOIN governance_role_permissions rp ON rp.role_id = b.role_id
      WHERE b.scope_id IN (${ids.map(() => '?').join(',')})
        AND ${subjectSql}
        AND (b.expires_at IS NULL OR datetime(b.expires_at) > datetime('now'))`)
      .all(...ids, user.id, ...teams);
    const permissions = new Set(rows.map(row => row.permission_key));
    for (const scope of chain.filter(item => item.scope_type === 'project' && item.tenant_id)) {
      const membership = this._membership(user.id, scope.tenant_id);
      if (!membership) continue;
      const roleSlug = MEMBER_ROLE_BINDINGS[membership.role];
      const rolePermissions = this._db().prepare(`SELECT rp.permission_key FROM governance_roles r
        JOIN governance_role_permissions rp ON rp.role_id = r.id WHERE r.slug = ?`).all(roleSlug);
      for (const permission of rolePermissions) permissions.add(permission.permission_key);
    }
    return new Set([...permissions].sort());
  }

  can(user, scopeId, permission) {
    const permissions = this.effectivePermissions(user, scopeId);
    return permissions.has('*') || permissions.has(permission);
  }

  hasPermission(user, permission, scopeId) {
    return this.can(user, scopeId, permission);
  }

  assertCan(user, scopeId, permission) {
    if (!this.can(user, scopeId, permission)) throw fail('Insufficient governance permission', 403, 'GOVERNANCE_PERMISSION_DENIED');
  }

  assignBinding({ roleId, scopeId, userId, teamId, expiresAt }, actor) {
    const role = this._role(roleId);
    const scope = this._scope(scopeId);
    if (!actor?.id) throw fail('Authenticated user is required', 401);
    if (actor.role !== 'admin') {
      this.assertCan(actor, scope.id, 'binding.manage');
      const own = new Set(this.effectivePermissions(actor, scope.id));
      if (role.permissions.some(permission => !own.has(permission))) {
        throw fail('Cannot delegate permissions you do not hold on this scope', 403, 'GOVERNANCE_PERMISSION_DENIED');
      }
    }
    const subjectCount = (userId != null ? 1 : 0) + (teamId != null ? 1 : 0);
    if (subjectCount !== 1) throw fail('Exactly one of userId or teamId is required');
    const expiry = iso(expiresAt, 'expiresAt', { future: true });
    const db = this._db();
    if (userId != null && !db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(integer(userId, 'userId', { min: 1 }))) {
      throw fail('Active user not found', 404);
    }
    if (teamId != null && !db.prepare('SELECT id FROM teams WHERE id = ?').get(integer(teamId, 'teamId', { min: 1 }))) {
      throw fail('Team not found', 404);
    }
    const existing = db.prepare(`SELECT id FROM governance_role_bindings WHERE role_id = ? AND scope_id = ?
      AND user_id IS ? AND team_id IS ?`).get(role.id, scope.id, userId == null ? null : Number(userId), teamId == null ? null : Number(teamId));
    if (existing) {
      db.prepare(`UPDATE governance_role_bindings SET expires_at = ?, granted_by = ? WHERE id = ?`)
        .run(expiry, actor.id, existing.id);
      return { ...db.prepare('SELECT * FROM governance_role_bindings WHERE id = ?').get(existing.id), updated: true };
    }
    const result = db.prepare(`INSERT INTO governance_role_bindings
      (role_id, scope_id, user_id, team_id, expires_at, granted_by) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(role.id, scope.id, userId == null ? null : Number(userId), teamId == null ? null : Number(teamId), expiry, actor.id);
    return { ...db.prepare('SELECT * FROM governance_role_bindings WHERE id = ?').get(Number(result.lastInsertRowid)), updated: false };
  }

  createBinding(data, actor) { return this.assignBinding(data, actor); }

  listBindings(scopeId, actor) {
    const scope = this._scope(scopeId);
    if (!actor?.id) throw fail('Authenticated user is required', 401);
    if (actor.role !== 'admin') this.assertCan(actor, scope.id, 'governance.read');
    return this._db().prepare(`SELECT b.*, r.slug AS role_slug, r.name AS role_name,
      u.username, t.name AS team_name
      FROM governance_role_bindings b
      JOIN governance_roles r ON r.id = b.role_id
      LEFT JOIN users u ON u.id = b.user_id
      LEFT JOIN teams t ON t.id = b.team_id
      WHERE b.scope_id = ? ORDER BY r.name, u.username, t.name`).all(scope.id).map(binding => ({
      ...binding,
      roleId: binding.role_id,
      roleSlug: binding.role_slug,
      roleName: binding.role_name,
      scopeId: binding.scope_id,
      userId: binding.user_id,
      teamId: binding.team_id,
      teamName: binding.team_name,
      expiresAt: binding.expires_at,
      grantedBy: binding.granted_by,
      createdAt: binding.created_at,
    }));
  }

  revokeBinding(bindingId) {
    const result = this._db().prepare('DELETE FROM governance_role_bindings WHERE id = ?')
      .run(integer(bindingId, 'bindingId', { min: 1 }));
    return result.changes > 0;
  }

  deleteBinding(bindingId, actor) {
    const binding = this._db().prepare('SELECT * FROM governance_role_bindings WHERE id = ?')
      .get(integer(bindingId, 'bindingId', { min: 1 }));
    if (!binding) throw fail('Governance binding not found', 404);
    if (!actor?.id) throw fail('Authenticated user is required', 401);
    if (actor.role !== 'admin') this.assertCan(actor, binding.scope_id, 'binding.manage');
    return { ok: this.revokeBinding(binding.id) };
  }

  listProjects(user) {
    const projects = this._db().prepare(`SELECT t.*, s.id AS scope_id FROM tenants t
      JOIN governance_scopes s ON s.tenant_id = t.id AND s.scope_type = 'project'
      ORDER BY t.name COLLATE NOCASE`).all();
    return projects.filter(project => user?.role === 'admin' || this.can(user, project.scope_id, 'project.read'))
      .map(project => this.projectSummary(project.id));
  }

  projectSummary(tenantId) {
    const project = this._project(tenantId);
    const db = this._db();
    const scope = db.prepare(`SELECT s.id, s.parent_id, parent.display_name AS parent_name
      FROM governance_scopes s LEFT JOIN governance_scopes parent ON parent.id = s.parent_id
      WHERE s.tenant_id = ? AND s.scope_type = 'project'`).get(project.id);
    const memberCount = Number(db.prepare('SELECT COUNT(*) AS count FROM user_tenants WHERE tenant_id = ?').get(project.id).count);
    const ownerRow = db.prepare(`SELECT u.id, u.username, u.display_name, u.email
      FROM user_tenants ut JOIN users u ON u.id = ut.user_id
      WHERE ut.tenant_id = ? AND ut.is_owner = 1 ORDER BY ut.created_at LIMIT 1`).get(project.id);
    const owner = ownerRow ? { ...ownerRow, displayName: ownerRow.display_name } : null;
    const usage = this._usage(project.id);
    const quotas = this._quotas(project.id, usage);
    return {
      ...project,
      scope_id: scope?.id || null,
      scopeId: scope?.id || null,
      parent_scope_id: scope?.parent_id || null,
      parentScopeId: scope?.parent_id || null,
      parentScopeName: scope?.parent_name || null,
      usage_mode: project.usage_mode,
      usageMode: project.usage_mode,
      isDefault: !!project.is_default,
      trialExpiresAt: project.trial_expires_at,
      createdBy: project.created_by,
      createdAt: project.created_at,
      updatedAt: project.updated_at,
      memberCount,
      owner,
      usage,
      quotas,
    };
  }

  getProject(tenantId, user) {
    const summary = this.projectSummary(tenantId);
    if (user) {
      if (!user.id) throw fail('Authenticated user is required', 401);
      if (user.role !== 'admin') this.assertCan(user, summary.scope_id, 'project.read');
    }
    const db = this._db();
    const members = db.prepare(`SELECT ut.user_id, u.id AS id, ut.tenant_id, ut.role, ut.is_owner, ut.created_at,
      u.username, u.display_name, u.email, u.is_active
      FROM user_tenants ut JOIN users u ON u.id = ut.user_id
      WHERE ut.tenant_id = ? ORDER BY ut.is_owner DESC, u.username`).all(summary.id)
      .map(member => ({
        ...member,
        is_owner: !!member.is_owner,
        is_active: !!member.is_active,
        userId: member.user_id,
        tenantId: member.tenant_id,
        isOwner: !!member.is_owner,
        isActive: !!member.is_active,
        displayName: member.display_name,
        joinedAt: member.created_at,
      }));
    const resources = db.prepare(`SELECT id, provider_host_id, resource_type, resource_key, display_name,
      cpu_millicores, memory_bytes, storage_bytes, metadata_json, assigned_by, assigned_at, updated_at
      FROM governance_project_resources WHERE tenant_id = ? ORDER BY display_name COLLATE NOCASE`).all(summary.id)
      .map(resource => ({
        ...resource,
        providerHostId: resource.provider_host_id,
        resourceType: resource.resource_type,
        resourceKey: resource.resource_key,
        displayName: resource.display_name,
        cpuMillicores: Number(resource.cpu_millicores || 0),
        memoryBytes: Number(resource.memory_bytes || 0),
        storageBytes: Number(resource.storage_bytes || 0),
        assignedBy: resource.assigned_by,
        assignedAt: resource.assigned_at,
        updatedAt: resource.updated_at,
        metadata: this._json(resource.metadata_json),
      }));
    const owner = members.find(member => member.is_owner) || null;
    const permissions = user ? [...this.effectivePermissions(user, summary.scope_id)] : [];
    return { ...summary, members, resources, owner, memberCount: members.length, permissions };
  }

  createProject({ slug, name, kind, parentScopeId, usageMode }, actor) {
    const safeSlug = projectSlug(slug);
    const safeName = text(name, 'name', 160);
    const safeKind = ['client', 'plant', 'internal'].includes(kind) ? kind : 'internal';
    const safeUsageMode = usageMode == null ? 'production' : String(usageMode).toLowerCase();
    if (!['production', 'trial', 'demo'].includes(safeUsageMode)) throw fail('Project usageMode is invalid');
    const parent = this._scope(parentScopeId || 1);
    if (!actor?.id) throw fail('Authenticated user is required', 401);
    if (actor.role !== 'admin') this.assertCan(actor, parent.id, 'project.create');
    if (!SCOPE_CHILDREN[parent.scope_type].has('project')) throw fail('Projects cannot be created below this scope', 409);
    const db = this._db();
    return db.transaction(() => {
      let project;
      try {
        const result = db.prepare(`INSERT INTO tenants (slug, name, kind, usage_mode, status, created_by)
          VALUES (?, ?, ?, ?, 'active', ? )`).run(safeSlug, safeName, safeKind, safeUsageMode, actor?.username || 'system');
        project = this._project(Number(result.lastInsertRowid));
      } catch (err) {
        if (/unique/i.test(err.message)) throw fail('Project slug already exists', 409);
        throw err;
      }
      db.prepare(`INSERT INTO governance_scopes
        (scope_type, scope_key, display_name, parent_id, tenant_id, metadata_json, created_by)
        VALUES ('project', ?, ?, ?, ?, '{}', ?)`)
        .run(`tenant:${project.id}`, project.name, parent.id, project.id, actor?.id || null);
      if (actor?.id) this._upsertMember(project.id, actor.id, 'admin', true);
      return { ...this.getProject(project.id), parentScopeId: parent.id };
    })();
  }

  updateProjectLifecycle(tenantId, status) {
    const project = this._project(tenantId);
    const next = String(status || '').toLowerCase();
    if (!['active', 'suspended'].includes(next)) throw fail('Project status must be active or suspended');
    this._db().prepare(`UPDATE tenants SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(next, project.id);
    return this.projectSummary(project.id);
  }

  updateProject(tenantId, { name, kind, status, usageMode }, actor) {
    const project = this._project(tenantId);
    const scope = this._projectScope(project.id);
    if (!actor?.id) throw fail('Authenticated user is required', 401);
    if (actor.role !== 'admin') this.assertCan(actor, scope.id, 'project.update');
    const nextName = name === undefined ? project.name : text(name, 'name', 160);
    const nextKind = kind === undefined ? project.kind : String(kind).toLowerCase();
    const nextStatus = status === undefined ? project.status : String(status).toLowerCase();
    const nextUsageMode = usageMode === undefined ? project.usage_mode : String(usageMode).toLowerCase();
    if (!['client', 'plant', 'internal'].includes(nextKind)) throw fail('Project kind is invalid');
    if (!['active', 'suspended'].includes(nextStatus)) throw fail('Project status must be active or suspended');
    if (!['production', 'trial', 'demo'].includes(nextUsageMode)) throw fail('Project usageMode is invalid');
    this._db().prepare(`UPDATE tenants SET name = ?, kind = ?, status = ?, usage_mode = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(nextName, nextKind, nextStatus, nextUsageMode, project.id);
    this._db().prepare(`UPDATE governance_scopes SET display_name = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(nextName, scope.id);
    return this.getProject(project.id);
  }

  _membership(userId, tenantId) {
    const db = this._db();
    const explicit = db.prepare('SELECT role, is_owner FROM user_tenants WHERE user_id = ? AND tenant_id = ?').get(userId, tenantId);
    if (explicit) return { role: explicit.role, isOwner: !!explicit.is_owner };
    const defaultTenant = db.prepare('SELECT is_default FROM tenants WHERE id = ?').get(tenantId);
    return defaultTenant?.is_default ? { role: 'viewer', isOwner: false, implicit: true } : null;
  }

  _projectScope(tenantId) {
    const scope = this._db().prepare(`SELECT * FROM governance_scopes WHERE tenant_id = ? AND scope_type = 'project'`).get(tenantId);
    if (!scope) throw fail('Project governance scope not found', 409);
    return scope;
  }

  _syncMembershipBinding(tenantId, userId, role) {
    const db = this._db();
    const scope = this._projectScope(tenantId);
    const roleRow = db.prepare('SELECT id FROM governance_roles WHERE slug = ?').get(MEMBER_ROLE_BINDINGS[role]);
    db.prepare(`DELETE FROM governance_role_bindings WHERE scope_id = ? AND user_id = ?
      AND granted_by IS NULL AND role_id IN (SELECT id FROM governance_roles WHERE slug IN ('project-viewer','project-operator','project-admin'))`)
      .run(scope.id, userId);
    db.prepare(`INSERT INTO governance_role_bindings (role_id, scope_id, user_id, granted_by)
      VALUES (?, ?, ?, NULL)`).run(roleRow.id, scope.id, userId);
  }

  _upsertMember(tenantId, userId, role, isOwner = false) {
    const db = this._db();
    const activeUser = db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(userId);
    if (!activeUser) throw fail('Active user not found', 404);
    if (!PROJECT_MEMBER_ROLES.has(role)) throw fail('Project member role is invalid');
    db.prepare(`INSERT INTO user_tenants (user_id, tenant_id, role, is_owner)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, tenant_id) DO UPDATE SET role = excluded.role,
        is_owner = CASE WHEN user_tenants.is_owner = 1 THEN 1 ELSE excluded.is_owner END`)
      .run(userId, tenantId, role, isOwner ? 1 : 0);
    this._syncMembershipBinding(tenantId, userId, role);
  }

  addMember(tenantId, { userId, role, isOwner = false }) {
    const project = this._project(tenantId);
    const parsedUserId = integer(userId, 'userId', { min: 1 });
    const memberRole = String(role || 'viewer').toLowerCase();
    const db = this._db();
    return db.transaction(() => {
      this._upsertMember(project.id, parsedUserId, memberRole, !!isOwner);
      return this.getProject(project.id).members.find(member => member.user_id === parsedUserId);
    })();
  }

  setMember(tenantId, data, actor) {
    const scope = this._projectScope(integer(tenantId, 'tenantId', { min: 1 }));
    if (!actor?.id) throw fail('Authenticated user is required', 401);
    if (actor.role !== 'admin') this.assertCan(actor, scope.id, 'project.members.manage');
    this.addMember(tenantId, data);
    return this.getProject(tenantId);
  }

  removeMember(tenantId, userId, actor) {
    const project = this._project(tenantId);
    if (actor) {
      if (!actor.id) throw fail('Authenticated user is required', 401);
      if (actor.role !== 'admin') this.assertCan(actor, this._projectScope(project.id).id, 'project.members.manage');
    }
    const parsedUserId = integer(userId, 'userId', { min: 1 });
    const db = this._db();
    return db.transaction(() => {
      const member = db.prepare('SELECT * FROM user_tenants WHERE tenant_id = ? AND user_id = ?').get(project.id, parsedUserId);
      if (!member) throw fail('Project member not found', 404);
      if (member.is_owner) {
        const owners = db.prepare('SELECT COUNT(*) AS count FROM user_tenants WHERE tenant_id = ? AND is_owner = 1').get(project.id).count;
        if (owners <= 1) throw fail('The last project owner cannot be removed', 409, 'OWNER_REMOVAL_BLOCKED');
      }
      db.prepare('DELETE FROM user_tenants WHERE tenant_id = ? AND user_id = ?').run(project.id, parsedUserId);
      db.prepare(`DELETE FROM governance_role_bindings WHERE scope_id = ? AND user_id = ? AND granted_by IS NULL`)
        .run(this._projectScope(project.id).id, parsedUserId);
      return true;
    })();
  }

  transferOwnership(tenantId, userId, actor) {
    const project = this._project(tenantId);
    if (actor) {
      if (!actor.id) throw fail('Authenticated user is required', 401);
      if (actor.role !== 'admin') this.assertCan(actor, this._projectScope(project.id).id, 'project.ownership.transfer');
    }
    const targetUserId = integer(userId, 'userId', { min: 1 });
    const db = this._db();
    return db.transaction(() => {
      if (!db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(targetUserId)) throw fail('Active user not found', 404);
      this._upsertMember(project.id, targetUserId, 'admin', true);
      db.prepare('UPDATE user_tenants SET is_owner = CASE WHEN user_id = ? THEN 1 ELSE 0 END WHERE tenant_id = ?')
        .run(targetUserId, project.id);
      return this.getProject(project.id);
    })();
  }

  _usage(tenantId) {
    const row = this._db().prepare(`SELECT COALESCE(SUM(cpu_millicores), 0) AS cpu_millicores,
      COALESCE(SUM(memory_bytes), 0) AS memory_bytes, COALESCE(SUM(storage_bytes), 0) AS storage_bytes
      FROM governance_project_resources WHERE tenant_id = ?`).get(tenantId);
    return Object.fromEntries(QUOTA_METRICS.map(metric => [metric, Number(row[metric] || 0)]));
  }

  _quotas(tenantId, usage = this._usage(tenantId)) {
    const db = this._db();
    const rows = db.prepare('SELECT metric, soft_limit, hard_limit FROM governance_project_quotas WHERE tenant_id = ?').all(tenantId);
    const byMetric = new Map(rows.map(row => [row.metric, row]));
    // Temporary, approved quota grants override the configured limits until
    // their explicit expiry. Keep this optional for pre-v8.50 test schemas.
    try {
      const grants = db.prepare(`SELECT metric, soft_limit, hard_limit, expires_at
        FROM governance_quota_grants WHERE tenant_id = ? AND datetime(expires_at) > datetime('now')
        ORDER BY datetime(expires_at) DESC`).all(tenantId);
      for (const grant of grants) if (!byMetric.has(`grant:${grant.metric}`)) {
        byMetric.set(grant.metric, grant);
        byMetric.set(`grant:${grant.metric}`, true);
      }
    } catch { /* migration 125 may not exist in isolated legacy tests */ }
    return Object.fromEntries(QUOTA_METRICS.map(metric => {
      const row = byMetric.get(metric) || {};
      const current = usage[metric] || 0;
      const softLimit = row.soft_limit == null ? null : Number(row.soft_limit);
      const hardLimit = row.hard_limit == null ? null : Number(row.hard_limit);
      const softExceeded = softLimit != null && current > softLimit;
      const hardExceeded = hardLimit != null && current > hardLimit;
      return [metric, {
        usage: current,
        used: current,
        softLimit,
        hardLimit,
        softExceeded,
        hardExceeded,
        state: hardExceeded ? 'hard-exceeded' : softExceeded ? 'soft-exceeded' : 'within-limit',
        temporaryGrantUntil: row.expires_at || null,
      }];
    }));
  }

  setQuotas(tenantId, quotas, actor) {
    const project = this._project(tenantId);
    if (!actor?.id) throw fail('Authenticated user is required', 401);
    if (actor.role !== 'admin') this.assertCan(actor, this._projectScope(project.id).id, 'project.quotas.manage');
    if (!quotas || typeof quotas !== 'object') throw fail('quotas object is required');
    const db = this._db();
    return db.transaction(() => {
      for (const metric of QUOTA_METRICS) {
        if (!Object.hasOwn(quotas, metric)) continue;
        const definition = quotas[metric] || {};
        const soft = integer(definition.softLimit, `${metric}.softLimit`, { required: false });
        const hard = integer(definition.hardLimit, `${metric}.hardLimit`, { required: false });
        if (soft != null && hard != null && soft > hard) throw fail(`${metric} softLimit cannot exceed hardLimit`);
        db.prepare(`INSERT INTO governance_project_quotas (tenant_id, metric, soft_limit, hard_limit, updated_by, updated_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(tenant_id, metric) DO UPDATE SET soft_limit = excluded.soft_limit,
            hard_limit = excluded.hard_limit, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
          .run(project.id, metric, soft, hard, actor.id);
      }
      return this._quotas(project.id);
    })();
  }

  assignResource(tenantId, resource, actor) {
    const project = this._project(tenantId);
    if (!actor?.id) throw fail('Authenticated user is required', 401);
    if (actor.role !== 'admin') this.assertCan(actor, this._projectScope(project.id).id, 'project.resources.manage');
    const providerHostId = integer(resource.providerHostId ?? 0, 'providerHostId');
    const resourceType = text(resource.resourceType, 'resourceType', 80);
    const resourceKey = text(resource.resourceKey, 'resourceKey', 180);
    const displayName = text(resource.displayName || resource.resourceKey, 'displayName', 180);
    const accounting = {
      cpu_millicores: integer(resource.cpuMillicores ?? 0, 'cpuMillicores'),
      memory_bytes: integer(resource.memoryBytes ?? 0, 'memoryBytes'),
      storage_bytes: integer(resource.storageBytes ?? 0, 'storageBytes'),
    };
    const metadataJson = this._metadata(resource.metadata);
    const db = this._db();
    return db.transaction(() => {
      if (project.status !== 'active') throw fail('Cannot assign resources to a suspended project', 409, 'PROJECT_SUSPENDED');
      const existing = db.prepare(`SELECT * FROM governance_project_resources
        WHERE provider_host_id = ? AND resource_type = ? AND resource_key = ?`).get(providerHostId, resourceType, resourceKey);
      if (existing && existing.tenant_id !== project.id) throw fail('Resource is already assigned to another project', 409, 'RESOURCE_ALREADY_ASSIGNED');
      const usage = this._usage(project.id);
      for (const metric of QUOTA_METRICS) usage[metric] = usage[metric] - Number(existing?.[metric] || 0) + accounting[metric];
      const quotas = this._quotas(project.id, usage);
      const exceeded = QUOTA_METRICS.filter(metric => quotas[metric].hardLimit != null && quotas[metric].hardExceeded);
      if (exceeded.length) throw fail(`Hard quota exceeded: ${exceeded.join(', ')}`, 409, 'HARD_QUOTA_EXCEEDED', { metric: exceeded[0] });
      let rowId;
      if (existing) {
        db.prepare(`UPDATE governance_project_resources SET display_name = ?, cpu_millicores = ?, memory_bytes = ?,
          storage_bytes = ?, metadata_json = ?, assigned_by = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(displayName, accounting.cpu_millicores, accounting.memory_bytes, accounting.storage_bytes, metadataJson, actor.id, existing.id);
        rowId = existing.id;
      } else {
        rowId = Number(db.prepare(`INSERT INTO governance_project_resources
          (tenant_id, provider_host_id, resource_type, resource_key, display_name, cpu_millicores, memory_bytes, storage_bytes, metadata_json, assigned_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(project.id, providerHostId, resourceType, resourceKey,
          displayName, accounting.cpu_millicores, accounting.memory_bytes, accounting.storage_bytes, metadataJson, actor.id).lastInsertRowid);
      }
      const warnings = QUOTA_METRICS.filter(metric => quotas[metric].softExceeded)
        .map(metric => ({ metric, message: `${metric} soft quota exceeded` }));
      return {
        resource: db.prepare('SELECT * FROM governance_project_resources WHERE id = ?').get(rowId),
        warnings, quotas, usage,
      };
    })();
  }

  unassignResource(tenantId, resourceId, actor) {
    const project = this._project(tenantId);
    if (!actor?.id) throw fail('Authenticated user is required', 401);
    if (actor.role !== 'admin') this.assertCan(actor, this._projectScope(project.id).id, 'project.resources.manage');
    const result = this._db().prepare('DELETE FROM governance_project_resources WHERE id = ? AND tenant_id = ?')
      .run(integer(resourceId, 'resourceId', { min: 1 }), project.id);
    if (!result.changes) throw fail('Project resource not found', 404);
    return true;
  }

  createInvitation(tenantId, { email, emailDomain, memberRole, role: legacyRole, expiresAt, ttlHours }, actor) {
    const project = this._project(tenantId);
    if (!actor?.id) throw fail('Authenticated user is required', 401);
    if (actor.role !== 'admin') this.assertCan(actor, this._projectScope(project.id).id, 'project.invitations.manage');
    const normalizedEmail = email == null || email === '' ? null : text(email, 'email', 254).toLowerCase();
    const normalizedDomain = emailDomain == null || emailDomain === '' ? null : text(emailDomain, 'emailDomain', 253).toLowerCase().replace(/^@/, '');
    if (!normalizedEmail && !normalizedDomain) throw fail('email or emailDomain is required');
    if (normalizedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) throw fail('email is invalid');
    if (normalizedDomain && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9-]+)+$/.test(normalizedDomain)) throw fail('emailDomain is invalid');
    const role = String(memberRole || legacyRole || 'viewer').toLowerCase();
    if (!PROJECT_MEMBER_ROLES.has(role)) throw fail('memberRole is invalid');
    const ttl = ttlHours == null ? 24 : integer(ttlHours, 'ttlHours', { min: 1 });
    const expiry = expiresAt
      ? iso(expiresAt, 'expiresAt', { required: true, future: true })
      : new Date(Date.now() + ttl * 60 * 60 * 1000).toISOString();
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const result = this._db().prepare(`INSERT INTO governance_project_invitations
      (tenant_id, email, email_domain, member_role, token_hash, expires_at, invited_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(project.id, normalizedEmail, normalizedDomain, role, tokenHash, expiry, actor.id);
    return { id: Number(result.lastInsertRowid), token, expiresAt: expiry, role, memberRole: role, email: normalizedEmail, emailDomain: normalizedDomain };
  }

  listInvitations(tenantId, actor) {
    this._project(tenantId);
    if (!actor?.id) throw fail('Authenticated user is required', 401);
    if (actor.role !== 'admin') this.assertCan(actor, this._projectScope(tenantId).id, 'project.invitations.manage');
    return this._db().prepare(`SELECT id, tenant_id, email, email_domain, member_role, expires_at, invited_by,
      accepted_by, accepted_at, revoked_at, created_at FROM governance_project_invitations
      WHERE tenant_id = ? ORDER BY created_at DESC`).all(tenantId).map(invitation => {
      const state = invitation.revoked_at
        ? 'revoked'
        : invitation.accepted_at
          ? 'accepted'
          : Date.parse(invitation.expires_at) <= Date.now() ? 'expired' : 'pending';
      return {
        ...invitation,
        tenantId: invitation.tenant_id,
        emailDomain: invitation.email_domain,
        role: invitation.member_role,
        memberRole: invitation.member_role,
        expiresAt: invitation.expires_at,
        invitedBy: invitation.invited_by,
        acceptedBy: invitation.accepted_by,
        acceptedAt: invitation.accepted_at,
        revokedAt: invitation.revoked_at,
        createdAt: invitation.created_at,
        state,
      };
    });
  }

  revokeInvitation(tenantId, invitationId, actor) {
    this._project(tenantId);
    if (!actor?.id) throw fail('Authenticated user is required', 401);
    if (actor.role !== 'admin') this.assertCan(actor, this._projectScope(tenantId).id, 'project.invitations.manage');
    const result = this._db().prepare(`UPDATE governance_project_invitations SET revoked_at = datetime('now')
      WHERE id = ? AND tenant_id = ? AND accepted_at IS NULL AND revoked_at IS NULL`)
      .run(integer(invitationId, 'invitationId', { min: 1 }), tenantId);
    if (!result.changes) throw fail('Active invitation not found', 404);
    return true;
  }

  acceptInvitation(token, user) {
    const rawToken = text(token, 'token', 256);
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const targetUserId = integer(user?.id, 'userId', { min: 1 });
    const db = this._db();
    return db.transaction(() => {
      const invitation = db.prepare(`SELECT * FROM governance_project_invitations WHERE token_hash = ?
        AND accepted_at IS NULL AND revoked_at IS NULL AND datetime(expires_at) > datetime('now')`).get(tokenHash);
      if (!invitation) {
        const known = db.prepare('SELECT * FROM governance_project_invitations WHERE token_hash = ?').get(tokenHash);
        if (known?.accepted_at) throw fail('Invitation was already used', 409, 'INVITATION_USED');
        throw fail('Invitation is invalid, expired, or revoked', 404, 'INVITATION_UNAVAILABLE');
      }
      const user = db.prepare('SELECT id, email FROM users WHERE id = ? AND is_active = 1').get(targetUserId);
      if (!user) throw fail('Active user not found', 404);
      const email = String(user.email || '').trim().toLowerCase();
      if (invitation.email && email !== invitation.email) throw fail('Invitation is restricted to another email address', 403, 'INVITATION_EMAIL_MISMATCH');
      if (invitation.email_domain && (!email || !email.endsWith(`@${invitation.email_domain}`))) {
        throw fail('Invitation is restricted to another email domain', 403, 'INVITATION_DOMAIN_MISMATCH');
      }
      this._upsertMember(invitation.tenant_id, user.id, invitation.member_role, false);
      db.prepare(`UPDATE governance_project_invitations SET accepted_by = ?, accepted_at = datetime('now') WHERE id = ?`)
        .run(user.id, invitation.id);
      return { accepted: true, projectId: invitation.tenant_id, role: invitation.member_role };
    })();
  }

  _metadata(value) {
    if (value === undefined || value === null) return '{}';
    if (typeof value !== 'object' || Array.isArray(value)) throw fail('metadata must be an object');
    const json = JSON.stringify(value);
    if (json.length > 8_000) throw fail('metadata is too large');
    return json;
  }

  _json(value) {
    try { return JSON.parse(value || '{}'); } catch { return {}; }
  }
}

const governanceService = new GovernanceService();

module.exports = governanceService;
module.exports.GovernanceService = GovernanceService;
module.exports.GovernanceError = GovernanceError;
module.exports.GOVERNANCE_QUOTA_METRICS = QUOTA_METRICS;
