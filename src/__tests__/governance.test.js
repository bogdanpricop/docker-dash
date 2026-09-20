'use strict';

const Database = require('better-sqlite3');

let mockDb;
jest.mock('../db', () => ({ getDb: () => mockDb }));

const migration = require('../db/migrations/124_governance_foundation');
const governance = require('../services/governance');

const admin = { id: 1, username: 'root', email: 'root@example.com', role: 'admin' };
const siteAdmin = { id: 2, username: 'site-admin', email: 'site@example.com', role: 'viewer' };
const invited = { id: 3, username: 'member', email: 'member@example.com', role: 'viewer' };

function expectGovernanceError(action, expected) {
  let error;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(governance.GovernanceError);
  expect(error).toMatchObject(expected);
}

function setupDb() {
  mockDb = new Database(':memory:');
  mockDb.pragma('foreign_keys = ON');
  mockDb.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, username TEXT UNIQUE, display_name TEXT, email TEXT,
      role TEXT NOT NULL DEFAULT 'viewer', is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE teams (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE team_members (team_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY(team_id, user_id));
    CREATE TABLE tenants (
      id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'internal', usage_mode TEXT NOT NULL DEFAULT 'production',
      status TEXT NOT NULL DEFAULT 'active', is_default INTEGER NOT NULL DEFAULT 0,
      trial_expires_at TEXT, created_by TEXT, created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE user_tenants (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'viewer', is_owner INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(user_id, tenant_id)
    );
    INSERT INTO users (id, username, display_name, email, role) VALUES
      (1, 'root', 'Root', 'root@example.com', 'admin'),
      (2, 'site-admin', 'Site Admin', 'site@example.com', 'viewer'),
      (3, 'member', 'Member', 'member@example.com', 'viewer'),
      (4, 'outside', 'Outside', 'outside@other.test', 'viewer');
    INSERT INTO teams (id, name) VALUES (1, 'Platform');
    INSERT INTO team_members (team_id, user_id) VALUES (1, 2);
    INSERT INTO tenants (id, slug, name, is_default) VALUES (1, 'default', 'Default', 1);
  `);
  migration.up(mockDb);
}

describe('V4.6a governance foundation (B176–B185)', () => {
  beforeEach(setupDb);
  afterEach(() => mockDb.close());

  test('seeds the permission catalog, safe built-in roles, root and existing project scope', () => {
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM governance_permissions').get().count).toBe(12);
    expect(governance.listRoles().map(role => role.slug)).toEqual([
      'project-admin', 'project-operator', 'project-viewer', 'site-admin',
    ]);
    expect(mockDb.prepare("SELECT scope_type, parent_id FROM governance_scopes WHERE id = 1").get())
      .toEqual({ scope_type: 'organization', parent_id: null });
    expect(mockDb.prepare("SELECT tenant_id, parent_id FROM governance_scopes WHERE scope_type = 'project'").get())
      .toEqual({ tenant_id: 1, parent_id: 1 });
  });

  test('creates custom roles only from catalog permissions and keeps built-ins immutable', () => {
    const role = governance.createRole({
      slug: 'auditor', name: 'Auditor', permissions: ['governance.read', 'project.read'],
    }, admin);
    expect(role).toMatchObject({ slug: 'auditor', isBuiltin: false });
    expect(role.permissions).toEqual(['governance.read', 'project.read']);
    expectGovernanceError(
      () => governance.createRole({ slug: 'bad-role', name: 'Bad', permissions: ['root.everything'] }, admin),
      { code: 'UNKNOWN_PERMISSION' },
    );
    const builtin = governance.listRoles().find(item => item.slug === 'site-admin');
    expectGovernanceError(
      () => governance.updateRole(builtin.id, { name: 'Changed' }, admin),
      { code: 'BUILTIN_ROLE_IMMUTABLE' },
    );
  });

  test('inherits a delegated site-admin role downward and allows project creation only inside that site', () => {
    const site = governance.createScope({ parentId: 1, type: 'site', key: 'bucharest', name: 'Bucharest' }, admin);
    const siteRole = governance.listRoles().find(role => role.slug === 'site-admin');
    governance.createBinding({ scopeId: site.id, roleId: siteRole.id, userId: siteAdmin.id }, admin);

    expect(governance.effectivePermissions(siteAdmin, site.id).has('project.create')).toBe(true);
    const project = governance.createProject({
      name: 'Platform', slug: 'platform', parentScopeId: site.id,
    }, siteAdmin);
    expect(project).toMatchObject({ slug: 'platform', parentScopeId: site.id, owner: { id: siteAdmin.id } });
    expect(governance.hasPermission(siteAdmin, 'project.quotas.manage', project.scopeId)).toBe(true);
    expectGovernanceError(
      () => governance.createProject({ name: 'Root project', slug: 'root-project', parentScopeId: 1 }, siteAdmin),
      { code: 'GOVERNANCE_PERMISSION_DENIED', status: 403 },
    );
  });

  test('prevents delegated privilege escalation when binding a role with permissions the caller lacks', () => {
    const site = governance.createScope({ parentId: 1, type: 'site', key: 'west', name: 'West' }, admin);
    const projectViewer = governance.listRoles().find(role => role.slug === 'project-viewer');
    governance.createBinding({ scopeId: site.id, roleId: projectViewer.id, userId: siteAdmin.id }, admin);
    const roleManager = governance.createRole({
      slug: 'role-manager', name: 'Role Manager', permissions: ['binding.manage', 'role.manage'],
    }, admin);
    expectGovernanceError(
      () => governance.createBinding({ scopeId: site.id, roleId: roleManager.id, userId: invited.id }, siteAdmin),
      { code: 'GOVERNANCE_PERMISSION_DENIED' },
    );
  });

  test('uses hashed, expiring invitations and accepts only a matching account once', () => {
    const project = governance.createProject({ name: 'Invite Project', slug: 'invite-project', parentScopeId: 1 }, admin);
    const invitation = governance.createInvitation(project.id, {
      email: invited.email, role: 'operator', ttlHours: 24,
    }, admin);
    const stored = mockDb.prepare('SELECT token_hash FROM governance_project_invitations WHERE id = ?').get(invitation.id);
    expect(stored.token_hash).not.toContain(invitation.token);
    expect(stored.token_hash).toHaveLength(64);

    expect(governance.acceptInvitation(invitation.token, invited)).toEqual({
      accepted: true, projectId: project.id, role: 'operator',
    });
    expect(mockDb.prepare('SELECT role FROM user_tenants WHERE tenant_id = ? AND user_id = ?').get(project.id, invited.id).role)
      .toBe('operator');
    expectGovernanceError(
      () => governance.acceptInvitation(invitation.token, invited),
      { code: 'INVITATION_USED' },
    );
  });

  test('enforces invitation domain restrictions', () => {
    const project = governance.createProject({ name: 'Domain Project', slug: 'domain-project', parentScopeId: 1 }, admin);
    const invitation = governance.createInvitation(project.id, { emailDomain: 'example.com' }, admin);
    expectGovernanceError(
      () => governance.acceptInvitation(invitation.token, { id: 4, email: 'outside@other.test' }),
      { code: 'INVITATION_DOMAIN_MISMATCH', status: 403 },
    );
    expect(mockDb.prepare('SELECT accepted_at FROM governance_project_invitations WHERE id = ?').get(invitation.id).accepted_at)
      .toBeNull();
  });

  test('transfers ownership transactionally and blocks removal of the current owner', () => {
    const project = governance.createProject({ name: 'Owned', slug: 'owned', parentScopeId: 1 }, admin);
    governance.setMember(project.id, { userId: invited.id, role: 'viewer' }, admin);
    expectGovernanceError(
      () => governance.removeMember(project.id, admin.id, admin),
      { code: 'OWNER_REMOVAL_BLOCKED' },
    );
    const transferred = governance.transferOwnership(project.id, invited.id, admin);
    expect(transferred.owner.id).toBe(invited.id);
    expect(mockDb.prepare('SELECT is_owner FROM user_tenants WHERE tenant_id = ? AND user_id = ?').get(project.id, admin.id).is_owner)
      .toBe(0);
  });

  test('reports all three quota usages, warns at soft limits and atomically rejects hard excess', () => {
    const gib = 1024 ** 3;
    const project = governance.createProject({ name: 'Quota', slug: 'quota', parentScopeId: 1 }, admin);
    governance.setQuotas(project.id, {
      cpu_millicores: { softLimit: 1000, hardLimit: 2000 },
      memory_bytes: { softLimit: gib, hardLimit: 2 * gib },
      storage_bytes: { softLimit: 5 * gib, hardLimit: 10 * gib },
    }, admin);
    const first = governance.assignResource(project.id, {
      resourceType: 'vm', resourceKey: 'vm-101', displayName: 'VM 101',
      cpuMillicores: 1500, memoryBytes: gib, storageBytes: 4 * gib,
    }, admin);
    expect(first.warnings).toEqual([expect.objectContaining({ metric: 'cpu_millicores' })]);
    expect(first.usage).toMatchObject({ cpu_millicores: 1500, memory_bytes: gib, storage_bytes: 4 * gib });

    expectGovernanceError(
      () => governance.assignResource(project.id, {
        resourceType: 'vm', resourceKey: 'vm-102', displayName: 'VM 102', cpuMillicores: 600,
      }, admin),
      { code: 'HARD_QUOTA_EXCEEDED', details: { metric: 'cpu_millicores' } },
    );
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM governance_project_resources WHERE tenant_id = ?').get(project.id).count)
      .toBe(1);
  });

  test('prevents the same provider resource from being assigned across projects', () => {
    const one = governance.createProject({ name: 'One', slug: 'one', parentScopeId: 1 }, admin);
    const two = governance.createProject({ name: 'Two', slug: 'two', parentScopeId: 1 }, admin);
    governance.assignResource(one.id, { resourceType: 'vm', resourceKey: 'same', displayName: 'Same' }, admin);
    expectGovernanceError(
      () => governance.assignResource(two.id, { resourceType: 'vm', resourceKey: 'same', displayName: 'Same' }, admin),
      { code: 'RESOURCE_ALREADY_ASSIGNED', status: 409 },
    );
  });
});
