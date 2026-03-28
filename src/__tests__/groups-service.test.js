'use strict';

// Integration tests for the groups service.
// Uses in-memory SQLite DB (same pattern as auth-flow.test.js).

process.env.APP_SECRET = 'test-secret-for-groups-tests';
process.env.APP_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'GroupTest123!';

const { getDb } = require('../db');
const db = getDb();

const authService = require('../services/auth');
const groups = require('../services/groups');

let adminUserId;

beforeAll(() => {
  authService.seedAdmin();
  const admin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  adminUserId = admin.id;
});

describe('Groups Service — CRUD', () => {
  let groupId;

  // ── Create ─────────────────────────────────────────────────
  it('should create a group', () => {
    const result = groups.create({
      name: 'Production',
      color: '#ff0000',
      icon: 'fas fa-server',
      scope: 'global',
      userId: adminUserId,
      createdBy: adminUserId,
    });
    expect(result.id).toBeTruthy();
    groupId = Number(result.id);
  });

  // ── List ───────────────────────────────────────────────────
  it('should list groups with member counts', () => {
    const list = groups.list(adminUserId);
    expect(list.length).toBeGreaterThanOrEqual(1);
    const found = list.find(g => g.name === 'Production');
    expect(found).toBeTruthy();
    expect(found.member_count).toBe(0);
  });

  // ── Get single ─────────────────────────────────────────────
  it('should get a single group with members array', () => {
    const group = groups.get(groupId, adminUserId);
    expect(group).toBeTruthy();
    expect(group.name).toBe('Production');
    expect(Array.isArray(group.members)).toBe(true);
    expect(group.members.length).toBe(0);
  });

  // ── Update ─────────────────────────────────────────────────
  it('should update group name and color', () => {
    groups.update(groupId, { name: 'Staging', color: '#00ff00' }, adminUserId);
    const updated = groups.get(groupId, adminUserId);
    expect(updated.name).toBe('Staging');
    expect(updated.color).toBe('#00ff00');
  });

  // ── Get non-existent ───────────────────────────────────────
  it('should return null for non-existent group', () => {
    const result = groups.get(99999, adminUserId);
    expect(result).toBeNull();
  });

  // ── Delete ─────────────────────────────────────────────────
  it('should delete a group', () => {
    groups.delete(groupId, adminUserId);
    const result = groups.get(groupId, adminUserId);
    expect(result).toBeNull();
  });
});

describe('Groups Service — Container Membership', () => {
  let groupId;

  beforeAll(() => {
    const result = groups.create({
      name: 'Web Servers',
      scope: 'global',
      userId: adminUserId,
      createdBy: adminUserId,
    });
    groupId = Number(result.id);
  });

  it('should add containers to a group', () => {
    groups.addContainers(groupId, ['container-abc', 'container-def', 'container-ghi']);
    const group = groups.get(groupId, adminUserId);
    expect(group.members.length).toBe(3);
    expect(group.members).toContain('container-abc');
    expect(group.members).toContain('container-def');
  });

  it('should show correct member_count in list', () => {
    const list = groups.list(adminUserId);
    const found = list.find(g => g.id === groupId);
    expect(found.member_count).toBe(3);
  });

  it('should not duplicate containers (INSERT OR IGNORE)', () => {
    groups.addContainers(groupId, ['container-abc']);
    const group = groups.get(groupId, adminUserId);
    expect(group.members.length).toBe(3);
  });

  it('should remove a container from a group', () => {
    groups.removeContainer(groupId, 'container-def');
    const group = groups.get(groupId, adminUserId);
    expect(group.members.length).toBe(2);
    expect(group.members).not.toContain('container-def');
  });

  it('should cascade delete members when group is deleted', () => {
    groups.delete(groupId, adminUserId);
    // Verify members table is clean (ON DELETE CASCADE)
    const orphans = db.prepare('SELECT * FROM container_group_members WHERE group_id = ?').all(groupId);
    expect(orphans.length).toBe(0);
  });
});

describe('Groups Service — Reorder', () => {
  let ids;

  beforeAll(() => {
    const a = groups.create({ name: 'Group A', scope: 'global', userId: adminUserId, createdBy: adminUserId });
    const b = groups.create({ name: 'Group B', scope: 'global', userId: adminUserId, createdBy: adminUserId });
    const c = groups.create({ name: 'Group C', scope: 'global', userId: adminUserId, createdBy: adminUserId });
    ids = [Number(a.id), Number(b.id), Number(c.id)];
  });

  it('should reorder groups', () => {
    // Reverse the order: C=0, B=1, A=2
    groups.reorder([ids[2], ids[1], ids[0]]);

    const list = groups.list(adminUserId);
    const reordered = list.filter(g => ids.includes(g.id));
    // Group C should come first (sort_order = 0)
    const groupC = reordered.find(g => g.name === 'Group C');
    const groupA = reordered.find(g => g.name === 'Group A');
    expect(groupC.sort_order).toBeLessThan(groupA.sort_order);
  });
});

describe('Groups Service — Scope Filtering', () => {
  let userGroupId;
  let secondUserId;

  beforeAll(() => {
    // Create a second user
    db.prepare(`INSERT INTO users (username, password_hash, role) VALUES (?, 'hash', 'viewer')`).run('viewer-test');
    secondUserId = db.prepare('SELECT id FROM users WHERE username = ?').get('viewer-test').id;

    // Create a user-scoped group for admin
    const result = groups.create({
      name: 'My Private Group',
      scope: 'user',
      userId: adminUserId,
      createdBy: adminUserId,
    });
    userGroupId = Number(result.id);
  });

  it('should show user-scoped group to the owning user', () => {
    const list = groups.list(adminUserId);
    const found = list.find(g => g.id === userGroupId);
    expect(found).toBeTruthy();
  });

  it('should hide user-scoped group from other users', () => {
    const list = groups.list(secondUserId);
    const found = list.find(g => g.id === userGroupId);
    expect(found).toBeUndefined();
  });

  it('should not allow other user to get user-scoped group', () => {
    const result = groups.get(userGroupId, secondUserId);
    expect(result).toBeNull();
  });
});
