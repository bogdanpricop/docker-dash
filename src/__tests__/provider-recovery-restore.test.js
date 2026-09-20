'use strict';

process.env.ENCRYPTION_KEY = 'recovery-restore-service-test-key';

jest.mock('../config', () => ({
  security: { encryptionKey: 'recovery-restore-service-test-key' },
  features: { providerRecoveryRestore: false },
}));
jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('test must inject database'); }) }));
jest.mock('../services/provider-sdk/registry', () => ({}));
jest.mock('../services/provider-operations/index', () => ({ create: jest.fn() }));
jest.mock('../services/provider-operations/policy', () => ({}));
jest.mock('../services/provider-operations/handlers/vm-restore', () => ({ TYPE: 'vm.restore' }));

const Database = require('better-sqlite3');
const identityMigration = require('../db/migrations/106_provider_resource_identities');
const recoveryMigration = require('../db/migrations/117_provider_recovery_points');
const identityStore = require('../services/provider-sdk/identity-store');
const recoveryCatalog = require('../services/provider-sdk/recovery-point-catalog');
const service = require('../services/provider-operations/recovery-restore');

const host = { id: 7, name: 'pve-a', daemon_type: 'proxmox' };

describe('recovery restore planning and submission', () => {
  let db; let repository; let point; let nodeId; let storageId; let registry; let operations;

  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY,name TEXT,daemon_type TEXT,is_active INTEGER);
      INSERT INTO docker_hosts VALUES (7,'pve-a','proxmox',1);
      CREATE TABLE provider_operations (
        id TEXT PRIMARY KEY,state TEXT,resource_id TEXT,lock_scopes_json TEXT,
        host_id INTEGER,operation_type TEXT,created_at TEXT DEFAULT (datetime('now'))
      );`);
    identityMigration.up(db); recoveryMigration.up(db);
    nodeId = identityStore.remember({ hostId: 7, providerType: 'proxmox', kind: 'host',
      nativeRef: 'pve-a', stability: 'derived' }, db).id;
    storageId = identityStore.remember({ hostId: 7, providerType: 'proxmox', kind: 'storage',
      nativeRef: 'storage/pve-a/local-lvm', stability: 'derived' }, db).id;
    repository = recoveryCatalog.normalizeRepositoryAndRemember({ host, providerType: 'proxmox', database: db,
      raw: { nativeRef: 'pbs-prod', name: 'PBS production', type: 'pbs', enabled: true, accessible: true } }).repository;
    point = recoveryCatalog.normalizeRecoveryPointAndRemember({ host, providerType: 'proxmox', database: db,
      repository, raw: { nativeRef: 'pbs-prod:backup/vm/101/2026-07-26T10:00:00Z',
        workloadRef: 'qemu/101', workloadName: 'app-01', guestType: 'qemu',
        createdAt: '2026-07-26T10:00:00Z', sizeBytes: 1024, mode: 'incremental',
        verification: { state: 'verified', checkedAt: '2026-07-26T11:00:00Z' } } });
    registry = {
      recoveryPointsForHost: jest.fn(async () => ({ items: [point], repositories: [repository] })),
      capabilitiesForHost: jest.fn(async () => ({ features: {
        'backup.restore.vm': { state: 'conditional', reason: 'task-backed', constraints: { createOnly: true } },
        'backup.restore.disk': { state: 'unsupported', reason: 'not implemented' },
        'backup.restore.file': { state: 'unsupported', reason: 'not implemented' },
      } })),
      resourcesForHost: jest.fn(async (_host, kind) => {
        if (kind === 'hosts') return { items: [{ id: nodeId, displayName: 'pve-a', status: { powerState: 'running' } }] };
        if (kind === 'storages') return { items: [{ id: storageId, displayName: 'local-lvm',
          status: { accessible: true, freeBytes: 1024 * 1024 }, extensions: { node: 'pve-a', contentType: 'images,rootdir' } }] };
        return { items: [] };
      }),
    };
    operations = { create: jest.fn(input => ({ id: `op_${'a'.repeat(26)}`, state: 'queued', deduplicated: false, ...input })) };
  });

  afterEach(() => db.close());

  function deps(overrides = {}) {
    return {
      database: db, registry, operations, enabled: overrides.enabled ?? true,
      canOperate: overrides.canOperate ?? true, createdBy: 9,
      policy: { evaluate: jest.fn(() => overrides.policy || { allowed: true, code: null, mode: 'active', reason: null }) },
    };
  }

  function request(overrides = {}) {
    return { kind: 'vm', targetNodeId: nodeId, targetStorageId: storageId, targetVmid: 9123, ...overrides };
  }

  it('builds a deterministic create-only verified PVE plan', async () => {
    const plan = await service.preflightForHost(host, point.id, request(), deps());
    expect(plan).toEqual(expect.objectContaining({
      allowed: true, kind: 'vm', planHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      target: expect.objectContaining({ nodeId, storageId, vmid: 9123 }),
      safety: { createOnly: true, overwrite: false, startAfterRestore: false,
        liveRestore: false, uniqueNetworkIdentity: true, automaticCleanupAuthorized: false },
      confirmation: { required: true, mode: 'typed_restore_target', expected: 'RESTORE 9123' },
    }));
    expect(JSON.stringify(plan)).not.toContain('pbs-prod:backup');
    expect(JSON.stringify(plan)).not.toContain('storage/pve-a');
  });

  it('fails closed for unverified evidence, failed evidence, target conflict and active reservations', async () => {
    point.verification.state = 'unknown';
    let plan = await service.preflightForHost(host, point.id, request(), deps());
    expect(plan.blockers.map(item => item.type)).toContain('RECOVERY_POINT_UNVERIFIED');
    plan = await service.preflightForHost(host, point.id, request({
      allowUnverified: true, overrideReason: 'Restore requested for a documented incident test',
    }), deps());
    expect(plan.allowed).toBe(true);
    expect(plan.confirmation.expected).toBe('RESTORE UNVERIFIED 9123');

    point.verification.state = 'failed';
    plan = await service.preflightForHost(host, point.id, request({
      allowUnverified: true, overrideReason: 'Attempted override must remain blocked here',
    }), deps());
    expect(plan.blockers.map(item => item.type)).toContain('RECOVERY_POINT_VERIFICATION_FAILED');

    point.verification.state = 'verified';
    const targetVmId = identityStore.remember({ hostId: 7, providerType: 'proxmox', kind: 'virtualMachine',
      nativeRef: 'qemu/9123', stability: 'derived' }, db).id;
    registry.resourcesForHost.mockImplementation(async (_host, kind) => {
      if (kind === 'hosts') return { items: [{ id: nodeId, displayName: 'pve-a' }] };
      if (kind === 'storages') return { items: [{ id: storageId, displayName: 'local-lvm', status: { accessible: true, freeBytes: 999999 }, extensions: { contentType: 'images', node: 'pve-a' } }] };
      return { items: [{ id: targetVmId, displayName: 'occupied' }] };
    });
    db.prepare(`INSERT INTO provider_operations (id,state,resource_id,lock_scopes_json,host_id,operation_type)
      VALUES (?,?,?,?,?,?)`).run(`op_${'b'.repeat(26)}`, 'queued', point.id,
      JSON.stringify(['provider-vmid:7:9123']), 7, 'vm.restore');
    plan = await service.preflightForHost(host, point.id, request(), deps());
    expect(plan.blockers.map(item => item.type)).toEqual(expect.arrayContaining([
      'RESTORE_TARGET_VMID_CONFLICT', 'RESTORE_OPERATION_CONFLICT',
    ]));
  });

  it('submits one recovery-point operation only after fresh exact confirmation', async () => {
    const dependencies = deps();
    const plan = await service.preflightForHost(host, point.id, request(), dependencies);
    await expect(service.submitForHost(host, point.id, request({
      planHash: '0'.repeat(64), confirm: true, confirmText: 'RESTORE 9123', idempotencyKey: 'restore-request-1',
    }), dependencies)).rejects.toMatchObject({ code: 'RECOVERY_RESTORE_PREFLIGHT_STALE' });
    const result = await service.submitForHost(host, point.id, request({
      planHash: plan.planHash, confirm: true, confirmText: 'RESTORE 9123', idempotencyKey: 'restore-request-1',
    }), dependencies);
    expect(result.operation.type).toBe('vm.restore');
    expect(operations.create).toHaveBeenCalledWith(expect.objectContaining({
      resourceKind: 'recoveryPoint', resourceId: point.id, action: 'restore',
      request: expect.objectContaining({ targetVmid: 9123, startAfterRestore: false,
        liveRestore: false, overwrite: false, verificationOverride: false, overrideReason: null }),
      lockScopes: expect.arrayContaining([
        `resource:${point.id}`, 'provider-vmid:7:9123', `resource:${nodeId}`, `resource:${storageId}`,
      ]),
    }));
  });

  it('returns stable blocked plans for file and disk restore without inventing a mutation', async () => {
    for (const kind of ['file', 'disk']) {
      const plan = await service.preflightForHost(host, point.id, { kind }, deps());
      expect(plan.allowed).toBe(false);
      expect(plan.blockers.map(item => item.type)).toEqual(expect.arrayContaining([
        'RESTORE_CAPABILITY_UNSUPPORTED', 'RESTORE_KIND_NOT_EXECUTABLE',
      ]));
    }
    expect(operations.create).not.toHaveBeenCalled();
  });
});
