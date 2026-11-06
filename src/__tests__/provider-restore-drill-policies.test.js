'use strict';

process.env.ENCRYPTION_KEY = 'restore-drill-policy-key-32-characters';

const mockBackupGet = jest.fn();
const mockBackupPreflight = jest.fn();
const mockSlotKey = jest.fn();
const mockRestorePreflight = jest.fn();

jest.mock('../config', () => ({
  app: { env: 'test' }, security: { encryptionKey: 'restore-drill-policy-key-32-characters' },
  features: { providerRestoreDrills: true, providerRecoveryRestore: true },
}));
jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('inject database'); }) }));
jest.mock('../services/provider-sdk/registry', () => ({}));
jest.mock('../services/provider-operations/index', () => ({ create: jest.fn(), get: jest.fn() }));
jest.mock('../services/provider-operations/backup-policies', () => ({
  _internals: { SAFE_POLICY_ID: /^pbp_[a-f0-9]{26}$/ },
  get: (...args) => mockBackupGet(...args),
  preflightForHost: (...args) => mockBackupPreflight(...args),
  slotKey: (...args) => mockSlotKey(...args),
}));
jest.mock('../services/provider-operations/recovery-restore', () => ({
  preflightForHost: (...args) => mockRestorePreflight(...args),
  _internals: { _storageIdentity: value => {
    const match = /^storage\/([^/]+)\/([^/]+)$/.exec(String(value));
    return match ? { node: match[1], storage: match[2] } : null;
  } },
}));
jest.mock('../services/provider-operations/handlers/recovery-drill', () => ({ TYPE: 'recovery.drill' }));
jest.mock('../services/audit', () => ({ log: jest.fn() }));
jest.mock('../utils/logger', () => () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }));

const Database = require('better-sqlite3');
const identityMigration = require('../db/migrations/106_provider_resource_identities');
const recoveryMigration = require('../db/migrations/117_provider_recovery_points');
const drillMigration = require('../db/migrations/120_provider_restore_drills');
const identityStore = require('../services/provider-sdk/identity-store');
const recoveryCatalog = require('../services/provider-sdk/recovery-point-catalog');
const service = require('../services/provider-operations/restore-drills');

