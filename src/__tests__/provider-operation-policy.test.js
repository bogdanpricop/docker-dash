'use strict';

jest.mock('../config', () => ({
  features: { readOnly: false },
  security: { encryptionKey: 'provider-operation-policy-test-key' },
}));
jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('test must inject a database'); }) }));

const Database = require('better-sqlite3');
const migration = require('../db/migrations/107_provider_operations');
const { OperationPolicyService, OperationPolicyError } = require('../services/provider-operations/policy');

describe('Provider operation control policy', () => {
  let db;
  let policy;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY);
      CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY, daemon_type TEXT, is_active INTEGER);
      INSERT INTO users (id) VALUES (1);
      INSERT INTO docker_hosts (id, daemon_type, is_active) VALUES (7, 'xen', 1), (8, 'vsphere', 1);
    `);
    migration.up(db);
    policy = new OperationPolicyService(() => db);
  });
  afterEach(() => db.close());

  it('creates an active global default and gates dynamic read-only mode', () => {
    expect(policy.list()).toEqual([expect.objectContaining({ scope_type: 'global', scope_key: '*', mode: 'active' })]);
    policy.set({ scopeType: 'global', mode: 'read_only', reason: 'Change freeze', updatedBy: 1 });
    expect(policy.evaluate({ providerType: 'xen', hostId: 7 })).toEqual(expect.objectContaining({
      allowed: false, code: 'OPERATION_READ_ONLY', scopeType: 'global',
    }));
    expect(() => policy.assertAllowed({ providerType: 'xen', hostId: 7 })).toThrow(OperationPolicyError);
    policy.set({ scopeType: 'global', mode: 'active', updatedBy: 1 });
    expect(policy.evaluate({ providerType: 'xen', hostId: 7 }).allowed).toBe(true);
  });

  it('applies provider and host emergency scopes without blocking unrelated endpoints', () => {
    policy.set({ scopeType: 'provider', scopeKey: 'xen', mode: 'emergency_stop', reason: 'XAPI incident', updatedBy: 1 });
    expect(policy.evaluate({ providerType: 'xen', hostId: 7 }).code).toBe('PROVIDER_EMERGENCY_STOP');
    expect(policy.evaluate({ providerType: 'vsphere', hostId: 8 }).allowed).toBe(true);
    policy.set({ scopeType: 'host', scopeKey: '8', mode: 'read_only', reason: 'Maintenance', updatedBy: 1 });
    expect(policy.evaluate({ providerType: 'vsphere', hostId: 8 }).code).toBe('OPERATION_READ_ONLY');
  });

  it('enforces a freeze only inside its explicit window', () => {
    policy.set({
      scopeType: 'host', scopeKey: 7, mode: 'frozen', reason: 'Approved maintenance freeze',
      freezeStartsAt: '2026-07-26T10:00:00Z', freezeEndsAt: '2026-07-26T12:00:00Z', updatedBy: 1,
    });
    expect(policy.evaluate({ providerType: 'xen', hostId: 7, at: '2026-07-26T11:00:00Z' }).code).toBe('OPERATION_FROZEN');
    expect(policy.evaluate({ providerType: 'xen', hostId: 7, at: '2026-07-26T13:00:00Z' }).allowed).toBe(true);
  });

  it('validates blocking reasons, freeze bounds and host scope', () => {
    expect(() => policy.set({ scopeType: 'global', mode: 'read_only' })).toThrow(/reason/i);
    expect(() => policy.set({ scopeType: 'host', scopeKey: 99, mode: 'active' })).toThrow(/not found/i);
    expect(() => policy.set({
      scopeType: 'global', mode: 'frozen', reason: 'bad bounds',
      freezeStartsAt: '2026-07-26T12:00:00Z', freezeEndsAt: '2026-07-26T11:00:00Z',
    })).toThrow(/after/i);
  });
});
