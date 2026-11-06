'use strict';

// Tests for src/services/permissions.js
// Uses in-memory SQLite via DB_PATH=:memory:

process.env.APP_SECRET = 'test-secret-key-for-jest-tests-only';
process.env.DB_PATH = ':memory:';

jest.resetModules();

describe('Permissions Service', () => {
  let db, perms;

  beforeAll(() => {
    const { getDb } = require('../db');
    db = getDb();
    perms = require('../services/permissions');
    // Seed admin user for granted_by FK references
    db.prepare(
      `INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (1, 'superadmin', 'x', 'admin')`
    ).run();
  });

  afterAll(() => {
    const { closeDb } = require('../db');
    closeDb();
  });

  // ─── seed helpers ─────────────────────────────────────────────────────────
  test('database failure cannot grant access or expose inventory', () => {
    const failure = jest.spyOn(db, 'prepare').mockImplementation(() => { throw new Error('test database failure'); });
    try {
      expect(perms.getEffectiveRole(11, 'restricted', 'operator')).toBe('none');
      expect(perms.filterContainers([{ stack: 'restricted' }], 11, 'operator')).toEqual([]);
    } finally { failure.mockRestore(); }
  });

  test('unknown permission names cannot satisfy an authorization check', () => {
    expect(perms.hasPermission('admin', 'typo')).toBe(false);
    expect(perms.hasPermission('toString', 'view')).toBe(false);
    expect(perms.filterContainers([{ stack: 'unassigned' }], 11, 'unknown')).toEqual([]);
  });

  function seedUser(id, username, role) {
    db.prepare(
      `INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', ?)`
    ).run(id, username, role);
    return id;
  }

  beforeEach(() => {
    db.prepare('DELETE FROM stack_permissions').run();
  });

  // ─── ROLE_HIERARCHY ────────────────────────────────────────────────────────
  describe('ROLE_HIERARCHY', () => {
    it('has correct numeric order none < view < operate < admin', () => {
      const h = perms.ROLE_HIERARCHY;
      expect(h.none).toBeLessThan(h.view);
      expect(h.view).toBeLessThan(h.operate);
      expect(h.operate).toBeLessThan(h.admin);
    });
  });

  // ─── mapGlobalToPermission ─────────────────────────────────────────────────
  describe('mapGlobalToPermission', () => {
    it('maps admin → admin', () => {
      expect(perms.mapGlobalToPermission('admin')).toBe('admin');
    });

    it('maps operator → operate', () => {
      expect(perms.mapGlobalToPermission('operator')).toBe('operate');
    });

    it('maps viewer → view', () => {
      expect(perms.mapGlobalToPermission('viewer')).toBe('view');
    });

    it('maps unknown roles → view (safe default)', () => {
      expect(perms.mapGlobalToPermission('unknown')).toBe('none');
      expect(perms.mapGlobalToPermission('')).toBe('none');
      expect(perms.mapGlobalToPermission(null)).toBe('none');
    });
  });

  // ─── hasPermission ─────────────────────────────────────────────────────────
  describe('hasPermission', () => {
    it('admin satisfies all levels', () => {
      expect(perms.hasPermission('admin', 'none')).toBe(true);
      expect(perms.hasPermission('admin', 'view')).toBe(true);
      expect(perms.hasPermission('admin', 'operate')).toBe(true);
      expect(perms.hasPermission('admin', 'admin')).toBe(true);
    });

    it('view satisfies none and view only', () => {
      expect(perms.hasPermission('view', 'none')).toBe(true);
      expect(perms.hasPermission('view', 'view')).toBe(true);
      expect(perms.hasPermission('view', 'operate')).toBe(false);
      expect(perms.hasPermission('view', 'admin')).toBe(false);
    });

    it('none satisfies nothing above none', () => {
      expect(perms.hasPermission('none', 'view')).toBe(false);
      expect(perms.hasPermission('none', 'operate')).toBe(false);
    });

    it('unknown role/level defaults to 0 (fails)', () => {
      expect(perms.hasPermission('superuser', 'view')).toBe(false);
    });
  });

  // ─── getEffectiveRole ──────────────────────────────────────────────────────
  describe('getEffectiveRole', () => {
    beforeAll(() => {
      seedUser(10, 'alice', 'viewer');
      seedUser(11, 'bob', 'operator');
    });

    it('admin global role always returns admin regardless of stack', () => {
      expect(perms.getEffectiveRole(10, 'my-stack', 'admin')).toBe('admin');
    });

    it('returns mapped global role when no per-stack override exists', () => {
      expect(perms.getEffectiveRole(10, 'any-stack', 'viewer')).toBe('view');
      expect(perms.getEffectiveRole(11, 'any-stack', 'operator')).toBe('operate');
    });

    it('returns per-stack permission when override exists', () => {
      db.prepare(
        `INSERT INTO stack_permissions (stack_name, user_id, permission, granted_by) VALUES ('web', 10, 'operate', 1)`
      ).run();
      expect(perms.getEffectiveRole(10, 'web', 'viewer')).toBe('operate');
    });

    it('_standalone stack uses global role (no DB lookup)', () => {
      expect(perms.getEffectiveRole(10, '_standalone', 'viewer')).toBe('view');
    });

    it('null stackName uses global role', () => {
      expect(perms.getEffectiveRole(10, null, 'operator')).toBe('operate');
    });
  });

  // ─── setPermission / removePermission ──────────────────────────────────────
  describe('setPermission and removePermission', () => {
    beforeAll(() => {
      seedUser(20, 'charlie', 'viewer');
      seedUser(1, 'superadmin', 'admin');
    });

    it('creates a new permission row', () => {
      perms.setPermission('alpha', 20, 'operate', 1);
      const row = db.prepare(
        'SELECT permission FROM stack_permissions WHERE stack_name=? AND user_id=?'
      ).get('alpha', 20);
      expect(row).toBeTruthy();
      expect(row.permission).toBe('operate');
    });

    it('upserts existing permission', () => {
      perms.setPermission('alpha', 20, 'view', 1);
      const rows = db.prepare(
        'SELECT permission FROM stack_permissions WHERE stack_name=? AND user_id=?'
      ).all('alpha', 20);
      expect(rows.length).toBe(1);
      expect(rows[0].permission).toBe('view');
    });

    it('removePermission returns true when row existed', () => {
      perms.setPermission('beta', 20, 'view', 1);
      const result = perms.removePermission('beta', 20);
      expect(result).toBe(true);
      const row = db.prepare(
        'SELECT * FROM stack_permissions WHERE stack_name=? AND user_id=?'
      ).get('beta', 20);
      expect(row).toBeUndefined();
    });

    it('removePermission returns false when row did not exist', () => {
      const result = perms.removePermission('nonexistent', 20);
      expect(result).toBe(false);
    });
  });

  // ─── removeAllForStack ─────────────────────────────────────────────────────
  describe('removeAllForStack', () => {
    beforeAll(() => {
      seedUser(30, 'diana', 'viewer');
      seedUser(31, 'evan', 'viewer');
    });

    it('removes all permissions for a stack', () => {
      perms.setPermission('gamma', 30, 'view', 1);
      perms.setPermission('gamma', 31, 'operate', 1);
      perms.removeAllForStack('gamma');
      const rows = db.prepare(
        'SELECT * FROM stack_permissions WHERE stack_name=?'
      ).all('gamma');
      expect(rows.length).toBe(0);
    });
  });

  // ─── listUserPermissions ───────────────────────────────────────────────────
  describe('listUserPermissions', () => {
    beforeAll(() => {
      seedUser(40, 'fiona', 'viewer');
    });

    it('returns empty array when no permissions set', () => {
      const result = perms.listUserPermissions(40);
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });

    it('returns all stacks for user', () => {
      perms.setPermission('stack-a', 40, 'view', 1);
      perms.setPermission('stack-b', 40, 'operate', 1);
      const result = perms.listUserPermissions(40);
      expect(result.length).toBe(2);
      const names = result.map(r => r.stack_name).sort();
      expect(names).toEqual(['stack-a', 'stack-b']);
    });
  });

  // ─── filterContainers ─────────────────────────────────────────────────────
  describe('filterContainers', () => {
    beforeAll(() => {
      seedUser(50, 'guest', 'viewer');
    });

    const makeContainer = (id, stack) => ({
      Id: id,
      stack,
      Labels: { 'com.docker.compose.project': stack },
    });

    it('admin sees all containers', () => {
      const containers = [
        makeContainer('c1', 'web'),
        makeContainer('c2', 'db'),
        makeContainer('c3', '_standalone'),
      ];
      const result = perms.filterContainers(containers, 50, 'admin');
      expect(result.length).toBe(3);
    });

    it('viewer sees containers from stacks with no per-stack restriction', () => {
      // No per-stack permissions = all visible (uses global role view)
      const containers = [makeContainer('c1', 'web'), makeContainer('c2', 'db')];
      const result = perms.filterContainers(containers, 50, 'viewer');
      expect(result.length).toBe(2);
    });

    it('containers with perm=none are hidden', () => {
      db.prepare(
        `INSERT INTO stack_permissions (stack_name, user_id, permission, granted_by) VALUES ('hidden-stack', 50, 'none', 1)`
      ).run();
      const containers = [
        makeContainer('c1', 'hidden-stack'),
        makeContainer('c2', 'visible'),
      ];
      const result = perms.filterContainers(containers, 50, 'viewer');
      expect(result.length).toBe(1);
      expect(result[0].Id).toBe('c2');
    });

    it('containers with perm=view or operate remain visible', () => {
      db.prepare(
        `INSERT OR REPLACE INTO stack_permissions (stack_name, user_id, permission, granted_by) VALUES ('op-stack', 50, 'operate', 1)`
      ).run();
      const containers = [makeContainer('c1', 'op-stack')];
      const result = perms.filterContainers(containers, 50, 'viewer');
      expect(result.length).toBe(1);
    });

    it('uses Labels fallback when stack property is absent', () => {
      const container = { Id: 'cx', Labels: { 'com.docker.compose.project': 'label-stack' } };
      const result = perms.filterContainers([container], 50, 'viewer');
      expect(result.length).toBe(1);
    });
  });
});
