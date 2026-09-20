'use strict';

jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('test must provide its database'); }) }));

const Database = require('better-sqlite3');
const dependencyMigration = require('../db/migrations/158_network_dependency_map');
const reachabilityMigration = require('../db/migrations/164_network_reachability_assessments');
const { NetworkReachabilityService } = require('../services/network-reachability');

const admin = { id: 1, username: 'admin', role: 'admin' };
const observedAt = '2026-07-30T12:00:00.000Z';
const evidenceHash = '0'.repeat(64);

function database() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
    CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE network_flow_log_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      provider_host_id INTEGER,
      observed_at TEXT NOT NULL,
      retention_until TEXT NOT NULL,
      entries_json TEXT NOT NULL,
      summary_json TEXT NOT NULL DEFAULT '{}',
      batch_hash TEXT NOT NULL UNIQUE
    );
    INSERT INTO users VALUES (1, 'admin');
  `);
  dependencyMigration.up(db);
  reachabilityMigration.up(db);
  return db;
}

function evidence(state = {}) {
  const item = value => ({ state: value, source: 'provider:normalized-export', evidenceHash, observedAt });
  return {
    route: item(state.route || 'pass'),
    policy: item(state.policy || 'allow'),
    attachment: item(state.attachment || 'present'),
    providerSimulation: item(state.providerSimulation || 'not_available'),
  };
}

function input(overrides = {}) {
  return {
    scopeKey: 'site:primary', mode: 'simulation', observedAt, freshnessMinutes: 60,
    source: { resourceKey: 'vm:web', address: '10.20.0.10', networkKey: 'network:frontend' },
    destination: { resourceKey: 'vm:api', address: '10.20.0.20', networkKey: 'network:backend' },
    protocol: 'tcp', destinationPort: 443, evidence: evidence(), ...overrides,
  };
}

function addDns(db) {
  db.prepare(`INSERT INTO network_dependency_dns_observations
    (source,observed_at,expires_at,records_json,observation_hash,created_by)
    VALUES (?,?,?,?,?,?)`).run('dns:normalized-export', '2026-07-30T11:45:00.000Z',
    '2026-07-30T13:00:00.000Z', JSON.stringify([
      { fqdn: 'api.example.test', type: 'A', address: '10.20.0.20', resourceKey: 'vm:api' },
    ]), '1'.repeat(64), 1);
}

function addFlow(db, action = 'allow') {
  db.prepare(`INSERT INTO network_flow_log_batches
    (source,provider_host_id,observed_at,retention_until,entries_json,batch_hash)
    VALUES (?,?,?,?,?,?)`).run('ovn:normalized-flows', null, '2026-07-30T11:50:00.000Z',
    '2026-08-30T12:00:00.000Z', JSON.stringify([{
      eventId: `flow:${action}`, occurredAt: '2026-07-30T11:49:00.000Z', action, protocol: 'tcp',
      sourceAddress: '10.20.0.10', sourcePort: 51000, destinationAddress: '10.20.0.20',
      destinationPort: 443, bytes: action === 'allow' ? 2048 : 0, packets: 4,
      sourceResourceKey: 'vm:web', destinationResourceKey: 'vm:api', ruleKey: `${action}-https`,
    }]), action === 'allow' ? '2'.repeat(64) : '3'.repeat(64));
}

describe('B119 simulated network reachability', () => {
  let db; let service;
  beforeEach(() => { db = database(); service = new NetworkReachabilityService(() => db); });
  afterEach(() => db.close());

  test('predicts pass from fresh route, policy, attachment and literal-address evidence without a probe', () => {
    const result = service.assess(input(), admin, { database: db });
    expect(result).toEqual(expect.objectContaining({ verdict: 'pass', networkCallsStarted: 0,
      providerMutationsStarted: 0, executeEndpoint: null }));
    expect(result.summary).toEqual(expect.objectContaining({ interpretation: 'predicted_reachable',
      confidence: 'medium', dnsState: 'pass', flowState: 'not_observed',
      activeProbe: expect.objectContaining({ state: 'not_run', supported: false }) }));
    expect(result.summary.limitations.join(' ')).toMatch(/not a data-plane connectivity proof/i);
  });

  test('fails on explicit deny evidence and becomes unknown when required evidence is stale', () => {
    const denied = service.assess(input({ evidence: evidence({ policy: 'deny' }) }), admin, { database: db });
    expect(denied).toEqual(expect.objectContaining({ verdict: 'fail',
      summary: expect.objectContaining({ interpretation: 'predicted_blocked', failures: ['policy_denied'] }) }));

    const stale = evidence();
    for (const item of Object.values(stale)) item.observedAt = '2026-07-30T09:00:00.000Z';
    const unknown = service.assess(input({ scopeKey: 'site:stale', evidence: stale }), admin, { database: db });
    expect(unknown).toEqual(expect.objectContaining({ verdict: 'unknown',
      summary: expect.objectContaining({ staleSignals: 4, interpretation: 'insufficient_evidence' }) }));
  });

  test('uses current normalized DNS and exact five-tuple history as corroboration only', () => {
    addDns(db); addFlow(db);
    const hostname = { resourceKey: 'vm:api', hostname: 'api.example.test', networkKey: 'network:backend' };
    const result = service.assess(input({ destination: hostname }), admin, { database: db });
    expect(result).toEqual(expect.objectContaining({ verdict: 'pass', evidence: expect.objectContaining({
      dns: expect.objectContaining({ state: 'pass', addresses: ['10.20.0.20'], sourceRows: [1] }),
      flow: expect.objectContaining({ state: 'observed_allowed', matched: 1, ruleKeys: ['allow-https'] }),
    }) }));

    const incomplete = evidence({ route: 'unknown', policy: 'unknown' });
    const unknown = service.assess(input({ scopeKey: 'site:flow-only', destination: hostname,
      evidence: incomplete }), admin, { database: db });
    expect(unknown.verdict).toBe('unknown');
    expect(unknown.summary.flowState).toBe('observed_allowed');
  });

  test('deduplicates immutable assessments and rejects secrets, malformed modes and non-admin actors', () => {
    const body = input(); const first = service.assess(body, admin, { database: db });
    expect(service.assess(body, admin, { database: db })).toEqual(expect.objectContaining({
      id: first.id, assessmentHash: first.assessmentHash, duplicate: true,
    }));
    expect(() => service.assess({ ...body, accessToken: 'forbidden' }, admin, { database: db }))
      .toThrow(expect.objectContaining({ code: 'SECRET_FIELD' }));
    expect(() => service.assess({ ...body, mode: 'active' }, admin, { database: db }))
      .toThrow(expect.objectContaining({ code: 'INVALID_NETWORK_REACHABILITY_INPUT' }));
    expect(() => service.assess(body, { id: 2, role: 'viewer' }, { database: db }))
      .toThrow(expect.objectContaining({ code: 'ADMIN_REQUIRED' }));
    expect(db.prepare('SELECT COUNT(*) count FROM network_reachability_assessments').get().count).toBe(1);
  });

  test('migration enforces simulation-only immutable zero-action records', () => {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='network_reachability_assessments'")
      .get().sql;
    expect(sql).toContain("CHECK(mode='simulation')");
    expect(sql).toContain('CHECK(network_calls_started=0)');
    expect(sql).toContain('CHECK(provider_mutations_started=0)');
  });
});
