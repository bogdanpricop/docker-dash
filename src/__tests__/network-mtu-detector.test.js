'use strict';

jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('test must provide its database'); }) }));

const Database = require('better-sqlite3');
const migration = require('../db/migrations/159_network_mtu_assessments');
const { NetworkMtuDetectorService } = require('../services/network-mtu-detector');

const admin = { id: 1, username: 'admin', role: 'admin' };
const now = '2026-07-30T12:00:00Z';

function database() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY,username TEXT);
    CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY,name TEXT);
    INSERT INTO users VALUES (1,'admin');`);
  migration.up(db); return db;
}

function segment(segmentKey, kind, mtu, encapsulationOverheadBytes = 0) {
  return { segmentKey, kind, mtu, encapsulationOverheadBytes, evidenceRef: `evidence:${segmentKey}` };
}

function path(overrides = {}) {
  return { pathKey: 'path:web', purpose: 'workload', sourceKey: 'vm:web', targetKey: 'vm:api',
    requiredPayloadMtu: 1500, requiresDf: false, dfState: 'not_applicable',
    segments: [segment('nic:web', 'interface', 1500), segment('network:prod', 'virtual_network', 1500)],
    ...overrides };
}

function input(paths, overrides = {}) {
  return { source: 'provider:normalized-export', providerHostId: null, observedAt: '2026-07-30T11:00:00Z',
    expiresAt: '2026-07-31T11:00:00Z', coverage: { complete: true, reason: 'all declared segments observed' },
    paths, ...overrides };
}

describe('B120 passive network MTU mismatch detector', () => {
  let db; let service;
  beforeEach(() => { db = database(); service = new NetworkMtuDetectorService(() => db); });
  afterEach(() => db.close());

  test('passes complete plain-path evidence without traffic or mutation', () => {
    const result = service.assess(input([path()]), admin, { database: db, now });
    expect(result).toEqual(expect.objectContaining({ summary: expect.objectContaining({ state: 'pass', paths: 1,
      pass: 1, fail: 0, unknown: 0, bottlenecks: 0 }), providerMutationsStarted: 0,
    networkCallsStarted: 0, activeProbesStarted: 0 }));
    expect(result.paths[0]).toEqual(expect.objectContaining({ state: 'pass', calculatedWireMtu: 1500,
      maxDeficitBytes: 0 }));
  });

  test('detects VXLAN and nested-overlay underlay deficits using cumulative overhead', () => {
    const vxlan = path({ pathKey: 'path:vxlan', purpose: 'overlay', requiresDf: true, dfState: 'preserved',
      segments: [segment('overlay:prod', 'overlay', 1500), segment('underlay:a', 'underlay', 1500, 50)] });
    const nested = path({ pathKey: 'path:nested', purpose: 'overlay', requiredPayloadMtu: 1400,
      segments: [segment('guest:nic', 'interface', 1400), segment('geneve:tenant', 'tunnel', 1500, 58),
        segment('vxlan:fabric', 'underlay', 1500, 50)] });
    const result = service.assess(input([vxlan, nested]), admin, { database: db, now });
    expect(result.summary).toEqual(expect.objectContaining({ state: 'fail', fail: 2, bottlenecks: 2,
      maxDeficitBytes: 50 }));
    expect(result.paths.find(item => item.pathKey === 'path:vxlan').segments[1])
      .toEqual(expect.objectContaining({ requiredMtu: 1550, deficitBytes: 50, state: 'fail' }));
    expect(result.paths.find(item => item.pathKey === 'path:nested').segments[2])
      .toEqual(expect.objectContaining({ requiredMtu: 1508, deficitBytes: 8, state: 'fail' }));
  });

  test('evaluates storage and live-migration paths independently', () => {
    const storage = path({ pathKey: 'path:storage', purpose: 'storage', sourceKey: 'host:a', targetKey: 'array:a',
      requiredPayloadMtu: 9000, segments: [segment('storage:nic', 'storage', 9000), segment('switch:storage', 'switch', 1500)] });
    const migration = path({ pathKey: 'path:migration', purpose: 'live_migration', sourceKey: 'host:a', targetKey: 'host:b',
      requiredPayloadMtu: 1500, requiresDf: true, dfState: 'preserved',
      segments: [segment('migration:a', 'migration', 9000), segment('migration:switch', 'switch', 9000)] });
    const result = service.assess(input([storage, migration]), admin, { database: db, now });
    expect(result.summary.purposes).toEqual({ workload: 0, overlay: 0, storage: 1, live_migration: 1 });
    expect(result.paths.map(item => [item.pathKey, item.state])).toEqual([
      ['path:storage', 'fail'], ['path:migration', 'pass'],
    ]);
    expect(result.findings).toContainEqual(expect.objectContaining({ pathKey: 'path:storage',
      code: 'MTU_BOTTLENECK', segmentKey: 'switch:storage' }));
  });

  test('fails closed for missing, incomplete, expired and required-DF evidence', () => {
    const missing = path({ pathKey: 'path:missing', requiresDf: true, dfState: 'unknown',
      segments: [segment('network:unknown', 'virtual_network', null)] });
    const unknown = service.assess(input([missing], { coverage: { complete: false, reason: 'one switch unavailable' },
      expiresAt: '2026-07-30T11:30:00Z' }), admin, { database: db, now });
    expect(unknown.summary.state).toBe('unknown');
    expect(unknown.findings.map(item => item.code)).toEqual(expect.arrayContaining([
      'MTU_UNKNOWN', 'EVIDENCE_INCOMPLETE', 'EVIDENCE_EXPIRED', 'DF_POLICY_UNKNOWN',
    ]));

    const cleared = service.assess(input([path({ pathKey: 'path:df', requiresDf: true, dfState: 'cleared' })]),
      admin, { database: db, now });
    expect(cleared.paths[0]).toEqual(expect.objectContaining({ state: 'fail', findings: [
      expect.objectContaining({ code: 'DF_REQUIRED_BUT_NOT_PRESERVED', state: 'fail' }),
    ] }));
  });

  test('deduplicates stable assessments and rejects secret, duplicate and oversized input', () => {
    const body = input([path()]); const first = service.assess(body, admin, { database: db, now });
    expect(service.assess(body, admin, { database: db, now: '2026-07-30T12:01:00Z' }))
      .toEqual(expect.objectContaining({ id: first.id, assessmentHash: first.assessmentHash, duplicate: true }));
    expect(() => service.assess({ ...body, accessToken: 'forbidden' }, admin, { database: db, now }))
      .toThrow(expect.objectContaining({ code: 'SECRET_FIELD' }));
    expect(() => service.assess(input([path(), path()]), admin, { database: db, now })).toThrow(/duplicate keys/);
    expect(() => service.assess(input(Array.from({ length: 201 }, (_, index) => path({ pathKey: `path:${index}` }))),
      admin, { database: db, now })).toThrow(expect.objectContaining({ code: 'INVALID_NETWORK_MTU_INPUT' }));
    expect(() => service.assess(body, { id: 2, role: 'viewer' }, { database: db, now }))
      .toThrow(expect.objectContaining({ code: 'ADMIN_REQUIRED' }));
    expect(db.prepare('SELECT COUNT(*) count FROM network_mtu_assessments').get().count).toBe(1);
  });

  test('migration stores immutable results and zero-action safety counters', () => {
    const columns = db.prepare('PRAGMA table_info(network_mtu_assessments)').all().map(row => row.name);
    expect(columns).toEqual(expect.arrayContaining(['paths_json', 'findings_json', 'assessment_hash',
      'provider_mutations_started', 'network_calls_started']));
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='network_mtu_assessments'").get().sql)
      .toContain('CHECK(provider_mutations_started=0)');
  });
});
