'use strict';

jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('test must provide its database'); }) }));

const crypto = require('crypto');
const Database = require('better-sqlite3');
const migration = require('../db/migrations/158_network_dependency_map');
const { NetworkDependencyMapService } = require('../services/network-dependency-map');

const admin = { id: 1, username: 'admin', role: 'admin' };
const now = '2026-07-30T12:00:00.000Z';
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function database() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
    CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO users VALUES (1, 'admin');
    CREATE TABLE network_flow_log_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, provider_host_id INTEGER,
      observed_at TEXT NOT NULL, retention_until TEXT NOT NULL, entries_json TEXT NOT NULL,
      summary_json TEXT NOT NULL DEFAULT '{}', batch_hash TEXT NOT NULL UNIQUE
    );
    CREATE TABLE resource_relationship_graphs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, observed_at TEXT NOT NULL,
      resources_json TEXT NOT NULL, edges_json TEXT NOT NULL, graph_hash TEXT NOT NULL UNIQUE
    );
    CREATE TABLE custom_metadata_schemas (
      schema_key TEXT PRIMARY KEY, sensitivity TEXT NOT NULL
    );
    CREATE TABLE custom_metadata_values (
      resource_key TEXT NOT NULL, resource_type TEXT NOT NULL, schema_key TEXT NOT NULL,
      value_json TEXT NOT NULL, value_hash TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(resource_key, schema_key)
    );
  `);
  migration.up(db);
  return db;
}

function addresses(overrides = {}) {
  return {
    source: 'provider:inventory', providerHostId: null, observedAt: '2026-07-30T10:00:00Z',
    coverage: { complete: true, reason: 'complete signed inventory export' },
    addresses: [
      { address: '10.20.0.10', resourceKey: 'vm:web', resourceKind: 'virtualMachine', displayName: 'Web', source: 'guest-agent' },
      { address: '10.20.0.20', resourceKey: 'vm:api', resourceKind: 'virtualMachine', displayName: 'API', source: 'provider' },
      { address: '10.20.0.30', resourceKey: 'vm:client', resourceKind: 'virtualMachine', displayName: 'Client', source: 'provider' },
      { address: '10.20.0.40', resourceKey: 'vm:cache', resourceKind: 'virtualMachine', displayName: 'Cache', source: 'provider' },
      { address: '10.20.0.99', resourceKey: 'vm:ambiguous-a', resourceKind: 'virtualMachine', displayName: 'Ambiguous A', source: 'provider' },
      { address: '10.20.0.99', resourceKey: 'vm:ambiguous-b', resourceKind: 'virtualMachine', displayName: 'Ambiguous B', source: 'provider' },
    ],
    ...overrides,
  };
}

function addGraph(db, observedAt = '2026-07-30T10:15:00Z') {
  const resources = [
    { resourceKey: 'vm:db', kind: 'virtualMachine', name: 'Database' },
    { resourceKey: 'vm:api', kind: 'virtualMachine', name: 'API' },
  ];
  const edges = [{ source: 'vm:db', target: 'vm:api', relationship: 'serves' }];
  db.prepare(`INSERT INTO resource_relationship_graphs
    (observed_at, resources_json, edges_json, graph_hash) VALUES (?,?,?,?)`)
    .run(observedAt, JSON.stringify(resources), JSON.stringify(edges), digest({ resources, edges, observedAt }));
}

function addMetadata(db) {
  db.prepare('INSERT INTO custom_metadata_schemas (schema_key,sensitivity) VALUES (?,?)')
    .run('dependency.requires', 'internal');
  db.prepare(`INSERT INTO custom_metadata_values
    (resource_key,resource_type,schema_key,value_json,value_hash,updated_at) VALUES (?,?,?,?,?,?)`)
    .run('vm:web', 'virtualMachine', 'dependency.requires', JSON.stringify('vm:api'), digest('metadata'), '2026-07-30 10:30:00');
}

function addFlows(db) {
  const entries = [
    { eventId: 'flow:1', occurredAt: '2026-07-30T11:00:00Z', action: 'allow', protocol: 'tcp',
      sourceAddress: '10.20.0.30', sourcePort: 51000, destinationAddress: '10.20.0.40', destinationPort: 6379,
      bytes: 2048, packets: 4, sourceResourceKey: null, destinationResourceKey: null, ruleKey: 'allow-cache' },
    { eventId: 'flow:2', occurredAt: '2026-07-30T11:01:00Z', action: 'allow', protocol: 'tcp',
      sourceAddress: '10.20.0.99', sourcePort: 51001, destinationAddress: '10.20.0.20', destinationPort: 443,
      bytes: 1024, packets: 2, sourceResourceKey: null, destinationResourceKey: 'vm:api', ruleKey: 'allow-api' },
    { eventId: 'flow:3', occurredAt: '2026-07-30T11:02:00Z', action: 'deny', protocol: 'tcp',
      sourceAddress: '10.20.0.10', sourcePort: 51002, destinationAddress: '10.20.0.20', destinationPort: 22,
      bytes: 0, packets: 1, sourceResourceKey: 'vm:web', destinationResourceKey: 'vm:api', ruleKey: 'deny-ssh' },
  ];
  db.prepare(`INSERT INTO network_flow_log_batches
    (source,provider_host_id,observed_at,retention_until,entries_json,batch_hash) VALUES (?,?,?,?,?,?)`)
    .run('ovn:flows', null, '2026-07-30T11:05:00Z', '2026-08-29T11:05:00Z', JSON.stringify(entries), digest(entries));
}

describe('B118 network dependency map', () => {
  let db; let service;
  beforeEach(() => { db = database(); service = new NetworkDependencyMapService(() => db); });
  afterEach(() => db.close());

  test('correlates declared, metadata, address, DNS and flow evidence without claiming flow causality', () => {
    service.recordAddressObservation(addresses(), admin);
    service.recordDnsObservation({ source: 'dns:export', observedAt: '2026-07-30T10:05:00Z',
      expiresAt: '2026-07-31T10:05:00Z', records: [
        { fqdn: 'api.example.test', type: 'A', address: '10.20.0.20', resourceKey: null },
      ] }, admin);
    addGraph(db); addMetadata(db); addFlows(db);

    const snapshot = service.build({ scopeKey: 'global', freshnessHours: 24, maxEdges: 100,
      includeDenied: false }, admin, { database: db, now });
    const graph = snapshot.edges.find(edge => edge.source === 'vm:db' && edge.target === 'vm:api');
    const metadata = snapshot.edges.find(edge => edge.source === 'vm:api' && edge.target === 'vm:web');
    const flow = snapshot.edges.find(edge => edge.source === 'vm:cache' && edge.target === 'vm:client');
    const api = snapshot.nodes.find(node => node.id === 'vm:api');

    expect(graph).toEqual(expect.objectContaining({ causality: 'declared', impactEligible: true, confidence: 1 }));
    expect(metadata).toEqual(expect.objectContaining({ causality: 'declared', impactEligible: true, confidence: 0.85 }));
    expect(flow).toEqual(expect.objectContaining({ causality: 'unproven', impactEligible: false,
      relationships: ['observed_communication'], flow: expect.objectContaining({ bytes: 2048, destinationPorts: [6379] }) }));
    expect(api.aliases).toEqual(['api.example.test']);
    expect(snapshot.summary).toEqual(expect.objectContaining({ declaredEdges: 2, observedCandidateEdges: 2,
      ambiguousAddressResolutions: 1, causalityInferredFromTemporalProximity: 0 }));
    expect(snapshot).toEqual(expect.objectContaining({ providerMutationsStarted: 0, networkCallsStarted: 0 }));
    expect(snapshot.edges.some(edge => edge.relationships.includes('observed_denial'))).toBe(false);
  });

  test('deduplicates equivalent evidence even when the rebuild minute changes', () => {
    service.recordAddressObservation(addresses({ addresses: addresses().addresses.slice(0, 2) }), admin);
    addGraph(db);
    const body = { scopeKey: 'global', freshnessHours: 24, maxEdges: 100, includeDenied: false };
    const first = service.build(body, admin, { database: db, now });
    const duplicate = service.build(body, admin, { database: db, now: '2026-07-30T12:01:00Z' });
    expect(duplicate).toEqual(expect.objectContaining({ id: first.id, snapshotHash: first.snapshotHash, duplicate: true }));
    expect(db.prepare('SELECT COUNT(*) count FROM network_dependency_snapshots').get().count).toBe(1);
  });

  test('uses only declared edges for bounded cycle-safe impact traversal', () => {
    service.recordAddressObservation(addresses(), admin); addGraph(db); addMetadata(db); addFlows(db);
    const snapshot = service.build({ scopeKey: 'global', freshnessHours: 24, maxEdges: 100,
      includeDenied: false }, admin, { database: db, now });
    const impact = service.impact(snapshot.id, 'vm:db', admin, { database: db, maxDepth: 5 });
    expect(impact.downstream.map(item => [item.resource.id, item.depth])).toEqual([['vm:api', 1], ['vm:web', 2]]);
    expect(impact.upstream).toEqual([]);
    expect(impact).toEqual(expect.objectContaining({ candidatesIncludedInImpact: false, cyclesSuppressed: true,
      providerMutationsStarted: 0, networkCallsStarted: 0 }));

    const candidate = service.impact(snapshot.id, 'vm:client', admin, { database: db, maxDepth: 5 });
    expect(candidate.upstream).toEqual([]); expect(candidate.downstream).toEqual([]);
    expect(candidate.observedCandidates).toEqual([expect.objectContaining({ source: 'vm:cache', target: 'vm:client' })]);
  });

  test('keeps stale declared edges visible and ignores expired DNS observations', () => {
    service.recordDnsObservation({ source: 'dns:expired', observedAt: '2026-07-28T08:00:00Z',
      expiresAt: '2026-07-29T08:00:00Z', records: [
        { fqdn: 'old.example.test', type: 'A', address: '10.20.0.20', resourceKey: 'vm:api' },
      ] }, admin);
    addGraph(db, '2026-07-28T10:00:00Z');
    const snapshot = service.build({ scopeKey: 'global', freshnessHours: 24, maxEdges: 100,
      includeDenied: false }, admin, { database: db, now });
    expect(snapshot.edges).toEqual([expect.objectContaining({ freshness: 'stale', impactEligible: true })]);
    expect(snapshot.nodes.find(node => node.id === 'vm:api').aliases).toEqual([]);
    expect(snapshot.sourceCursor.dnsObservationIds).toEqual([]);
  });

  test('rejects secrets, unsupported scope, oversized batches and non-admin writes', () => {
    expect(() => service.recordAddressObservation({ ...addresses(), password: 'forbidden' }, admin))
      .toThrow(expect.objectContaining({ code: 'SECRET_FIELD' }));
    expect(() => service.recordAddressObservation(addresses({ addresses: Array.from({ length: 5001 }, (_, index) => ({
      address: `10.30.${Math.floor(index / 250) % 20}.${index % 250 + 1}`, resourceKey: `vm:${index}`,
      resourceKind: 'virtualMachine', displayName: `VM ${index}`, source: 'provider',
    })) }), admin)).toThrow(expect.objectContaining({ code: 'INVALID_NETWORK_DEPENDENCY_INPUT' }));
    expect(() => service.build({ scopeKey: 'tenant:blue' }, admin, { database: db, now }))
      .toThrow(expect.objectContaining({ code: 'UNSUPPORTED_DEPENDENCY_SCOPE' }));
    expect(() => service.recordAddressObservation(addresses(), { id: 2, role: 'viewer' }))
      .toThrow(expect.objectContaining({ code: 'ADMIN_REQUIRED' }));
    expect(db.prepare('SELECT COUNT(*) count FROM network_dependency_address_observations').get().count).toBe(0);
  });

  test('migration persists immutable evidence and snapshot safety counters', () => {
    const tables = ['network_dependency_address_observations', 'network_dependency_dns_observations',
      'network_dependency_snapshots'].filter(name => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
    const columns = db.prepare('PRAGMA table_info(network_dependency_snapshots)').all().map(row => row.name);
    expect(tables).toHaveLength(3);
    expect(columns).toEqual(expect.arrayContaining(['nodes_json', 'edges_json', 'source_cursor_json',
      'snapshot_hash', 'provider_mutations_started', 'network_calls_started']));
  });
});
