'use strict';

// v8.9.9-alpha.1 — Komodo G09 closure tests.

process.env.APP_SECRET = 'test-alert-routes';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

const svc = require('../services/alert-routes');
const { getDb } = require('../db');

describe('alert-routes service (v8.9.9-alpha.1)', () => {
  beforeAll(() => {
    const db = getDb();
    db.prepare(`INSERT OR IGNORE INTO docker_hosts (id, name, connection_type) VALUES (?, ?, 'tcp')`).run(2000, 'host-1');
    db.prepare(`INSERT OR IGNORE INTO docker_hosts (id, name, connection_type) VALUES (?, ?, 'tcp')`).run(2001, 'host-2');
  });

  it('rejects invalid scope_type', () => {
    expect(() => svc.create({ scopeType: 'invalid', channelId: 1 })).toThrow(/scope_type/);
  });

  it('rejects host scope without scope_id', () => {
    expect(() => svc.create({ scopeType: 'host', channelId: 1 })).toThrow(/scope_id required/);
  });

  it('rejects missing channel_id', () => {
    expect(() => svc.create({ scopeType: 'all' })).toThrow(/channel_id/);
  });

  it('creates and lists routes', () => {
    const id = svc.create({ scopeType: 'all', channelId: 100 });
    expect(id).toBeGreaterThan(0);
    const list = svc.list();
    expect(list.some(r => r.id === id && r.channel_id === 100)).toBe(true);
  });

  it('resolves scope_type=all when no host-specific routes', () => {
    const channels = svc.resolve({ hostId: 2000, severity: 'warning' });
    expect(channels).toContain(100);
  });

  it('host-scope takes precedence over all-scope', () => {
    svc.create({ scopeType: 'host', scopeId: 2000, channelId: 200 });
    const channels = svc.resolve({ hostId: 2000, severity: 'info' });
    expect(channels).toContain(200);
    expect(channels).not.toContain(100); // fallback shouldn't fire
  });

  it('severity filtering: info route ignored when want critical', () => {
    // scope host 2001, channel 300, severity_min = critical
    const id = svc.create({ scopeType: 'host', scopeId: 2001, channelId: 300, severityMin: 'critical' });
    expect(svc.resolve({ hostId: 2001, severity: 'info' })).not.toContain(300);
    expect(svc.resolve({ hostId: 2001, severity: 'critical' })).toContain(300);
    svc.remove(id);
  });
});
