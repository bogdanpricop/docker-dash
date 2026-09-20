'use strict';

jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('test must provide its database'); }) }));

const Database = require('better-sqlite3');
const migration = require('../db/migrations/160_network_bond_health');
const { NetworkBondHealthService } = require('../services/network-bond-health');

const admin = { id: 1, username: 'admin', role: 'admin' };
const now = '2026-07-30T12:00:00Z';

function database() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY,username TEXT);
    CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY,name TEXT);
    INSERT INTO users VALUES (1,'admin');`);
  migration.up(db); return db;
}

function member(memberKey, overrides = {}) {
  return { memberKey, adminState: 'up', linkState: 'up', role: 'active', speedMbps: 10000,
    duplex: 'full', lacpPartnerKey: null, rxBytesDelta: 1000, txBytesDelta: 1000,
    errorDelta: 0, dropDelta: 0, flapCount: 0, ...overrides };
}

function bond(overrides = {}) {
  return { bondKey: 'bond:management', hostKey: 'host:a', mode: 'active_backup', minActiveMembers: 1,
    intervalSeconds: 300, imbalanceThresholdPercent: 40,
    failover: { count: 0, lastAt: null, lastReason: null },
    members: [member('nic:a'), member('nic:b', { role: 'standby', rxBytesDelta: 0, txBytesDelta: 0 })],
    ...overrides };
}

function input(bonds, overrides = {}) {
  return { source: 'provider:bond-export', providerHostId: null, observedAt: '2026-07-30T11:58:00Z',
    expiresAt: '2026-07-30T12:58:00Z', coverage: { complete: true, reason: 'all configured members observed' },
    bonds, ...overrides };
}

describe('B121 passive Bond/LAG health observations', () => {
  let db; let service;
  beforeEach(() => { db = database(); service = new NetworkBondHealthService(() => db); });
  afterEach(() => db.close());

  test('passes healthy active-backup evidence without inferring standby as active', () => {
    const result = service.record(input([bond()]), admin, { database: db, now });
    expect(result).toEqual(expect.objectContaining({ summary: expect.objectContaining({ state: 'pass', bonds: 1,
      pass: 1, members: 2, activeMembers: 1 }), providerMutationsStarted: 0, networkCallsStarted: 0,
    activeFailoversStarted: 0 }));
    expect(result.bonds[0]).toEqual(expect.objectContaining({ state: 'pass', activeMembers: 1,
      imbalance: expect.objectContaining({ state: 'not_applicable' }) }));
  });

  test('passes consistent LACP and reports zero-traffic balance as not observed', () => {
    const lacp = bond({ bondKey: 'bond:storage', mode: 'lacp', minActiveMembers: 2,
      members: [member('nic:a', { role: 'collecting_distributing', lacpPartnerKey: 'partner:1',
        rxBytesDelta: 0, txBytesDelta: 0 }), member('nic:b', { role: 'collecting_distributing',
        lacpPartnerKey: 'partner:1', rxBytesDelta: 0, txBytesDelta: 0 })] });
    const result = service.record(input([lacp]), admin, { database: db, now });
    expect(result.bonds[0]).toEqual(expect.objectContaining({ state: 'pass', activeMembers: 2,
      lacpPartner: { state: 'consistent', keys: ['partner:1'] },
      imbalance: expect.objectContaining({ state: 'not_observed', totalBytes: 0 }) }));
    expect(result.findings.some(finding => finding.code === 'TRAFFIC_IMBALANCE')).toBe(false);
  });

  test('warns on imbalance, speed/duplex, errors, flaps and recent failover', () => {
    const lag = bond({ bondKey: 'bond:workload', mode: 'static_lag', minActiveMembers: 2,
      failover: { count: 2, lastAt: '2026-07-30T11:57:00Z', lastReason: 'upstream maintenance' },
      members: [member('nic:a', { rxBytesDelta: 9000, txBytesDelta: 1000 }), member('nic:b', {
        speedMbps: 1000, duplex: 'half', rxBytesDelta: 0, txBytesDelta: 100,
        errorDelta: 2, dropDelta: 3, flapCount: 1 })] });
    const result = service.record(input([lag]), admin, { database: db, now });
    expect(result.summary).toEqual(expect.objectContaining({ state: 'warning', warning: 1, imbalanced: 1,
      recentFailovers: 1 }));
    expect(result.bonds[0].imbalance).toEqual(expect.objectContaining({ state: 'warning', spreadPercent: 98.02 }));
    expect(result.findings.map(finding => finding.code)).toEqual(expect.arrayContaining([
      'ACTIVE_MEMBER_SPEED_MISMATCH', 'HALF_DUPLEX_MEMBER', 'MEMBER_ERROR_DELTA', 'LINK_FLAPS',
      'TRAFFIC_IMBALANCE', 'RECENT_FAILOVER',
    ]));
  });

  test('fails active-member quorum and inconsistent LACP partners', () => {
    const quorum = bond({ bondKey: 'bond:quorum', minActiveMembers: 2 });
    const lacp = bond({ bondKey: 'bond:lacp', mode: 'lacp', minActiveMembers: 2,
      members: [member('nic:c', { role: 'collecting_distributing', lacpPartnerKey: 'partner:a' }),
        member('nic:d', { role: 'collecting_distributing', lacpPartnerKey: 'partner:b' })] });
    const result = service.record(input([quorum, lacp]), admin, { database: db, now });
    expect(result.summary).toEqual(expect.objectContaining({ state: 'fail', fail: 2, lacpPartnerMismatch: 1 }));
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ bondKey: 'bond:quorum', code: 'ACTIVE_MEMBER_QUORUM_FAIL', state: 'fail' }),
      expect.objectContaining({ bondKey: 'bond:lacp', code: 'LACP_PARTNER_MISMATCH', state: 'fail' }),
    ]));
  });

  test('fails closed on incomplete, expired and unknown member evidence', () => {
    const unknownBond = bond({ members: [member('nic:a', { linkState: 'unknown', role: 'unknown' })] });
    const result = service.record(input([unknownBond], { expiresAt: '2026-07-30T11:59:00Z',
      coverage: { complete: false, reason: 'one physical interface could not be read' } }), admin, { database: db, now });
    expect(result.summary.state).toBe('fail');
    expect(result.findings.map(finding => finding.code)).toEqual(expect.arrayContaining([
      'MEMBER_STATE_UNKNOWN', 'ACTIVE_MEMBER_QUORUM_FAIL', 'EVIDENCE_INCOMPLETE', 'EVIDENCE_EXPIRED',
    ]));
  });

  test('deduplicates strict evidence and rejects secrets, duplicate keys, limits and non-admin writes', () => {
    const body = input([bond()]); const first = service.record(body, admin, { database: db, now });
    expect(service.record(body, admin, { database: db, now: '2026-07-30T12:01:00Z' }))
      .toEqual(expect.objectContaining({ id: first.id, observationHash: first.observationHash, duplicate: true }));
    expect(() => service.record({ ...body, password: 'forbidden' }, admin, { database: db, now }))
      .toThrow(expect.objectContaining({ code: 'SECRET_FIELD' }));
    expect(() => service.record(input([bond(), bond()]), admin, { database: db, now })).toThrow(/duplicate keys/);
    expect(() => service.record(input(Array.from({ length: 501 }, (_, index) => bond({ bondKey: `bond:${index}` }))),
      admin, { database: db, now })).toThrow(expect.objectContaining({ code: 'INVALID_NETWORK_BOND_INPUT' }));
    expect(() => service.record(body, { id: 2, role: 'viewer' }, { database: db, now }))
      .toThrow(expect.objectContaining({ code: 'ADMIN_REQUIRED' }));
    expect(db.prepare('SELECT COUNT(*) count FROM network_bond_health_observations').get().count).toBe(1);
  });

  test('migration stores immutable normalized evidence and zero-action counters', () => {
    const columns = db.prepare('PRAGMA table_info(network_bond_health_observations)').all().map(row => row.name);
    expect(columns).toEqual(expect.arrayContaining(['bonds_json', 'findings_json', 'observation_hash',
      'provider_mutations_started', 'network_calls_started']));
  });
});
