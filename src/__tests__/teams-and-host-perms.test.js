'use strict';

// v8.9.10-alpha.1 — Portainer G01 + G02 closure tests.

process.env.APP_SECRET = 'test-teams-perms';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

const teamsSvc = require('../services/teams');
const permsSvc = require('../services/host-permissions');
const hostGroupsSvc = require('../services/host-groups');
const { getDb } = require('../db');

describe('teams service (v8.9.10-alpha.1, Portainer G01)', () => {
  let uid1, uid2, uid3;
  beforeAll(() => {
    const db = getDb();
    // Seed users
    const insUser = db.prepare(
      `INSERT OR IGNORE INTO users (username, email, password_hash, role, is_active)
       VALUES (?, ?, 'x', 'operator', 1)`
    );
    insUser.run('alice', 'a@x');
    insUser.run('bob', 'b@x');
    insUser.run('carol', 'c@x');
    uid1 = db.prepare("SELECT id FROM users WHERE username='alice'").get().id;
    uid2 = db.prepare("SELECT id FROM users WHERE username='bob'").get().id;
    uid3 = db.prepare("SELECT id FROM users WHERE username='carol'").get().id;
  });

  it('rejects empty name', () => {
    expect(() => teamsSvc.create({})).toThrow(/required/);
  });

  it('creates a team with members', () => {
    const id = teamsSvc.create({ name: 'ops', memberIds: [uid1, uid2] }, null);
    const team = teamsSvc.get(id);
    expect(team.name).toBe('ops');
    expect(team.members.map(m => m.username).sort()).toEqual(['alice', 'bob']);
  });

  it('teamsForUser resolves memberships', () => {
    const teams = teamsSvc.teamsForUser(uid1);
    expect(teams.length).toBeGreaterThanOrEqual(1);
  });

  it('add + remove member', () => {
    const list = teamsSvc.list();
    const opsTeam = list.find(t => t.name === 'ops');
    teamsSvc.addMember(opsTeam.id, uid3);
    expect(teamsSvc.get(opsTeam.id).members.map(m => m.username)).toContain('carol');
    teamsSvc.removeMember(opsTeam.id, uid3);
    expect(teamsSvc.get(opsTeam.id).members.map(m => m.username)).not.toContain('carol');
  });

  it('delete cascades team_members', () => {
    const id = teamsSvc.create({ name: 'temp', memberIds: [uid1] }, null);
    teamsSvc.remove(id);
    expect(teamsSvc.get(id)).toBeNull();
  });
});

describe('host-permissions service (v8.9.10-alpha.1, Portainer G02)', () => {
  let uid1, uid2, hostA, hostB, hostC, groupProd, teamOps;
  beforeAll(() => {
    const db = getDb();
    // Seed users
    db.prepare(`INSERT OR IGNORE INTO users (username, email, password_hash, role, is_active) VALUES ('dev1', 'd1@x', 'x', 'operator', 1)`).run();
    db.prepare(`INSERT OR IGNORE INTO users (username, email, password_hash, role, is_active) VALUES ('dev2', 'd2@x', 'x', 'operator', 1)`).run();
    uid1 = db.prepare("SELECT id FROM users WHERE username='dev1'").get().id;
    uid2 = db.prepare("SELECT id FROM users WHERE username='dev2'").get().id;
    // Seed hosts
    hostA = 5001; hostB = 5002; hostC = 5003;
    db.prepare(`INSERT OR IGNORE INTO docker_hosts (id, name, connection_type) VALUES (?, 'host-a', 'tcp')`).run(hostA);
    db.prepare(`INSERT OR IGNORE INTO docker_hosts (id, name, connection_type) VALUES (?, 'host-b', 'tcp')`).run(hostB);
    db.prepare(`INSERT OR IGNORE INTO docker_hosts (id, name, connection_type) VALUES (?, 'host-c', 'tcp')`).run(hostC);
    // Host group
    groupProd = hostGroupsSvc.create({ name: 'permstest-prod-hosts', hostIds: [hostB, hostC] }, null);
    // Team with dev1 in it
    teamOps = teamsSvc.create({ name: 'perms-test-devs', memberIds: [uid1] }, null);
    // Disable legacy default so tests exercise real ACL
    permsSvc.setLegacyDefault(false);
  });

  afterAll(() => {
    // Restore default for other tests
    permsSvc.setLegacyDefault(true);
  });

  it('admin always sees all hosts', () => {
    expect(permsSvc.resolveEffectivePermission(uid1, hostA, true)).toBe('admin');
  });

  it('non-admin with no grants gets null (legacy default off)', () => {
    expect(permsSvc.resolveEffectivePermission(uid2, hostA, false)).toBeNull();
  });

  it('direct user grant on host', () => {
    permsSvc.grant({ hostId: hostA, userId: uid1, permission: 'operate' }, null);
    expect(permsSvc.resolveEffectivePermission(uid1, hostA, false)).toBe('operate');
  });

  it('team grant on host cascades to members', () => {
    permsSvc.grant({ hostId: hostB, teamId: teamOps, permission: 'admin' }, null);
    // dev1 is in teamOps
    expect(permsSvc.resolveEffectivePermission(uid1, hostB, false)).toBe('admin');
    // dev2 is not
    expect(permsSvc.resolveEffectivePermission(uid2, hostB, false)).toBeNull();
  });

  it('host-group grant applies to all member hosts', () => {
    permsSvc.grant({ hostGroupId: groupProd, userId: uid2, permission: 'view' }, null);
    // hostB and hostC are members of groupProd
    expect(permsSvc.resolveEffectivePermission(uid2, hostB, false)).toBe('view');
    expect(permsSvc.resolveEffectivePermission(uid2, hostC, false)).toBe('view');
    // hostA is not
    expect(permsSvc.resolveEffectivePermission(uid2, hostA, false)).toBeNull();
  });

  it('highest permission wins across sources', () => {
    // dev1 already has 'operate' direct on hostA. Grant 'admin' via group.
    permsSvc.grant({ hostGroupId: groupProd, userId: uid1, permission: 'admin' }, null);
    expect(permsSvc.resolveEffectivePermission(uid1, hostB, false)).toBe('admin');
  });

  it('filterVisibleHosts respects effective permissions', () => {
    const visible = permsSvc.filterVisibleHosts(uid2, false, [hostA, hostB, hostC]);
    expect(visible).toEqual(expect.arrayContaining([hostB, hostC]));
    expect(visible).not.toContain(hostA);
  });

  it('legacy default enabled → all non-admin users get operate on any host', () => {
    permsSvc.setLegacyDefault(true);
    expect(permsSvc.resolveEffectivePermission(uid2, hostA, false)).toBe('operate');
    permsSvc.setLegacyDefault(false);
  });
});
