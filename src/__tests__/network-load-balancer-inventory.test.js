'use strict';

jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('test must provide its database'); }) }));

const Database = require('better-sqlite3');
const migration = require('../db/migrations/161_network_load_balancer_inventory');
const { NetworkLoadBalancerInventoryService } = require('../services/network-load-balancer-inventory');

const admin = { id: 1, username: 'admin', role: 'admin' };
const now = '2026-07-30T12:00:00Z';

function database() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY,username TEXT);
    CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY,name TEXT);
    INSERT INTO users VALUES (1,'admin');`);
  migration.up(db); return db;
}

function loadBalancer(overrides = {}) {
  return { loadBalancerKey: 'lb:frontend', name: 'Frontend', scopeKey: 'tenant:blue', providerState: 'active',
    vipAddresses: ['10.20.0.5', '2001:db8:20::5'], networkKeys: ['network:frontend'], resourceKeys: ['vm:web-a', 'vm:web-b'],
    listeners: [{ listenerKey: 'listener:https', protocol: 'https', port: 443, defaultPoolKey: 'pool:web', tlsState: 'valid' }],
    pools: [{ poolKey: 'pool:web', protocol: 'https', algorithm: 'least_connections', members: [
      { memberKey: 'member:web-a', resourceKey: 'vm:web-a', address: '10.20.1.10', port: 8443, adminState: 'enabled', health: 'healthy', weight: 100 },
      { memberKey: 'member:web-b', resourceKey: 'vm:web-b', address: '10.20.1.11', port: 8443, adminState: 'enabled', health: 'healthy', weight: 100 },
    ] }], ...overrides };
}

function input(loadBalancers, overrides = {}) {
  return { source: 'octavia:normalized-export', providerHostId: null, providerType: 'openstack',
    observedAt: '2026-07-30T11:00:00Z', expiresAt: '2026-07-30T13:00:00Z',
    coverage: { complete: true, reason: 'all tenant load balancers observed' }, loadBalancers, ...overrides };
}

describe('B123 normalized load balancer inventory', () => {
  let db; let service;
  beforeEach(() => { db = database(); service = new NetworkLoadBalancerInventoryService(() => db); });
  afterEach(() => db.close());

  test('normalizes multi-VIP listener, pool, member health and canonical links', () => {
    const result = service.record(input([loadBalancer()]), admin, { database: db, now });
    expect(result).toEqual(expect.objectContaining({ providerType: 'openstack',
      summary: expect.objectContaining({ state: 'pass', loadBalancers: 1, vips: 2, listeners: 1,
        pools: 1, members: 2, healthyMembers: 2 }), providerMutationsStarted: 0, networkCallsStarted: 0,
    activeHealthProbesStarted: 0 }));
    expect(result.loadBalancers[0]).toEqual(expect.objectContaining({ state: 'pass',
      networkKeys: ['network:frontend'], resourceKeys: ['vm:web-a', 'vm:web-b'] }));
  });

  test('preserves provider degradation, enabled member health and TLS warnings', () => {
    const degraded = loadBalancer({ providerState: 'degraded',
      listeners: [{ listenerKey: 'listener:https', protocol: 'https', port: 443, defaultPoolKey: 'pool:web', tlsState: 'expired' }],
      pools: [{ poolKey: 'pool:web', protocol: 'https', algorithm: 'round_robin', members: [
        { memberKey: 'member:bad', resourceKey: null, address: '10.20.1.10', port: 443,
          adminState: 'enabled', health: 'unhealthy', weight: 100 },
        { memberKey: 'member:disabled', resourceKey: null, address: '10.20.1.11', port: 443,
          adminState: 'disabled', health: 'unknown', weight: 0 },
      ] }] });
    const result = service.record(input([degraded]), admin, { database: db, now });
    expect(result.summary).toEqual(expect.objectContaining({ state: 'warning', unhealthyMembers: 1,
      unknownMembers: 1, expiredTls: 1 }));
    expect(result.loadBalancers[0]).toEqual(expect.objectContaining({ state: 'warning' }));
  });

  test('fails provider errors and fails closed on incomplete, expired or unknown health', () => {
    const failed = service.record(input([loadBalancer({ providerState: 'error' })]), admin, { database: db, now });
    expect(failed.summary.state).toBe('fail');
    const unknownMember = loadBalancer({ pools: [{ poolKey: 'pool:web', protocol: 'https', algorithm: 'hash', members: [
      { memberKey: 'member:unknown', resourceKey: null, address: '10.20.1.10', port: 443,
        adminState: 'enabled', health: 'unknown', weight: 100 },
    ] }] });
    const unknown = service.record(input([unknownMember], { expiresAt: '2026-07-30T11:30:00Z',
      coverage: { complete: false, reason: 'one provider page unavailable' } }), admin, { database: db, now });
    expect(unknown.summary).toEqual(expect.objectContaining({ state: 'unknown', coverageComplete: false,
      evidenceExpired: true, unknownMembers: 1 }));
  });

  test('rejects dangling pools, duplicate identities and sensitive provider references', () => {
    expect(() => service.record(input([loadBalancer({ listeners: [{ listenerKey: 'listener:bad', protocol: 'tcp',
      port: 80, defaultPoolKey: 'pool:missing', tlsState: 'not_applicable' }] })]), admin, { database: db, now }))
      .toThrow(/unknown default pool/);
    expect(() => service.record(input([loadBalancer(), loadBalancer()]), admin, { database: db, now }))
      .toThrow(/loadBalancerKey contains duplicates/);
    expect(() => service.record(input([{ ...loadBalancer(), nativeRef: 'provider-secret-id' }]), admin,
      { database: db, now })).toThrow(expect.objectContaining({ code: 'SECRET_FIELD' }));
    expect(db.prepare('SELECT COUNT(*) count FROM network_load_balancer_observations').get().count).toBe(0);
  });

  test('deduplicates bounded strict observations and rejects non-admin writes', () => {
    const body = input([loadBalancer()]); const first = service.record(body, admin, { database: db, now });
    expect(service.record(body, admin, { database: db, now: '2026-07-30T12:01:00Z' }))
      .toEqual(expect.objectContaining({ id: first.id, observationHash: first.observationHash, duplicate: true }));
    expect(() => service.record(input(Array.from({ length: 501 }, (_, index) => loadBalancer({
      loadBalancerKey: `lb:${index}` }))), admin, { database: db, now }))
      .toThrow(expect.objectContaining({ code: 'INVALID_LOAD_BALANCER_INVENTORY' }));
    expect(() => service.record(body, { id: 2, role: 'viewer' }, { database: db, now }))
      .toThrow(expect.objectContaining({ code: 'ADMIN_REQUIRED' }));
    expect(db.prepare('SELECT COUNT(*) count FROM network_load_balancer_observations').get().count).toBe(1);
  });

  test('migration persists immutable inventory and zero-action safety counters', () => {
    const columns = db.prepare('PRAGMA table_info(network_load_balancer_observations)').all().map(row => row.name);
    expect(columns).toEqual(expect.arrayContaining(['load_balancers_json', 'summary_json', 'observation_hash',
      'provider_mutations_started', 'network_calls_started']));
  });
});
