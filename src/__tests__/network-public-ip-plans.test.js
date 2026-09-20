'use strict';

jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('test must provide its database'); }) }));

const crypto = require('crypto');
const Database = require('better-sqlite3');
const migration = require('../db/migrations/162_network_public_ip_plans');
const { NetworkPublicIpPlanService } = require('../services/network-public-ip-plans');

const admin = { id: 1, username: 'admin', role: 'admin' };
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');

function database() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY,username TEXT); INSERT INTO users VALUES (1,'admin');`);
  migration.up(db); return db;
}

function input(overrides = {}) {
  return { scopeKey: 'tenant:blue', providerType: 'openstack', action: 'allocate', addressFamily: 'ipv4',
    publicAddress: null, target: null,
    ownership: { tenantKey: 'tenant:blue', ownerKey: 'team:platform', ownershipToken: 'ownership:public-ip-1', managed: true },
    quota: { limit: 10, used: 3, requested: 1 },
    cost: { currency: 'EUR', hourlyMicros: 5000, source: 'rate-card:network', observedAt: '2026-07-30T10:00:00Z' },
    conflictState: 'clear', allocationState: 'absent', expectedVersion: null, mappingCount: 0,
    dependentResourceKeys: [], capability: { supported: true, reason: 'signed adapter capability evidence' },
    checks: [{ name: 'quota', state: 'pass', evidenceHash: digest('quota') },
      { name: 'conflict', state: 'pass', evidenceHash: digest('conflict') }], ...overrides };
}

function target(overrides = {}) {
  return { resourceKey: 'vm:web', privateAddress: '10.20.1.10', privatePort: 8443,
    publicPort: 443, protocol: 'tcp', ...overrides };
}

describe('B124 NAT/public-IP lifecycle plans', () => {
  let db; let service;
  beforeEach(() => { db = database(); service = new NetworkPublicIpPlanService(() => db); });
  afterEach(() => db.close());

  test('creates ready immutable allocate, map, unmap and release plans without apply', () => {
    const allocate = service.create(input(), admin, { database: db });
    const map = service.create(input({ action: 'map', publicAddress: '198.51.100.10', target: target(),
      allocationState: 'allocated', expectedVersion: 'v4' }), admin, { database: db });
    const unmap = service.create(input({ action: 'unmap', publicAddress: '198.51.100.10', target: target(),
      allocationState: 'mapped', expectedVersion: 'v5', mappingCount: 1 }), admin, { database: db });
    const release = service.create(input({ action: 'release', publicAddress: '198.51.100.10',
      allocationState: 'allocated', expectedVersion: 'v6' }), admin, { database: db });
    for (const plan of [allocate, map, unmap, release]) expect(plan).toEqual(expect.objectContaining({
      state: 'ready', blockers: [], providerMutationsStarted: 0, externalMutationsStarted: 0,
      executeEndpoint: null, planHash: expect.stringMatching(/^[a-f0-9]{64}$/) }));
    expect(map.target).toEqual(target()); expect(release.cost).toEqual(expect.objectContaining({ currency: 'EUR', hourlyMicros: 5000 }));
  });

  test('blocks quota, conflict, capability and incomplete checks', () => {
    const result = service.create(input({ quota: { limit: 3, used: 3, requested: 1 }, conflictState: 'unknown',
      capability: { supported: false, reason: 'adapter does not expose allocation' },
      checks: [{ name: 'quota', state: 'unknown', evidenceHash: digest('unknown') }] }), admin, { database: db });
    expect(result).toEqual(expect.objectContaining({ state: 'blocked', blockers: expect.arrayContaining([
      'provider_capability_unsupported', 'conflict_unknown', 'checks_incomplete', 'quota_exceeded',
    ]) }));
  });

  test('blocks unsafe release and invalid lifecycle states', () => {
    const release = service.create(input({ action: 'release', publicAddress: '198.51.100.10',
      allocationState: 'mapped', expectedVersion: null, mappingCount: 2,
      dependentResourceKeys: ['dns:web', 'lb:frontend'], ownership: { ...input().ownership, managed: false } }), admin,
    { database: db });
    expect(release.blockers).toEqual(expect.arrayContaining(['allocation_state_invalid', 'expected_version_required',
      'managed_ownership_required', 'active_mappings', 'dependent_resources']));
    const map = service.create(input({ action: 'map', publicAddress: null, target: null,
      allocationState: 'unknown', expectedVersion: null }), admin, { database: db });
    expect(map.blockers).toEqual(expect.arrayContaining(['public_address_required', 'target_required',
      'allocation_state_invalid', 'expected_version_required']));
  });

  test('enforces address family and port/protocol consistency', () => {
    expect(() => service.create(input({ action: 'map', publicAddress: '2001:db8::10', target: target(),
      allocationState: 'allocated', expectedVersion: 'v1' }), admin, { database: db })).toThrow(/addressFamily/);
    expect(() => service.create(input({ action: 'map', publicAddress: '198.51.100.10',
      target: target({ publicPort: null }), allocationState: 'allocated', expectedVersion: 'v1' }), admin,
    { database: db })).toThrow(/supplied together/);
    expect(() => service.create(input({ action: 'map', publicAddress: '198.51.100.10',
      target: target({ privatePort: null, publicPort: null, protocol: 'tcp' }), allocationState: 'allocated',
      expectedVersion: 'v1' }), admin, { database: db })).toThrow(/Address-only mapping/);
  });

  test('deduplicates strict plans and rejects secrets, float cost and non-admin writes', () => {
    const body = input(); const first = service.create(body, admin, { database: db });
    expect(service.create(body, admin, { database: db })).toEqual(expect.objectContaining({
      id: first.id, planHash: first.planHash, duplicate: true }));
    expect(() => service.create({ ...body, accessToken: 'forbidden' }, admin, { database: db }))
      .toThrow(expect.objectContaining({ code: 'SECRET_FIELD' }));
    expect(() => service.create(input({ cost: { ...body.cost, hourlyMicros: 0.5 } }), admin, { database: db }))
      .toThrow(/hourlyMicros/);
    expect(() => service.create(body, { id: 2, role: 'viewer' }, { database: db }))
      .toThrow(expect.objectContaining({ code: 'ADMIN_REQUIRED' }));
    expect(db.prepare('SELECT COUNT(*) count FROM network_public_ip_lifecycle_plans').get().count).toBe(1);
  });

  test('migration stores immutable blockers, plan hash and zero-action counters', () => {
    const columns = db.prepare('PRAGMA table_info(network_public_ip_lifecycle_plans)').all().map(row => row.name);
    expect(columns).toEqual(expect.arrayContaining(['plan_json', 'blockers_json', 'state', 'plan_hash',
      'provider_mutations_started', 'external_mutations_started']));
  });
});
