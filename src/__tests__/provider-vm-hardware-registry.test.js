'use strict';

process.env.ENCRYPTION_KEY = 'provider-hardware-registry-test-key';

const Database = require('better-sqlite3');
const identityMigration = require('../db/migrations/106_provider_resource_identities');
const snapshotMigration = require('../db/migrations/109_provider_resource_snapshots');
const registry = require('../services/provider-sdk/registry');
const { supported, conditional } = require('../services/provider-sdk/adapters/helpers');

const host = { id: 91, name: 'hardware-fixture', daemon_type: 'testhw' };
const readVmHardware = jest.fn();

registry.register({
  type: 'testhw',
  declared: () => ({
    'inventory.vm': supported(), 'vm.read': supported(),
    'vm.disk.read': conditional('fixture', { readOnly: true }),
    'vm.nic.read': conditional('fixture', { readOnly: true }),
  }),
  probe: async () => ({ provider: { type: 'testhw', product: 'Fixture' } }),
  listResources: async kind => kind === 'virtualMachine'
    ? [{ uuid: 'vm-fixture-uuid', ref: 'provider-secret-ref', name: 'fixture', powerState: 'running' }] : [],
  readVmHardware,
});

describe('provider registry VM hardware read', () => {
  let database;
  beforeEach(() => {
    readVmHardware.mockReset().mockResolvedValue({
      disks: [{ nativeRef: 'native-disk-secret', label: 'root', capacityBytes: 4096 }],
      nics: [{ nativeRef: 'native-vif-secret', macAddress: '00:11:22:33:44:55' }],
    });
    registry._internals.clear();
    database = new Database(':memory:');
    database.exec(`CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY, name TEXT);
      INSERT INTO docker_hosts (id, name) VALUES (91, 'hardware-fixture')`);
    identityMigration.up(database);
    snapshotMigration.up(database);
  });

  afterEach(() => database.close());

  it('resolves encrypted native identity server-side and returns only opaque device IDs', async () => {
    const inventory = await registry.resourcesForHost(host, 'virtual-machines', { database });
    const result = await registry.vmHardwareForHost(host, inventory.items[0], { database });
    expect(readVmHardware).toHaveBeenCalledWith(host, expect.objectContaining({
      identity: expect.objectContaining({ nativeRef: 'provider-secret-ref' }),
      resource: expect.objectContaining({ id: inventory.items[0].id }),
    }));
    expect(result.disks[0].id).toMatch(/^ddh_disk_/);
    expect(result.nics[0].id).toMatch(/^ddh_nic_/);
    expect(JSON.stringify(result)).not.toMatch(/provider-secret-ref|native-disk-secret|native-vif-secret/);
  });
});
