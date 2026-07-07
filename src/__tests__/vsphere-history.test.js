'use strict';

// v8.9.13-alpha.1 — vSphere snapshot history reader.

process.env.APP_SECRET = 'test-vsphere-hist';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

const history = require('../services/vsphere-history');
const { getDb } = require('../db');

describe('vsphere-history (v8.9.13-alpha.1)', () => {
  let hostId;
  beforeAll(() => {
    const db = getDb();
    db.prepare(`INSERT INTO docker_hosts (name, connection_type, daemon_type) VALUES ('esxi-test', 'tcp', 'vsphere')`).run();
    hostId = db.prepare("SELECT id FROM docker_hosts WHERE name='esxi-test'").get().id;
    const ins = db.prepare(`INSERT INTO vsphere_snapshots
      (host_id, esxi_host, cpu_pct, mem_pct, vm_total, vm_running, captured_at)
      VALUES (?, 'esxi-test', ?, ?, ?, ?, datetime('now', ?))`);
    ins.run(hostId, 10, 20, 5, 3, '-3 minutes');
    ins.run(hostId, 30, 40, 5, 4, '-2 minutes');
    ins.run(hostId, 50, 60, 5, 5, '-1 minutes');
  });

  it('returns snapshots in chronological order', () => {
    const rows = history.getHistory(hostId, 500);
    expect(rows.length).toBe(3);
    // reversed to chronological: oldest first
    expect(rows[0].cpu_pct).toBe(10);
    expect(rows[2].cpu_pct).toBe(50);
  });

  it('respects the limit', () => {
    const rows = history.getHistory(hostId, 2);
    expect(rows.length).toBe(2);
    // the 2 most-recent, chronological
    expect(rows[0].cpu_pct).toBe(30);
    expect(rows[1].cpu_pct).toBe(50);
  });

  it('exposes poll + retention config', () => {
    expect(history._internals.POLL_MS).toBeGreaterThanOrEqual(60000);
    expect(history._internals.RETENTION_DAYS).toBeGreaterThanOrEqual(1);
  });
});
