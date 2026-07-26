'use strict';

jest.mock('../config', () => ({
  app: { env: 'test' }, security: { encryptionKey: 'restore-handler-key-32-characters' },
  features: { providerRecoveryPointInventory: true },
}));
jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('inject database'); }) }));
jest.mock('../services/provider-sdk/registry', () => ({ resourcesForHost: jest.fn() }));

const Database = require('better-sqlite3');
const identityMigration = require('../db/migrations/106_provider_resource_identities');
const recoveryMigration = require('../db/migrations/117_provider_recovery_points');
const identityStore = require('../services/provider-sdk/identity-store');
const recoveryCatalog = require('../services/provider-sdk/recovery-point-catalog');
const registry = require('../services/provider-sdk/registry');
const handler = require('../services/provider-operations/handlers/vm-restore');

describe('durable Proxmox VM restore handler', () => {
  let db; let repository; let point; let nodeId; let storageId; let context; let client;
  beforeEach(() => {
    jest.clearAllMocks(); db = new Database(':memory:'); db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY,name TEXT,daemon_type TEXT,is_active INTEGER,daemon_config TEXT);
      INSERT INTO docker_hosts VALUES (7,'pve','proxmox',1,'{}');`);
    identityMigration.up(db); recoveryMigration.up(db);
    nodeId = identityStore.remember({ hostId: 7, providerType: 'proxmox', kind: 'host',
      nativeRef: 'pve-a', stability: 'derived' }, db).id;
    storageId = identityStore.remember({ hostId: 7, providerType: 'proxmox', kind: 'storage',
      nativeRef: 'storage/pve-a/local-lvm', stability: 'derived' }, db).id;
    repository = recoveryCatalog.normalizeRepositoryAndRemember({ host: { id: 7 }, providerType: 'proxmox', database: db,
      raw: { nativeRef: 'pbs-prod', name: 'PBS', type: 'pbs', enabled: true, accessible: true } }).repository;
    point = recoveryCatalog.normalizeRecoveryPointAndRemember({ host: { id: 7 }, providerType: 'proxmox', database: db,
      repository, raw: { nativeRef: 'pbs-prod:backup/vm/101/2026-07-26T10:00:00Z',
        workloadRef: 'qemu/101', workloadName: 'app', guestType: 'qemu', createdAt: '2026-07-26T10:00:00Z',
        verification: 'verified' } });
    context = {
      operation: { provider: { type: 'proxmox', endpointId: 7 }, resource: { id: point.id },
        createdAt: new Date().toISOString(), startedAt: new Date().toISOString() },
      request: { planHash: 'a'.repeat(64), recoveryPointId: point.id, repositoryId: repository.id,
        guestType: 'qemu', targetNodeId: nodeId, targetStorageId: storageId, targetVmid: 9123,
        bandwidthLimitMbps: 8, verificationOverride: false, overrideReason: null,
        startAfterRestore: false, liveRestore: false, overwrite: false },
      reportProgress: jest.fn(), bindNativeTask: jest.fn(), nativeTaskRef: null,
    };
    client = {
      listVMs: jest.fn(async () => []),
      listNodes: jest.fn(async () => [{ node: 'pve-a', status: 'online' }]),
      getNodeMigrationInventory: jest.fn(async () => ({ storages: [{ storage: 'local-lvm', enabled: 1, active: 1, content: 'images' }] })),
      listRecoveryPoints: jest.fn(async () => ({ repositories: [{ nativeRef: 'pbs-prod', enabled: true, accessible: true }],
        points: [{ nativeRef: 'pbs-prod:backup/vm/101/2026-07-26T10:00:00Z' }] })),
      restoreVmBackup: jest.fn(async () => ({ taskRef: 'UPID:pve-a:restore', node: 'pve-a' })),
      getTaskStatus: jest.fn(async () => ({ status: 'stopped', exitstatus: 'OK' })),
      stopTask: jest.fn(async () => ({ ok: true })), _agent: { destroy: jest.fn() },
    };
  });
  afterEach(() => db.close());

  it('checkpoints before submit and creates a powered-off unique, non-overwriting restore', async () => {
    const result = await handler.execute(context, { database: db, clientFactory: () => client });
    expect(context.bindNativeTask).toHaveBeenCalledWith(expect.stringContaining('"stage":"submit"'), 'submitting');
    expect(client.restoreVmBackup).toHaveBeenCalledWith('pve-a', 9123, 'qemu',
      'pbs-prod:backup/vm/101/2026-07-26T10:00:00Z', {
        storage: 'local-lvm', force: false, start: false, liveRestore: false, bwlimitKiB: 1000,
      });
    expect(result).toEqual(expect.objectContaining({ state: 'reconciling', phase: 'native-task',
      nativeTaskRef: expect.stringContaining('UPID:pve-a:restore') }));
  });

  it('proves the stopped canonical target after native task success', async () => {
    const targetId = identityStore.remember({ hostId: 7, providerType: 'proxmox', kind: 'virtualMachine',
      nativeRef: 'qemu/9123', stability: 'derived' }, db).id;
    client.listVMs.mockResolvedValue([{ vmid: 9123, type: 'qemu', node: 'pve-a', status: 'stopped' }]);
    registry.resourcesForHost.mockResolvedValue({ items: [{ id: targetId, displayName: 'restored-app', status: { powerState: 'stopped' } }] });
    context.nativeTaskRef = handler._internals._taskRef({ node: 'pve-a', vmid: 9123, guestType: 'qemu' }, 'UPID:pve-a:restore', 'native');
    await expect(handler.reconcile(context, { database: db, clientFactory: () => client })).resolves.toEqual(
      expect.objectContaining({ state: 'succeeded', result: expect.objectContaining({
        target: expect.objectContaining({ id: targetId, vmid: 9123, powerState: 'stopped' }),
        overwrite: false, startAfterRestore: false, automaticCleanupAuthorized: false,
      }) })
    );
  });

  it('never replays an ambiguous submit checkpoint and reports partial-target evidence', async () => {
    context.operation.createdAt = '2020-01-01T00:00:00Z';
    context.operation.startedAt = '2020-01-01T00:00:00Z';
    context.nativeTaskRef = handler._internals._taskRef({ node: 'pve-a', vmid: 9123, guestType: 'qemu' });
    const result = await handler.reconcile(context, { database: db, clientFactory: () => client });
    expect(result).toEqual(expect.objectContaining({ state: 'unknown', result: expect.objectContaining({
      targetObserved: false, partialTargetMayExist: true, automaticCleanupAuthorized: false,
    }) }));
    expect(client.restoreVmBackup).not.toHaveBeenCalled();
  });

  it('returns a durable failed result and cancel evidence without automatic cleanup', async () => {
    context.nativeTaskRef = handler._internals._taskRef({ node: 'pve-a', vmid: 9123, guestType: 'qemu' }, 'UPID:pve-a:restore', 'native');
    client.getTaskStatus.mockResolvedValue({ status: 'stopped', exitstatus: 'ERROR' });
    await expect(handler.reconcile(context, { database: db, clientFactory: () => client })).resolves.toEqual(
      expect.objectContaining({ state: 'failed', errorCode: 'PROVIDER_RESTORE_TASK_FAILED_PARTIAL_TARGET_POSSIBLE',
        result: expect.objectContaining({ partialTargetMayExist: true, automaticCleanupAuthorized: false }) })
    );
    await expect(handler.cancel(context, { database: db, clientFactory: () => client })).resolves.toEqual(
      expect.objectContaining({ confirmed: true, result: expect.objectContaining({
        providerTaskCancelled: true, automaticCleanupAuthorized: false,
      }) })
    );
  });

  it('rejects node-local source crossover and overwrite/start flags', () => {
    expect(() => handler._internals._archive('local@pve-a|local:backup/file', 'local@pve-a', 'pve-b'))
      .toThrow(expect.objectContaining({ code: 'RECOVERY_RESTORE_SOURCE_NODE_MISMATCH' }));
    context.request.overwrite = true;
    expect(() => handler._internals._request(context)).toThrow(expect.objectContaining({ code: 'INVALID_RECOVERY_RESTORE' }));
  });
});
