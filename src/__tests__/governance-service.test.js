'use strict';

process.env.APP_SECRET = 'governance-service-test-secret';
process.env.ENCRYPTION_KEY = 'governance-service-test-key-32chars';
process.env.DB_PATH = ':memory:';

const { getDb, closeDb } = require('../db');
const { GovernanceService, GovernanceError } = require('../services/governance');

describe('GovernanceService (V4.6a)', () => {
  let db;
  let governance;
  const admin = { id: 901, username: 'governance-admin', role: 'admin' };
  const delegatedUser = { id: 902, username: 'delegated-user', role: 'viewer' };
  const invitedUser = { id: 903, username: 'invited-user', role: 'viewer' };

  beforeAll(() => {
    db = getDb();
    governance = new GovernanceService(() => db);
  });

  beforeEach(() => {
    const insertUser = db.prepare(`INSERT INTO users (id, username, email, password_hash, role, is_active)
      VALUES (?, ?, ?, 'not-used-in-unit-test', ?, 1)
      ON CONFLICT(id) DO UPDATE SET email = excluded.email, role = excluded.role, is_active = 1`);
    insertUser.run(admin.id, admin.username, 'admin@example.test', admin.role);
    insertUser.run(delegatedUser.id, delegatedUser.username, 'delegated@example.test', delegatedUser.role);
    insertUser.run(invitedUser.id, invitedUser.username, 'invited@example.test', invitedUser.role);
  });

  afterAll(() => closeDb());

  test('seeds the catalog and lets an inherited binding grant only its declared permission', () => {
    const catalog = governance.catalog(admin);
    expect(catalog).toEqual(expect.objectContaining({ globalAdmin: true }));
    expect(catalog.permissions).toHaveLength(30);
    expect(catalog.permissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ permission_key: 'project.read', key: 'project.read' }),
      expect.objectContaining({ permission_key: 'resource_lease.manage', key: 'resource_lease.manage' }),
      expect.objectContaining({ permission_key: 'vm_observability.read', key: 'vm_observability.read' }),
      expect.objectContaining({ permission_key: 'observability_export.manage', key: 'observability_export.manage' }),
      expect.objectContaining({ permission_key: 'telemetry_policy.manage', key: 'telemetry_policy.manage' }),
      expect.objectContaining({ permission_key: 'infrastructure_automation.manage', key: 'infrastructure_automation.manage' }),
    ]));
    const site = governance.createScope({
      scopeType: 'site', scopeKey: 'bucharest', displayName: 'Bucharest', parentId: 1,
    }, admin);
    const role = governance.createRole({
      slug: 'project-reader', name: 'Project reader', permissions: ['project.read'],
    }, admin);
    const binding = governance.createBinding({ roleId: role.id, scopeId: site.id, userId: delegatedUser.id }, admin);
    expect(binding.updated).toBe(false);

    const project = governance.createProject({ slug: 'line-one', name: 'Line one', parentScopeId: site.id }, admin);
    expect(governance.can(delegatedUser, project.scope_id, 'project.read')).toBe(true);
    expect(governance.can(delegatedUser, project.scope_id, 'project.update')).toBe(false);
    expect(governance.getProject(project.id, delegatedUser).id).toBe(project.id);
    expect(() => governance.updateProject(project.id, { status: 'suspended' }, delegatedUser))
      .toThrow(GovernanceError);
  });

  test('enforces ownership, invitation single-use and hard quotas transactionally', () => {
    const project = governance.createProject({ slug: 'quota-project', name: 'Quota project' }, admin);
    governance.setQuotas(project.id, {
      cpu_millicores: { softLimit: 50, hardLimit: 100 },
      memory_bytes: { softLimit: 1000, hardLimit: 2000 },
      storage_bytes: { hardLimit: 3000 },
    }, admin);

    const first = governance.assignResource(project.id, {
      providerHostId: 7, resourceType: 'vm', resourceKey: 'vm-01', displayName: 'VM 01',
      cpuMillicores: 70, memoryBytes: 500, storageBytes: 1000,
    }, admin);
    expect(first.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: 'cpu_millicores' }),
    ]));
    expect(() => governance.assignResource(project.id, {
      providerHostId: 7, resourceType: 'vm', resourceKey: 'vm-02', displayName: 'VM 02',
      cpuMillicores: 40, memoryBytes: 1, storageBytes: 1,
    }, admin)).toThrow(/Hard quota exceeded/);
    expect(governance.getProject(project.id).usage.cpu_millicores).toBe(70);

    const invitation = governance.createInvitation(project.id, {
      email: 'invited@example.test', memberRole: 'operator',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, admin);
    const accepted = governance.acceptInvitation(invitation.token, invitedUser);
    expect(accepted).toEqual(expect.objectContaining({ accepted: true, projectId: project.id, role: 'operator' }));
    expect(governance.getProject(project.id).members).toEqual(expect.arrayContaining([
      expect.objectContaining({ user_id: invitedUser.id, role: 'operator' }),
    ]));
    expect(() => governance.acceptInvitation(invitation.token, invitedUser)).toThrow(GovernanceError);

    const transferred = governance.transferOwnership(project.id, invitedUser.id, admin);
    expect(transferred.members.filter(member => member.is_owner)).toEqual([
      expect.objectContaining({ user_id: invitedUser.id }),
    ]);
    expect(() => governance.removeMember(project.id, invitedUser.id, admin)).toThrow(/last project owner/i);
  });

  test('exposes UI-safe project aliases and blocks new accounting while suspended', () => {
    const project = governance.createProject({
      slug: 'lifecycle-project', name: 'Lifecycle project', usageMode: 'demo',
    }, admin);
    expect(project).toEqual(expect.objectContaining({
      usageMode: 'demo', memberCount: 1, permissions: [],
    }));
    expect(project.quotas.cpu_millicores).toEqual(expect.objectContaining({
      used: 0, state: 'within-limit',
    }));

    const suspended = governance.updateProject(project.id, { status: 'suspended' }, admin);
    expect(suspended).toEqual(expect.objectContaining({ status: 'suspended', permissions: [] }));
    expect(() => governance.assignResource(project.id, {
      resourceType: 'vm', resourceKey: 'suspended-vm', displayName: 'Suspended VM',
    }, admin)).toThrow(/suspended project/i);
  });
});
