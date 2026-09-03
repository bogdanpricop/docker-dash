'use strict';

jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('test must provide its database'); }) }));

const Database = require('better-sqlite3');
const migration = require('../db/migrations/156_network_intent_validation');
const { NetworkIntentValidator, _internals } = require('../services/network-intent-validator');

const admin = { id: 1, username: 'admin', role: 'admin' };

function database() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY,username TEXT); INSERT INTO users VALUES (1,'admin');");
  migration.up(db);
  return db;
}

function network(overrides = {}) {
  return {
    networkKey: 'network:prod', fabricKey: 'fabric:a', l2DomainKey: 'l2:prod',
    cidrs: ['10.20.0.0/24', '2001:db8:20::/64'], gateways: ['10.20.0.1', '2001:db8:20::1'],
    dnsServers: ['10.20.0.53', '2001:db8:20::53'], vlanId: 120, vni: 50120,
    routes: [{ destination: '0.0.0.0/0', nextHop: '10.20.0.1', metric: 100 },
      { destination: '::/0', nextHop: '2001:db8:20::1', metric: 100 }],
    evidence: { source: 'provider:inventory', observedAt: '2026-07-30T10:00:00Z', complete: true, fresh: true },
    ...overrides,
  };
}

function intent(overrides = {}) {
  return {
    scopeKey: 'site:primary', intentVersion: 'v1', inventoryComplete: true,
    requirements: { requireGateway: true, requireDns: true, requireVlan: true, requireVni: true },
    networks: [network()], reservedCidrs: [{ cidr: '10.30.0.0/16', ownerKey: 'network:dr', purpose: 'DR' }],
    ...overrides,
  };
}

describe('B125 network intent validation', () => {
  let db; let validator;
  beforeEach(() => { db = database(); validator = new NetworkIntentValidator(() => db); });
  afterEach(() => db.close());

  test('passes complete conflict-free dual-stack intent and emits immutable executor evidence', () => {
    const result = validator.validate(intent(), admin);
    expect(result).toEqual(expect.objectContaining({ verdict: 'pass', providerMutationsStarted: 0,
      networkCallsStarted: 0, executeEndpoint: null, intentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      validationHash: expect.stringMatching(/^[a-f0-9]{64}$/) }));
    expect(result.executorGate).toEqual({ acceptableVerdict: 'pass', requiredIntentHash: result.intentHash,
      requiredValidationHash: result.validationHash });
    expect(result.networks[0].cidrs).toEqual(['10.20.0.0/24', '2001:db8:20::/64']);
    expect(validator.validate(intent(), admin)).toEqual(expect.objectContaining({ id: result.id, duplicate: true }));
  });

  test('never passes incomplete or stale evidence', () => {
    const incomplete = validator.validate(intent({ inventoryComplete: false,
      networks: [network({ evidence: { source: 'provider:inventory', observedAt: '2026-07-30T10:00:00Z', complete: false, fresh: false } })] }), admin);
    expect(incomplete.verdict).toBe('unknown');
    expect(incomplete.findings.map(item => item.code)).toEqual(expect.arrayContaining([
      'INVENTORY_INCOMPLETE', 'EVIDENCE_INCOMPLETE', 'EVIDENCE_STALE',
    ]));
  });

  test('fails canonical boundaries, gateway membership and unusable DNS', () => {
    const result = validator.validate(intent({ networks: [network({ cidrs: ['10.20.0.9/24'],
      gateways: ['10.21.0.1'], dnsServers: ['0.0.0.0'], routes: [] })] }), admin);
    expect(result.verdict).toBe('fail');
    expect(result.findings.map(item => item.code)).toEqual(expect.arrayContaining([
      'CIDR_HOST_BITS_SET', 'GATEWAY_OUTSIDE_CIDR', 'DNS_ADDRESS_UNSAFE',
    ]));
    expect(result.networks[0].cidrs).toEqual(['10.20.0.0/24']);
  });

  test('detects cross-resource CIDR, reserved range, VLAN, VNI and gateway conflicts', () => {
    const second = network({ networkKey: 'network:other', cidrs: ['10.20.0.128/25'], gateways: ['10.20.0.1'],
      dnsServers: ['10.20.0.54'], routes: [], vlanId: 120, vni: 50120 });
    const result = validator.validate(intent({ networks: [network({ routes: [] }), second],
      reservedCidrs: [{ cidr: '10.20.0.0/28', ownerKey: 'network:reserved', purpose: 'appliance' }] }), admin);
    expect(result.verdict).toBe('fail');
    expect(result.findings.map(item => item.code)).toEqual(expect.arrayContaining([
      'CIDR_OVERLAP', 'RESERVED_CIDR_CONFLICT', 'VLAN_COLLISION', 'VNI_COLLISION', 'GATEWAY_DUPLICATE',
    ]));
  });

  test('detects exact route conflicts but accepts ordinary longest-prefix routing', () => {
    const result = validator.validate(intent({ networks: [network({ routes: [
      { destination: '0.0.0.0/0', nextHop: '10.20.0.1', metric: 100 },
      { destination: '0.0.0.0/0', nextHop: '10.20.0.2', metric: 200 },
      { destination: '10.40.0.0/16', nextHop: '10.20.0.1', metric: 100 },
    ] })] }), admin);
    expect(result.verdict).toBe('fail');
    expect(result.findings.filter(item => item.code === 'ROUTE_CONFLICT')).toHaveLength(1);
    expect(result.findings.some(item => item.message.includes('10.40.0.0/16'))).toBe(false);
  });

  test('rejects secret-shaped and oversized input before persistence', () => {
    expect(() => validator.validate({ ...intent(), password: 'forbidden' }, admin)).toThrow(expect.objectContaining({ code: 'SECRET_FIELD' }));
    expect(() => validator.validate(intent({ networks: Array.from({ length: 201 }, (_, index) => network({ networkKey: `network:${index}` })) }), admin))
      .toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(db.prepare('SELECT COUNT(*) count FROM network_intent_validations').get().count).toBe(0);
  });

  test('parses alternate IPv6 spellings into the same numeric range', () => {
    const compressed = _internals.parseCidr('2001:db8::/64', 'cidr');
    const expanded = _internals.parseCidr('2001:0db8:0000:0000::/64', 'cidr');
    expect(compressed.canonical).toBe('2001:db8::/64');
    expect({ start: compressed.start, end: compressed.end }).toEqual({ start: expanded.start, end: expanded.end });
    expect(_internals.overlaps(compressed, expanded)).toBe(true);
  });

  test('migration creates immutable validation storage', () => {
    const columns = db.prepare('PRAGMA table_info(network_intent_validations)').all().map(row => row.name);
    expect(columns).toEqual(expect.arrayContaining(['intent_json', 'findings_json', 'verdict', 'intent_hash', 'validation_hash']));
  });
});