describe('scheduled restore-drill policies', () => {
  let db; let host; let nodeId; let storageId; let point; let registry; let operations; let client;
  const backupPolicyId = `pbp_${'a'.repeat(26)}`;
  const workloadId = `ddr_vm_${'b'.repeat(26)}`;
  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY);
      CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY,name TEXT,daemon_type TEXT,is_active INTEGER,daemon_config TEXT);
      CREATE TABLE provider_backup_policies (id TEXT PRIMARY KEY);
      CREATE TABLE provider_operations (id TEXT PRIMARY KEY);
      INSERT INTO users VALUES (9); INSERT INTO docker_hosts VALUES (7,'pve-a','proxmox',1,'{}');
      INSERT INTO provider_backup_policies VALUES ('${backupPolicyId}');`);
    identityMigration.up(db); recoveryMigration.up(db); drillMigration.up(db);
    host = db.prepare('SELECT * FROM docker_hosts WHERE id=7').get();
    nodeId = identityStore.remember({ hostId: 7, providerType: 'proxmox', kind: 'host',
      nativeRef: 'pve-a', stability: 'derived' }, db).id;
    storageId = identityStore.remember({ hostId: 7, providerType: 'proxmox', kind: 'storage',
      nativeRef: 'storage/pve-a/local-lvm', stability: 'derived' }, db).id;
    identityStore.remember({ hostId: 7, providerType: 'proxmox', kind: 'virtualMachine',
      uuid: 'workload-a', nativeRef: 'qemu/101', stability: 'stable' }, db);
    const repository = recoveryCatalog.normalizeRepositoryAndRemember({ host, providerType: 'proxmox', database: db,
      raw: { nativeRef: 'pbs-a', name: 'PBS A', type: 'pbs', enabled: true, accessible: true } }).repository;
    point = recoveryCatalog.normalizeRecoveryPointAndRemember({ host, providerType: 'proxmox', database: db,
      repository, raw: { nativeRef: 'pbs-a:backup/vm/101/time', workloadRef: 'qemu/101',
        workloadName: 'app', guestType: 'qemu', createdAt: '2026-07-26T10:00:00Z', verification: 'verified' } });
    point.workload.id = workloadId;
    db.prepare('UPDATE provider_recovery_points SET workload_id=? WHERE canonical_id=?').run(workloadId, point.id);
    const backup = { id: backupPolicyId, hostId: 7, repositoryId: repository.id,
      enabled: true, verification: { restoreDrillRequired: true } };
    mockBackupGet.mockReturnValue(backup);
    mockBackupPreflight.mockResolvedValue({ allowed: true, scope: { workloads: [{ id: workloadId }] } });
    mockSlotKey.mockReturnValue('2026-07-26T03:15@UTC');
    registry = {
      capabilitiesForHost: jest.fn(async () => ({ features: {
        'backup.restore.drill': { state: 'conditional', reason: 'task-backed', constraints: {} },
      } })),
      recoveryPointsForHost: jest.fn(async () => ({ items: [point], repositories: [repository] })),
    };
    mockRestorePreflight.mockImplementation(async (_host, _point, input) => ({
      allowed: true, blockers: [], warnings: [], planHash: 'c'.repeat(64), validUntil: '2026-07-26T12:00:00Z',
      source: { recoveryPointId: point.id, repositoryId: repository.id, guestType: 'qemu',
        createdAt: point.createdAt, verification: { state: 'verified' } },
      target: { nodeId: input.targetNodeId, storageId: input.targetStorageId,
        vmid: input.targetVmid, bandwidthLimitMbps: null },
    }));
    const stored = new Map();
    operations = {
      create: jest.fn(input => {
        const value = { id: `op_${'d'.repeat(26)}`, state: 'queued', startedAt: null,
          completedAt: null, result: null, error: null, ...input };
        db.prepare('INSERT OR IGNORE INTO provider_operations VALUES (?)').run(value.id);
        stored.set(value.id, value); return value;
      }),
      get: jest.fn(id => stored.get(id) || null), stored,
    };
    client = { nextVmId: jest.fn(async () => 9222), _agent: { destroy: jest.fn() } };
  });
  afterEach(() => { db.close(); jest.clearAllMocks(); });

  function policyBody() {
    const name = 'Weekly recovery proof';
    return { name, enabled: true, backupPolicyId,
      target: { nodeId, storageId }, schedule: { frequency: 'weekly', minute: 15,
        hour: 3, weekday: 0, dayOfMonth: 1, timezone: 'UTC' },
      assertions: { guestAgent: 'auto', bootTimeoutSeconds: 300, osInfo: true },
      cleanupMode: 'on_success', shutdownTimeoutSeconds: 120,
      rpoTargetSeconds: 86400, rtoTargetSeconds: 900,
      authorizationText: `AUTHORIZE DRILL ${name}`,
      cleanupAuthorizationText: `ALLOW AUTOMATIC CLEANUP ${name}` };
  }

  it('persists explicit schedule and cleanup authorization', async () => {
    await expect(service.upsertPolicyForHost(host,
      { ...policyBody(), cleanupAuthorizationText: '' }, { database: db, registry, createdBy: 9 }))
      .rejects.toMatchObject({ code: 'RESTORE_DRILL_POLICY_CLEANUP_AUTHORIZATION_REQUIRED' });
    const saved = await service.upsertPolicyForHost(host, policyBody(), {
      database: db, registry, createdBy: 9,
    });
    expect(saved.policy).toEqual(expect.objectContaining({ enabled: true, backupPolicyId,
      target: { nodeId, storageId }, authorization: expect.objectContaining({
        scheduledExecution: true, automaticCleanup: true, authorizedBy: 9,
      }) }));
  });

  it('starts one due run and persists a later no-evidence slot as blocked', async () => {
    const saved = await service.upsertPolicyForHost(host, policyBody(), {
      database: db, registry, createdBy: 9,
    });
    const first = await service.runDue({ database: db, registry, operations,
      clientFactory: () => client, enabled: true, now: new Date('2026-07-26T03:15:00Z') });
    expect(first.started).toHaveLength(1);
    expect(first.started[0]).toEqual(expect.objectContaining({ state: 'queued', policyId: saved.policy.id,
      recoveryPointId: point.id, target: expect.objectContaining({ vmid: 9222 }) }));
    expect(operations.create).toHaveBeenCalledTimes(1);
    const duplicate = await service.runDue({ database: db, registry, operations,
      clientFactory: () => client, enabled: true, now: new Date('2026-07-26T03:15:30Z') });
    expect(duplicate.started).toHaveLength(0);

    const operationId = first.started[0].operationId;
    operations.stored.set(operationId, { ...operations.stored.get(operationId), state: 'succeeded',
      startedAt: '2026-07-26T03:15:00Z', completedAt: '2026-07-26T03:20:00Z',
      result: { cleanup: { completed: true }, timing: {} }, error: null });
    mockSlotKey.mockReturnValue('2026-08-02T03:15@UTC');
    registry.recoveryPointsForHost.mockResolvedValue({ items: [], repositories: [] });
    const blocked = await service.runDue({ database: db, registry, operations,
      clientFactory: () => client, enabled: true, now: new Date('2026-08-02T03:15:00Z') });
    expect(blocked.started).toHaveLength(1);
    expect(blocked.started[0]).toEqual(expect.objectContaining({ state: 'blocked',
      recoveryPointId: null, error: { code: 'RESTORE_DRILL_NO_ELIGIBLE_RECOVERY_POINT' } }));
    expect(operations.create).toHaveBeenCalledTimes(1);
  });
});
