'use strict';

// v8.9.7-alpha.1 — Portainer G03 + Komodo G02 closure tests.

process.env.APP_SECRET = 'test-host-groups';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

const svc = require('../services/host-groups');
const { getDb } = require('../db');

describe('host-groups service (v8.9.7-alpha.1)', () => {
  beforeAll(() => {
    // Seed some hosts to reference.
    const db = getDb();
    db.prepare(`INSERT OR IGNORE INTO docker_hosts (id, name, connection_type) VALUES (?, ?, 'tcp')`).run(1000, 'host-a');
    db.prepare(`INSERT OR IGNORE INTO docker_hosts (id, name, connection_type) VALUES (?, ?, 'tcp')`).run(1001, 'host-b');
    db.prepare(`INSERT OR IGNORE INTO docker_hosts (id, name, connection_type) VALUES (?, ?, 'tcp')`).run(1002, 'host-c');
  });

  it('rejects empty name on create', () => {
    expect(() => svc.create({}, null)).toThrow(/name is required/);
  });

  it('creates a group with members', () => {
    const id = svc.create({ name: 'production', color: '#ff0000', hostIds: [1000, 1001] }, null);
    expect(id).toBeGreaterThan(0);
    const g = svc.get(id);
    expect(g.name).toBe('production');
    expect(g.color).toBe('#ff0000');
    expect(g.member_host_ids.sort()).toEqual([1000, 1001]);
  });

  it('list returns groups with member counts', () => {
    const groups = svc.list();
    const g = groups.find(x => x.name === 'production');
    expect(g).toBeDefined();
    expect(g.member_count).toBe(2);
  });

  it('groupsForHost returns memberships', () => {
    const groups = svc.groupsForHost(1000);
    expect(groups.length).toBeGreaterThanOrEqual(1);
    expect(groups[0].name).toBe('production');
  });

  it('update swaps membership', () => {
    const groups = svc.list();
    const g = groups.find(x => x.name === 'production');
    svc.update(g.id, { name: 'prod-renamed', hostIds: [1002] });
    const updated = svc.get(g.id);
    expect(updated.name).toBe('prod-renamed');
    expect(updated.member_host_ids).toEqual([1002]);
    expect(svc.groupsForHost(1000)).toEqual([]); // removed
  });

  it('delete cascades', () => {
    const id = svc.create({ name: 'to-delete', hostIds: [1000] }, null);
    svc.remove(id);
    expect(svc.get(id)).toBeNull();
    // Membership cascaded away
    expect(svc.groupsForHost(1000).find(g => g.id === id)).toBeUndefined();
  });
});
