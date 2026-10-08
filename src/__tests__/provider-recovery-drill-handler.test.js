'use strict';

jest.mock('../config', () => ({
  app: { env: 'test' }, security: { encryptionKey: 'restore-drill-handler-key-32chars' },
  features: { providerRecoveryPointInventory: true },
}));
jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('inject database'); }) }));
jest.mock('../services/provider-sdk/registry', () => ({ resourcesForHost: jest.fn() }));

const Database = require('better-sqlite3');
const identityMigration = require('../db/migrations/106_provider_resource_identities');
const recoveryMigration = require('../db/migrations/117_provider_recovery_points');
const identityStore = require('../services/provider-sdk/identity-store');
const recoveryCatalog = require('../services/provider-sdk/recovery-point-catalog');
const handler = require('../services/provider-operations/handlers/recovery-drill');

describe('durable isolated Proxmox restore-drill handler', () => {
  let db; let context; let client; let point; let nodeId; let storageId;
  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY,name TEXT,daemon_type TEXT,is_active INTEGER,daemon_config TEXT);
      INSERT INTO docker_hosts VALUES (7,'pve','proxmox',1,'{}');`);
    identityMigration.up(db); recoveryMigration.up(db);
    nodeId = identityStore.remember({ hostId: 7, providerType: 'proxmox', kind: 'host',
      nativeRef: 'pve-a', stability: 'derived' }, db).id;
    storageId = identityStore.remember({ hostId: 7, providerType: 'proxmox', kind: 'storage',
      nativeRef: 'storage/pve-a/local-lvm', stability: 'derived' }, db).id;
    const repository = recoveryCatalog.normalizeRepositoryAndRemember({ host: { id: 7 }, providerType: 'proxmox', database: db,
      raw: { nativeRef: 'pbs-prod', name: 'PBS', type: 'pbs', enabled: true, accessible: true } }).repository;
    point = recoveryCatalog.normalizeRecoveryPointAndRemember({ host: { id: 7 }, providerType: 'proxmox', database: db,
      repository, raw: { nativeRef: 'pbs-prod:backup/vm/101/time', workloadRef: 'qemu/101',
        workloadName: 'app', guestType: 'qemu', createdAt: '2026-07-26T10:00:00Z', verification: 'verified' } });
    context = {
      operation: { provider: { type: 'proxmox', endpointId: 7 }, resource: { id: point.id },
        createdAt: new Date().toISOString(), startedAt: new Date().toISOString() },
      request: { runId: `pdrr_${'a'.repeat(26)}`, planHash: 'b'.repeat(64),
        recoveryPointId: point.id, repositoryId: repository.id, guestType: 'qemu',
        targetNodeId: nodeId, targetStorageId: storageId, targetVmid: 9123,
        bandwidthLimitMbps: null, verificationOverride: false, overrideReason: null,
        assertions: { boot: true, guestAgent: 'required', bootTimeoutSeconds: 300, osInfo: true },
        cleanupMode: 'on_success', automaticCleanupAuthorized: true,
        shutdownTimeoutSeconds: 120, allowForceStop: true,
        startAfterRestore: false, liveRestore: false, overwrite: false },
      reportProgress: jest.fn(), bindNativeTask: jest.fn(), nativeTaskRef: null,
    };
    client = {
      listVMs: jest.fn(async () => []), listNodes: jest.fn(async () => [{ node: 'pve-a', status: 'online' }]),
      getNodeMigrationInventory: jest.fn(async () => ({ storages: [{ storage: 'local-lvm', enabled: 1, active: 1, content: 'images' }] })),
      listRecoveryPoints: jest.fn(async () => ({ repositories: [{ nativeRef: 'pbs-prod', enabled: true, accessible: true }],
        points: [{ nativeRef: 'pbs-prod:backup/vm/101/time' }] })),
      restoreVmBackup: jest.fn(async () => ({ taskRef: 'UPID:pve-a:restore' })),
      getTaskStatus: jest.fn(async () => ({ status: 'stopped', exitstatus: 'OK' })),
      configureRestoreDrillIsolation: jest.fn(async () => ({ networkCount: 2 })),
      verifyRestoreDrillIsolation: jest.fn(async () => ({ configured: true, markerMatches: true,
        networkCount: 2, isolatedCount: 2 })),
      vmPowerAction: jest.fn(async (_node, _vmid, _type, action) => ({ taskRef: `UPID:pve-a:${action}` })),
      pingGuestAgent: jest.fn(async () => ({ reachable: true })),
      getGuestAgentOsInfo: jest.fn(async () => ({ name: 'Debian', version: '13' })),
      getVmStatus: jest.fn(async () => ({ status: 'stopped' })),
      destroyRestoreDrillTarget: jest.fn(async () => ({ taskRef: 'UPID:pve-a:destroy' })),
      stopTask: jest.fn(), _agent: { destroy: jest.fn() },
    };
  });
  afterEach(() => db.close());

  it('checkpoints before restore and isolates every NIC before first boot', async () => {
    let result = await handler.execute(context, { database: db, clientFactory: () => client });
    expect(context.bindNativeTask).toHaveBeenCalledWith(expect.stringContaining('"stage":"restore-submit"'), 'restore-submitting');
    expect(client.restoreVmBackup).toHaveBeenCalledWith('pve-a', 9123, 'qemu',
      'pbs-prod:backup/vm/101/time', expect.objectContaining({ force: false, start: false, liveRestore: false }));
    context.nativeTaskRef = result.nativeTaskRef;
    client.listVMs.mockResolvedValue([{ vmid: 9123, type: 'qemu', node: 'pve-a', status: 'stopped' }]);
    result = await handler.reconcile(context, { database: db, clientFactory: () => client });
    expect(client.configureRestoreDrillIsolation).toHaveBeenCalledWith('pve-a', 9123, 'qemu',
      `Docker Dash restore drill pdrr_${'a'.repeat(26)}`);
    expect(client.vmPowerAction).not.toHaveBeenCalled();
    context.nativeTaskRef = result.nativeTaskRef;
    result = await handler.reconcile(context, { database: db, clientFactory: () => client });
    expect(client.verifyRestoreDrillIsolation).toHaveBeenCalled();
    expect(client.vmPowerAction).toHaveBeenCalledWith('pve-a', 9123, 'qemu', 'start');
    expect(result.phase).toBe('start-native');
  });

  it('retains failure targets and never authorizes arbitrary guest commands', () => {
    const checkpoint = handler._internals._baseCheckpoint(context.request,
      { node: 'pve-a' }, 'assertions', { evidence: {} });
    const failed = handler._internals._failed(context.request, checkpoint,
      'RESTORE_DRILL_GUEST_AGENT_FAILED', 'agent failed');
    expect(failed).toEqual(expect.objectContaining({ state: 'failed', result: expect.objectContaining({
      targetRetained: true, arbitraryGuestCommandsAuthorized: false,
      automaticCleanupAuthorized: true,
    }) }));
  });

  it('records bounded assertions and deletes only after stopped ownership proof', async () => {
    let result = await handler.execute(context, { database: db, clientFactory: () => client });
    context.nativeTaskRef = result.nativeTaskRef;
    client.listVMs.mockResolvedValue([{ vmid: 9123, type: 'qemu', node: 'pve-a', status: 'stopped' }]);
    result = await handler.reconcile(context, { database: db, clientFactory: () => client });
    context.nativeTaskRef = result.nativeTaskRef;
    result = await handler.reconcile(context, { database: db, clientFactory: () => client });
    context.nativeTaskRef = result.nativeTaskRef;
    client.listVMs.mockResolvedValue([{ vmid: 9123, type: 'qemu', node: 'pve-a', status: 'running' }]);
    result = await handler.reconcile(context, { database: db, clientFactory: () => client });
    expect(client.pingGuestAgent).toHaveBeenCalledWith('pve-a', 9123);
    expect(result.phase).toBe('shutdown-native');
    context.nativeTaskRef = result.nativeTaskRef;
    client.listVMs.mockResolvedValue([{ vmid: 9123, type: 'qemu', node: 'pve-a', status: 'stopped' }]);
    result = await handler.reconcile(context, { database: db, clientFactory: () => client });
    expect(client.getVmStatus.mock.invocationCallOrder[0]).toBeLessThan(
      client.verifyRestoreDrillIsolation.mock.invocationCallOrder.at(-1));
    expect(client.destroyRestoreDrillTarget).toHaveBeenCalledWith('pve-a', 9123, 'qemu');
    context.nativeTaskRef = result.nativeTaskRef;
    client.listVMs.mockResolvedValue([]);
    result = await handler.reconcile(context, { database: db, clientFactory: () => client });
    expect(result).toEqual(expect.objectContaining({ state: 'succeeded', result: expect.objectContaining({
      targetRetained: false, arbitraryGuestCommandsAuthorized: false,
      assertions: expect.objectContaining({ guestAgent: expect.objectContaining({
        passed: true, osName: 'Debian', osVersion: '13',
      }) }), cleanup: expect.objectContaining({ completed: true }),
      timing: expect.objectContaining({ restoreStartedAt: expect.any(String),
        assertionCompletedAt: expect.any(String), cleanupCompletedAt: expect.any(String) }),
    }) }));
  });
});
