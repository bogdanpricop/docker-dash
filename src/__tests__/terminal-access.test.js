'use strict';

process.env.APP_SECRET = 'terminal-access-test-secret-32-characters';
process.env.ENCRYPTION_KEY = 'terminal-access-test-encryption-key';
process.env.DB_PATH = ':memory:';

const { getDb, closeDb } = require('../db');
const config = require('../config');
const terminalAccess = require('../services/terminal-access');

let defaultHostId;
let secondHostId;

beforeAll(() => {
  const db = getDb();
  defaultHostId = db.prepare('SELECT id FROM docker_hosts WHERE is_default = 1').get().id;
  secondHostId = Number(db.prepare(`
    INSERT INTO docker_hosts (name, connection_type, socket_path, is_active, is_default)
    VALUES ('Terminal test remote', 'socket', '/var/run/docker.sock', 1, 0)
  `).run().lastInsertRowid);
});

afterEach(() => {
  getDb().prepare('DELETE FROM terminal_access_locks').run();
  config.features.exec = true;
  config.security.terminalAccessOverride = 'managed';
});

afterAll(() => closeDb());

describe('emergency terminal access policy', () => {
  it('locks every role globally and preserves the audit reason', () => {
    terminalAccess.setGlobal({ locked: true, reason: 'Active incident' });
    expect(terminalAccess.effective(defaultHostId)).toMatchObject({
      locked: true, source: 'global', reason: 'Active incident',
    });
    expect(terminalAccess.effective(secondHostId).locked).toBe(true);
    expect(terminalAccess.status().global).toMatchObject({ locked: true, reason: 'Active incident' });
  });

  it('normalizes host 0 to the default host and isolates a per-host lock', () => {
    terminalAccess.setHost(defaultHostId, { locked: true, reason: 'Default host investigation' });
    expect(terminalAccess.effective(0)).toMatchObject({
      locked: true, source: 'host', hostId: defaultHostId,
    });
    expect(terminalAccess.effective(secondHostId)).toMatchObject({ locked: false, hostId: secondHostId });

    terminalAccess.setHost(defaultHostId, { locked: false });
    expect(terminalAccess.effective(0).locked).toBe(false);
  });

  it('supports force-deny and recovery-allow environment overrides', () => {
    config.security.terminalAccessOverride = 'deny';
    expect(terminalAccess.effective(secondHostId)).toMatchObject({ locked: true, source: 'environment' });

    terminalAccess.setGlobal({ locked: true, reason: 'Persisted lock' });
    config.security.terminalAccessOverride = 'allow';
    expect(terminalAccess.effective(secondHostId)).toMatchObject({
      locked: false, source: 'environment_recovery',
    });

    config.features.exec = false;
    expect(terminalAccess.effective(secondHostId)).toMatchObject({ locked: true, source: 'feature_flag' });
  });

  it('rejects unknown hosts and bounds persisted reasons', () => {
    expect(() => terminalAccess.normalizeHostId('1oops')).toThrow('hostId must be a non-negative integer');
    expect(() => terminalAccess.setHost(999999, { locked: true })).toThrow('Host not found');
    terminalAccess.setGlobal({ locked: true, reason: 'x'.repeat(700) });
    expect(terminalAccess.status().global.reason).toHaveLength(terminalAccess.MAX_REASON_LENGTH);
  });
});
