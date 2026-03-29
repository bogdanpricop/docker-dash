'use strict';

// Test audit log hash chain integrity

process.env.APP_SECRET = 'test-secret-key-for-jest-tests-only';
process.env.DB_PATH = ':memory:';

jest.resetModules();

describe('Audit Log Integrity (Hash Chain)', () => {
  let db, auditService, config;

  beforeAll(() => {
    const { getDb } = require('../db');
    db = getDb();
    auditService = require('../services/audit');
    config = require('../config');
  });

  afterAll(() => {
    const { closeDb } = require('../db');
    closeDb();
  });

  it('should create entries with hash chain', () => {
    // Use userId=null to avoid FK constraint (no users in test DB)
    auditService.log({ username: 'admin', action: 'chain_test_1', ip: '127.0.0.1' });
    auditService.log({ username: 'admin', action: 'chain_test_2', ip: '127.0.0.1' });
    auditService.log({ username: 'user2', action: 'chain_test_3', ip: '10.0.0.1' });

    const rows = db.prepare("SELECT * FROM audit_log WHERE action LIKE 'chain_test_%' ORDER BY id ASC").all();
    expect(rows.length).toBe(3);

    for (const row of rows) {
      expect(row.entry_hash).toBeTruthy();
      expect(row.entry_hash.length).toBe(64);
      expect(row.prev_hash).toBeTruthy();
      expect(row.prev_hash.length).toBe(64);
    }

    // Verify chain linkage
    expect(rows[1].prev_hash).toBe(rows[0].entry_hash);
    expect(rows[2].prev_hash).toBe(rows[1].entry_hash);
  });

  it('should verify a valid chain', () => {
    const result = auditService.verify();
    expect(result.valid).toBe(true);
    expect(result.entriesChecked).toBeGreaterThan(0);
    expect(result.brokenAt).toBeNull();
  });

  it('should detect a tampered entry', () => {
    const rows = db.prepare("SELECT id FROM audit_log WHERE action LIKE 'chain_test_%' ORDER BY id ASC").all();
    expect(rows.length).toBeGreaterThanOrEqual(2);

    const targetId = rows[1].id;
    db.prepare('UPDATE audit_log SET details = ? WHERE id = ?').run('TAMPERED_DATA', targetId);

    const result = auditService.verify();
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBeTruthy();
    expect(result.brokenAt.id).toBe(targetId);

    // Restore
    db.prepare('UPDATE audit_log SET details = NULL WHERE id = ?').run(targetId);
  });

  it('should export as JSON with entries', () => {
    auditService.log({ username: 'admin', action: 'export_json_test', ip: '127.0.0.1' });

    const json = auditService.export('json');
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0]).toHaveProperty('entry_hash');
  });

  it('should export as CSV', () => {
    const csv = auditService.export('csv');
    const lines = csv.split('\n');
    expect(lines[0]).toContain('id,');
    expect(lines[0]).toContain('entry_hash');
    expect(lines.length).toBeGreaterThan(1);
  });

  it('should export as syslog (RFC 5424)', () => {
    const syslog = auditService.export('syslog');
    expect(syslog.length).toBeGreaterThan(0);
    expect(syslog).toContain('docker-dash');
    expect(syslog).toContain('[audit@0');
  });

  it('should block cleanup in strict mode', () => {
    const originalMode = config.security.isStrict;
    config.security.isStrict = true;

    const deleted = auditService.cleanup(0);
    expect(deleted).toBe(0);

    config.security.isStrict = originalMode;
  });

  it('onLog hook should fire after each entry', () => {
    const entries = [];
    auditService.onLog((entry) => entries.push(entry));

    auditService.log({ username: 'admin', action: 'hook_test', ip: '127.0.0.1' });

    expect(entries.length).toBe(1);
    expect(entries[0].action).toBe('hook_test');

    auditService.onLog(null);
  });
});
