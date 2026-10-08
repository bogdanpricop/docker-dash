'use strict';

jest.mock('../config', () => ({ security: { encryptionKey: 'provider-resource-schema-test-key' } }));
jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('test must provide its database'); }) }));

const Database = require('better-sqlite3');
const migration = require('../db/migrations/106_provider_resource_identities');
const { normalizeResource, validateResource, _internals } = require('../services/provider-sdk/resource-schema');

describe('Provider common resource schema', () => {
  let db;
  const host = { id: 7, name: 'provider-a', daemon_type: 'xen' };
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY, name TEXT);
      INSERT INTO docker_hosts (id, name) VALUES (7, 'provider-a')`);
    migration.up(db);
  });
  afterEach(() => db.close());

  const fixtures = {
    virtualMachine: { ref: 'OpaqueRef:vm1', uuid: 'vm-1', name: 'app', powerState: 'Running', cpus: 4, memoryBytes: 8192, hostRef: 'OpaqueRef:h1', tags: ['prod'], allowedActions: ['shutdown', 'reboot'] },
    host: { moref: 'host-22', hostUuid: 'host-1', name: 'esx-a', connectionState: 'connected', cpuCores: 16, memoryBytes: 4096, model: 'safe-model' },
    cluster: { ref: 'OpaqueRef:p1', uuid: 'pool-1', name: 'pool-a', haEnabled: true, masterRef: 'OpaqueRef:h1' },
    storage: { moref: 'datastore-7', uuid: 'storage-1', name: 'fast', type: 'VMFS', capacityBytes: 1000, freeSpaceBytes: 400, url: 'ds:///vmfs/secret' },
    network: { ref: 'OpaqueRef:n1', uuid: 'net-1', name: 'prod-net', bridge: 'xenbr0', mtu: 1500, managed: true },
    task: { ref: 'OpaqueRef:t1', uuid: 'task-1', name: 'copy', status: 'success', progress: 1, startedAt: '2026-01-01T00:00:00Z', result: { status: 'ok', token: 'must-not-leak' }, error: 'https://admin:secret@example.test failed' },
  };

  it.each(Object.entries(fixtures))('normalizes %s without exposing provider references', (kind, raw) => {
    const item = normalizeResource({ host, providerType: 'xen', kind, raw, database: db, observedAt: '2026-07-26T12:00:00.000Z' });
    expect(validateResource(item)).toBe(true);
    expect(item.id).toMatch(/^ddr_/);
    const json = JSON.stringify(item);
    expect(json).not.toContain('OpaqueRef:');
    expect(json).not.toContain('datastore-7');
    expect(json).not.toContain('admin:secret');
    expect(json).not.toContain('must-not-leak');
  });

  it('bounds labels, actions and unsafe task details', () => {
    const raw = {
      id: 'task-2', name: 'bounded', status: 'failed',
      labels: { safe: 'x'.repeat(500), '__proto__': 'skip', 'bad key': 'skip' },
      allowedActions: ['cancel', 'cancel', 'INVALID ACTION'],
      error: `token=should-not-survive\n${'x'.repeat(500)}`,
    };
    const item = normalizeResource({ host, providerType: 'xen', kind: 'task', raw, database: db });
    expect(item.labels.safe).toHaveLength(240);
    expect(item.actions).toEqual(['cancel']);
    expect(item.status.error.length).toBeLessThanOrEqual(240);
    expect(item.status.error).not.toContain('\n');
    expect(item.status.error).not.toContain('should-not-survive');
  });

  it('normalizes state, timestamp and numeric edge cases', () => {
    expect(_internals._powerState('poweredOn')).toBe('running');
    expect(_internals._taskState('completed')).toBe('succeeded');
    expect(_internals._timestamp('not-a-time')).toBeNull();
    expect(_internals._number('NaN')).toBeNull();
  });

  it('normalizes provider host availability, maintenance and derived free memory', () => {
    const item = normalizeResource({
      host, providerType: 'xen', kind: 'host', database: db,
      raw: {
        ref: 'OpaqueRef:host-capacity', name: 'xen-a', status: 'online', enabled: true,
        maxcpu: 32, maxmem: 128 * 1024, mem: 48 * 1024, maintenanceMode: false,
      },
    });
    expect(item.status).toEqual(expect.objectContaining({
      powerState: 'running', enabled: true, maintenanceMode: 'normal', memoryFreeBytes: 80 * 1024,
    }));
    expect(item.spec).toEqual(expect.objectContaining({ cpuCount: 32, memoryBytes: 128 * 1024 }));
  });

  it('canonicalizes native VM-to-host relationships without exposing provider references', () => {
    const vm = normalizeResource({ host, providerType: 'xen', kind: 'virtualMachine', database: db,
      raw: { ref: 'OpaqueRef:vm-canonical', uuid: 'vm-canonical', name: 'app', hostRef: 'OpaqueRef:host-canonical' } });
    expect(vm.relationships.host).toMatch(/^ddr_host_[a-f0-9]{26}$/);
    const hostResource = normalizeResource({ host, providerType: 'xen', kind: 'host', database: db,
      raw: { ref: 'OpaqueRef:host-canonical', uuid: 'host-canonical', name: 'xen-a' } });
    expect(hostResource.id).toBe(vm.relationships.host);
    expect(JSON.stringify(vm)).not.toContain('OpaqueRef:host-canonical');
  });
});
