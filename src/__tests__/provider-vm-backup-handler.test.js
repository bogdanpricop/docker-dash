'use strict';

jest.mock('../config', () => ({
  app: { env: 'test' }, security: { encryptionKey: 'vm-backup-handler-key-32-characters' },
  features: { providerRecoveryPointInventory: true },
}));
jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('inject database'); }) }));
jest.mock('../services/provider-sdk/registry', () => ({ recoveryPointsForHost: jest.fn() }));

const Database = require('better-sqlite3');
const identityMigration = require('../db/migrations/106_provider_resource_identities');
const recoveryMigration = require('../db/migrations/117_provider_recovery_points');
const identityStore = require('../services/provider-sdk/identity-store');
const catalog = require('../services/provider-sdk/recovery-point-catalog');
const registry = require('../services/provider-sdk/registry');
const handler = require('../services/provider-operations/handlers/vm-backup');

describe('durable Proxmox VM backup handler', () => {
  let db; let vmId; let repositoryId; let context; let client;
  beforeEach(() => {
    jest.clearAllMocks(); db = new Database(':memory:'); db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY,name TEXT,daemon_type TEXT,is_active INTEGER,daemon_config TEXT);
      INSERT INTO docker_hosts VALUES (7,'pve','proxmox',1,'{}');`);
    identityMigration.up(db); recoveryMigration.up(db);
    vmId = identityStore.remember({ hostId: 7, providerType: 'proxmox', kind: 'virtualMachine',
      uuid: 'vm-101', nativeRef: 'qemu/101', stability: 'stable' }, db).id;
    repositoryId = catalog.normalizeRepositoryAndRemember({ host: { id: 7 }, providerType: 'proxmox', database: db,
      raw: { nativeRef: 'pbs-prod', name: 'PBS', type: 'pbs', enabled: true, accessible: true } }).repository.id;
    context = { operation: { provider: { type: 'proxmox', endpointId: 7 }, resource: { id: vmId },
      createdAt: new Date().toISOString(), startedAt: new Date().toISOString() },
    request: { executionId: `pbex_${'a'.repeat(26)}`, policyId: `pbp_${'b'.repeat(26)}`,
      repositoryId, planHash: 'c'.repeat(64), baselinePointIds: [], consistency: 'crash', bandwidthLimitMbps: 8 },
    reportProgress: jest.fn(), nativeTaskRef: null };
    client = { listVMs: jest.fn(async () => [{ vmid: 101, type: 'qemu', node: 'pve-a', status: 'running' }]),
      listRecoveryPoints: jest.fn(async () => ({ repositories: [{ nativeRef: 'pbs-prod', enabled: true, accessible: true }] })),
      startVmBackup: jest.fn(async () => ({ taskRef: 'UPID:pve-a:backup', node: 'pve-a' })),
      getTaskStatus: jest.fn(async () => ({ status: 'stopped', exitstatus: 'OK' })),
      stopTask: jest.fn(async () => ({ ok: true })), _agent: { destroy: jest.fn() } };
  });
  afterEach(() => db.close());

  it('revalidates live VM/repository evidence, submits vzdump and proves a new recovery point', async () => {
    const submitted = await handler.execute(context, { database: db, clientFactory: () => client });
    expect(client.startVmBackup).toHaveBeenCalledWith('pve-a', 101, 'qemu', {
      storage: 'pbs-prod', mode: 'snapshot', compress: 'zstd', bwlimitKiB: 1000,
    });
    context.nativeTaskRef = submitted.nativeTaskRef;
    registry.recoveryPointsForHost.mockResolvedValue({ truncated: false, items: [{
      id: `ddr_rp_${'d'.repeat(26)}`, repository: { id: repositoryId }, workload: { id: vmId },
      createdAt: new Date().toISOString(), verification: { state: 'verified' },
    }] });
    await expect(handler.reconcile(context, { database: db, clientFactory: () => client })).resolves.toEqual(
      expect.objectContaining({ state: 'succeeded', result: expect.objectContaining({
        verificationState: 'verified', retentionMutationAuthorized: false,
      }) })
    );
  });

  it('fails closed for unsupported consistency and node-local repository mismatch', async () => {
    context.request.consistency = 'application';
    await expect(handler.execute(context, { database: db, clientFactory: () => client }))
      .rejects.toMatchObject({ code: 'BACKUP_CONSISTENCY_UNSUPPORTED' });
    expect(() => handler._internals._storageForNode('local@pve-b', 'pve-a'))
      .toThrow(expect.objectContaining({ code: 'BACKUP_REPOSITORY_NODE_MISMATCH' }));
    expect(client.startVmBackup).not.toHaveBeenCalled();
  });
});
