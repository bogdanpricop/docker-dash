'use strict';

process.env.ENCRYPTION_KEY = 'provider-migration-registry-test-key';

const Database = require('better-sqlite3');
const identityMigration = require('../db/migrations/106_provider_resource_identities');
const snapshotMigration = require('../db/migrations/109_provider_resource_snapshots');
const registry = require('../services/provider-sdk/registry');
const { supported, conditional } = require('../services/provider-sdk/adapters/helpers');

const host = { id: 92, name: 'migration-fixture', daemon_type: 'testmigration' };
const migrationCompatibility = jest.fn();

registry.register({
  type: 'testmigration',
  declared: () => ({
    'inventory.vm': supported(), 'inventory.host': supported(), 'vm.read': supported(),
    'vm.migration.preflight': conditional('fixture', { readOnly: true }),
    'vm.migration.live': conditional('fixture'), 'vm.migration.cold': conditional('fixture'),
    'vm.migration.storage': conditional('fixture'),
  }),
  probe: async () => ({ provider: { type: 'testmigration', product: 'Fixture' } }),
  listResources: async kind => kind === 'virtualMachine'
    ? [{ uuid: 'vm-fixture', ref: 'native-vm-secret', name: 'fixture-vm', powerState: 'running' }]
    : [{ uuid: 'host-fixture', ref: 'native-host-secret', name: 'fixture-host', status: 'online' }],
  migrationCompatibility,
});

describe('provider registry migration compatibility read', () => {
  let database;
  beforeEach(() => {
    registry._internals.clear();
    migrationCompatibility.mockReset();
    database = new Database(':memory:');
    database.exec(`CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY, name TEXT);
      INSERT INTO docker_hosts (id, name) VALUES (92, 'migration-fixture')`);
    identityMigration.up(database);
    snapshotMigration.up(database);
  });
  afterEach(() => database.close());

  it('resolves native identities only inside the adapter boundary', async () => {
    const vms = await registry.resourcesForHost(host, 'virtual-machines', { database });
    const targets = await registry.resourcesForHost(host, 'hosts', { database });
    migrationCompatibility.mockImplementation(async (_host, context) => ({
      sourceTargetId: null,
      candidates: [{ targetId: context.targets[0].resource.id, checks: [], blockers: [], warnings: [],
        modes: { live: 'conditional', cold: 'conditional', storage: 'unknown' } }],
    }));
    const result = await registry.migrationCompatibilityForHost(host, vms.items[0], targets.items, { database });
    expect(migrationCompatibility).toHaveBeenCalledWith(host, expect.objectContaining({
      identity: expect.objectContaining({ nativeRef: 'native-vm-secret' }),
      targets: [expect.objectContaining({ identity: expect.objectContaining({ nativeRef: 'native-host-secret' }) })],
    }));
    expect(JSON.stringify(result)).not.toMatch(/native-vm-secret|native-host-secret/);
  });

  it('rejects candidate IDs outside the canonical target scope', async () => {
    const vms = await registry.resourcesForHost(host, 'virtual-machines', { database });
    const targets = await registry.resourcesForHost(host, 'hosts', { database });
    migrationCompatibility.mockResolvedValue({ candidates: [{ targetId: `ddr_host_${'f'.repeat(26)}` }] });
    await expect(registry.migrationCompatibilityForHost(host, vms.items[0], targets.items, { database }))
      .rejects.toEqual(expect.objectContaining({ code: 'INVALID_PROVIDER_MIGRATION_RESPONSE', status: 502 }));
  });
});
