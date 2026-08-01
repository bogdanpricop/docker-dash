'use strict';

jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('test must provide its database'); }) }));
jest.mock('../services/provider-sdk/registry', () => ({
  capabilitiesForHost: jest.fn(), resourcesForHost: jest.fn(),
  nativeNetworkEvidenceForHost: jest.fn(),
}));
jest.mock('../services/provider-sdk/ip-address-inventory', () => ({ inventoryForHost: jest.fn() }));

const Database = require('better-sqlite3');
const registry = require('../services/provider-sdk/registry');
const ipInventory = require('../services/provider-sdk/ip-address-inventory');
const capture = require('../services/provider-sdk/network-evidence-capture');

const admin = { id: 1, username: 'admin', role: 'admin' };
const host = { id: 7, name: 'esx-a', daemon_type: 'vsphere' };
const now = '2026-08-01T10:00:00.000Z';

function database() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY,username TEXT);
    CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY,name TEXT);
    INSERT INTO users VALUES (1,'admin');
    INSERT INTO docker_hosts VALUES (7,'esx-a');`);
  require('../db/migrations/158_network_dependency_map').up(db);
  require('../db/migrations/159_network_mtu_assessments').up(db);
  require('../db/migrations/160_network_bond_health').up(db);
  return db;
}

function bond() {
  const member = (name, role) => ({ memberKey: `vsphere:host-7:${name}`,
    adminState: 'up', linkState: 'up', role, speedMbps: 10000, duplex: 'full',
    lacpPartnerKey: null, rxBytesDelta: 0, txBytesDelta: 0, errorDelta: 0,
    dropDelta: 0, flapCount: 0 });
  return { bondKey: 'vsphere:host-7:vSwitch0', hostKey: 'vsphere:host-7',
    mode: 'active_backup', minActiveMembers: 1, intervalSeconds: 300,
    imbalanceThresholdPercent: 40, failover: { count: 0, lastAt: null, lastReason: null },
    members: [member('vmnic0', 'active'), member('vmnic1', 'standby')] };
}

describe('B118/B120/B121 provider-native network evidence capture', () => {
  let db;
  beforeEach(() => {
    db = database(); jest.clearAllMocks();
    registry.capabilitiesForHost.mockResolvedValue({ probe: { status: 'reachable' },
      provider: { type: 'vsphere' } });
    ipInventory.inventoryForHost.mockResolvedValue({ observedAt: now,
      coverage: { complete: true }, addresses: [{ address: '192.0.2.10', source: 'vmware-tools',
        vm: { id: `ddr_vm_${'a'.repeat(26)}`, displayName: 'web' } }] });
    registry.resourcesForHost.mockResolvedValue({ provider: { type: 'vsphere' }, observedAt: now,
      count: 1, totalObserved: 1, truncated: false, items: [{
        id: `ddr_network_${'b'.repeat(26)}`, displayName: 'Servers', spec: { mtu: 1500 },
      }] });
    registry.nativeNetworkEvidenceForHost.mockResolvedValue({ supported: true, observedAt: now,
      coverage: { complete: true, reason: 'all hosts read' },
      switches: [{ switchKey: 'vsphere:host-7:vSwitch0', hostKey: 'vsphere:host-7',
        name: 'vSwitch0', mtu: 1500 }], bonds: [bond()], limitations: [] });
  });
  afterEach(() => db.close());

  test('persists bounded provider evidence without a probe, guest command or mutation', async () => {
    const result = await capture.captureForHost(host, admin, { database: db, now });
    expect(result.features).toEqual(expect.arrayContaining([
      expect.objectContaining({ featureId: 'B118', state: 'captured', observedItems: 1 }),
      expect.objectContaining({ featureId: 'B120', state: 'captured', observedItems: 2,
        assessmentState: 'unknown' }),
      expect.objectContaining({ featureId: 'B121', state: 'captured', observedItems: 1,
        assessmentState: 'unknown' }),
    ]));
    expect(result.summary).toEqual(expect.objectContaining({ captured: 3,
      providerReadsStarted: 3, providerMutationsStarted: 0, activeProbesStarted: 0,
      guestCommandsStarted: 0 }));
    expect(db.prepare('SELECT COUNT(*) count FROM network_dependency_address_observations').get().count).toBe(1);
    expect(db.prepare('SELECT COUNT(*) count FROM network_dependency_snapshots').get().count).toBe(1);
    expect(db.prepare('SELECT COUNT(*) count FROM network_mtu_assessments').get().count).toBe(1);
    expect(db.prepare('SELECT COUNT(*) count FROM network_bond_health_observations').get().count).toBe(1);
  });

  test('keeps missing addresses and bonds explicitly not observed', async () => {
    ipInventory.inventoryForHost.mockResolvedValue({ observedAt: now,
      coverage: { complete: false }, addresses: [] });
    registry.nativeNetworkEvidenceForHost.mockResolvedValue({ supported: true, observedAt: now,
      coverage: { complete: true, reason: 'all hosts read' }, switches: [], bonds: [], limitations: [] });
    registry.resourcesForHost.mockResolvedValue({ count: 0, totalObserved: 0, truncated: false, items: [] });
    const result = await capture.captureForHost(host, admin, { database: db, now });
    expect(result.features).toEqual([
      expect.objectContaining({ featureId: 'B118', state: 'not_observed' }),
      expect.objectContaining({ featureId: 'B120', state: 'not_observed' }),
      expect.objectContaining({ featureId: 'B121', state: 'not_observed' }),
    ]);
    expect(result.summary).toEqual(expect.objectContaining({ captured: 0, notObserved: 3,
      providerMutationsStarted: 0 }));
  });

  test('fails closed when the provider probe is unreachable or the actor is not admin', async () => {
    await expect(capture.captureForHost(host, { id: 2, role: 'viewer' }, { database: db, now }))
      .rejects.toMatchObject({ code: 'ADMIN_REQUIRED', status: 403 });
    registry.capabilitiesForHost.mockResolvedValue({ probe: { status: 'unreachable' },
      provider: { type: 'vsphere' } });
    await expect(capture.captureForHost(host, admin, { database: db, now }))
      .rejects.toMatchObject({ code: 'PROVIDER_UNREACHABLE', status: 502 });
    expect(db.prepare('SELECT COUNT(*) count FROM network_mtu_assessments').get().count).toBe(0);
  });

  test('builds only safe, deduplicated normalized addresses and segment-only paths', () => {
    const addresses = capture._internals._dedupeAddresses([
      { address: '192.0.2.10', source: 'vmware-tools', vm: { id: `ddr_vm_${'a'.repeat(26)}`, displayName: 'a' } },
      { address: '192.0.2.10', source: 'vmware-tools', vm: { id: `ddr_vm_${'a'.repeat(26)}`, displayName: 'a' } },
      { address: '192.0.2.20', source: 'provider', vm: { id: '<unsafe>', displayName: 'bad' } },
    ]);
    expect(addresses).toHaveLength(1);
    const paths = capture._internals._networkPaths(host, {
      items: [{ id: `ddr_network_${'b'.repeat(26)}`, spec: { mtu: 9000 } }],
    }, { switches: [] });
    expect(paths).toEqual([expect.objectContaining({ requiredPayloadMtu: 1500,
      requiresDf: false, segments: [expect.objectContaining({ kind: 'virtual_network', mtu: 9000 })] })]);
    expect(capture._internals._networkPaths(host, {
      items: [{ id: `ddr_network_${'c'.repeat(26)}`, spec: { mtu: 0 } }],
    }, { switches: [] })[0].segments[0].mtu).toBeNull();
  });

  test('isolates invalid provider bond evidence and preserves the other two captures', async () => {
    registry.nativeNetworkEvidenceForHost.mockResolvedValue({ supported: true, observedAt: now,
      coverage: { complete: false, reason: 'bounded' }, switches: [], bonds: [{ ...bond(), mode: 'invalid' }],
      limitations: [] });
    const result = await capture.captureForHost(host, admin, { database: db, now });
    expect(result.features).toEqual([
      expect.objectContaining({ featureId: 'B118', state: 'captured' }),
      expect.objectContaining({ featureId: 'B120', state: 'captured' }),
      expect.objectContaining({ featureId: 'B121', state: 'unavailable',
        error: { code: 'INVALID_NETWORK_BOND_INPUT', message: 'Provider evidence source is unavailable' } }),
    ]);
    expect(db.prepare('SELECT COUNT(*) count FROM network_bond_health_observations').get().count).toBe(0);
  });
});
