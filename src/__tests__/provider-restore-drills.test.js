'use strict';

process.env.ENCRYPTION_KEY = 'restore-drill-service-key-32-characters';

jest.mock('../config', () => ({
  app: { env: 'test' }, security: { encryptionKey: 'restore-drill-service-key-32-characters' },
  features: { providerRestoreDrills: false, providerRecoveryRestore: true },
}));
jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('inject database'); }) }));
jest.mock('../services/provider-sdk/registry', () => ({}));
jest.mock('../services/provider-operations/index', () => ({ create: jest.fn(), get: jest.fn() }));
jest.mock('../services/provider-operations/recovery-restore', () => ({ preflightForHost: jest.fn() }));
jest.mock('../services/provider-operations/backup-policies', () => ({
  _internals: { SAFE_POLICY_ID: /^pbp_[a-f0-9]{26}$/ }, slotKey: jest.fn(),
  get: jest.fn(), preflightForHost: jest.fn(),
}));
jest.mock('../services/provider-operations/handlers/recovery-drill', () => ({ TYPE: 'recovery.drill' }));
jest.mock('../services/audit', () => ({ log: jest.fn() }));

const Database = require('better-sqlite3');
const migration = require('../db/migrations/120_provider_restore_drills');
const recoveryRestore = require('../services/provider-operations/recovery-restore');
const service = require('../services/provider-operations/restore-drills');

const host = { id: 7, daemon_type: 'proxmox', is_active: 1 };
const pointId = `ddr_rp_${'a'.repeat(26)}`;
const nodeId = `ddr_host_${'b'.repeat(26)}`;
const storageId = `ddr_storage_${'c'.repeat(26)}`;

describe('restore-drill planning, submission and evidence', () => {
  let db; let registry; let operations;
  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY);
      CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY,daemon_type TEXT,is_active INTEGER);
      CREATE TABLE provider_backup_policies (id TEXT PRIMARY KEY);
      CREATE TABLE provider_resource_identities (canonical_id TEXT PRIMARY KEY);
      CREATE TABLE provider_recovery_points (canonical_id TEXT PRIMARY KEY,workload_id TEXT);
      CREATE TABLE provider_operations (id TEXT PRIMARY KEY);
      INSERT INTO users VALUES (9); INSERT INTO docker_hosts VALUES (7,'proxmox',1);
      INSERT INTO provider_recovery_points VALUES ('${pointId}','ddr_vm_${'d'.repeat(26)}');
      INSERT INTO provider_resource_identities VALUES ('${nodeId}');
      INSERT INTO provider_resource_identities VALUES ('${storageId}');`);
    migration.up(db);
    recoveryRestore.preflightForHost.mockResolvedValue({
      allowed: true, blockers: [], warnings: [], planHash: 'd'.repeat(64),
      source: { recoveryPointId: pointId, repositoryId: `ddr_repo_${'e'.repeat(26)}`,
        guestType: 'qemu', createdAt: new Date(Date.now() - 120000).toISOString(),
        verification: { state: 'verified' } },
      target: { nodeId, storageId, vmid: 9123, bandwidthLimitMbps: null },
      validUntil: new Date(Date.now() + 300000).toISOString(),
    });
    registry = { capabilitiesForHost: jest.fn(async () => ({ features: {
      'backup.restore.drill': { state: 'conditional', reason: 'isolated task-backed drill',
        constraints: { allNicsDisconnectedBeforeBoot: true } },
    } })) };
    const stored = new Map();
    operations = {
      create: jest.fn(input => {
        const operation = { id: `op_${'f'.repeat(26)}`, state: 'queued', deduplicated: false,
          startedAt: null, completedAt: null, result: null, error: null, ...input };
        db.prepare('INSERT OR IGNORE INTO provider_operations (id) VALUES (?)').run(operation.id);
        stored.set(operation.id, operation); return operation;
      }),
      get: jest.fn(id => stored.get(id) || null),
      stored,
    };
  });
  afterEach(() => { db.close(); jest.clearAllMocks(); });

  function input(overrides = {}) {
    return { kind: 'vm', targetNodeId: nodeId, targetStorageId: storageId, targetVmid: 9123,
      assertions: { boot: true, guestAgent: 'required', bootTimeoutSeconds: 300, osInfo: true },
      cleanupMode: 'on_success', allowAutomaticCleanup: true, shutdownTimeoutSeconds: 120,
      rtoTargetSeconds: 900, ...overrides };
  }
  function deps() { return { database: db, registry, operations, enabled: true,
    restoreEnabled: true, canOperate: true, createdBy: 9 }; }

  it('requires explicit cleanup authorization and publishes isolated RPO/RTO semantics', async () => {
    let plan = await service.preflightForHost(host, pointId,
      input({ allowAutomaticCleanup: false }), deps());
    expect(plan.allowed).toBe(false);
    expect(plan.blockers.map(item => item.type)).toContain('RESTORE_DRILL_CLEANUP_AUTHORIZATION_REQUIRED');
    plan = await service.preflightForHost(host, pointId, input(), deps());
    expect(plan).toEqual(expect.objectContaining({
      allowed: true, planHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      confirmation: { required: true, expected: 'DRILL 9123', cleanupExpected: 'DRILL DELETE 9123' },
      safety: expect.objectContaining({ allNicsDisconnectedBeforeBoot: true,
        arbitraryGuestCommandsAuthorized: false, cleanupOnSuccessOnly: true }),
    }));
    expect(plan.objectives.rpoAgeSeconds).toBeGreaterThanOrEqual(119);
  });

  it('queues exactly one run after two typed confirmations and deduplicates it', async () => {
    const plan = await service.preflightForHost(host, pointId, input(), deps());
    const body = input({ planHash: plan.planHash, confirm: true, confirmText: 'DRILL 9123',
      cleanupConfirmText: 'DRILL DELETE 9123', idempotencyKey: 'restore-drill-request-1' });
    const first = await service.submitForHost(host, pointId, body, deps());
    expect(first.run).toEqual(expect.objectContaining({ state: 'queued', operationId: `op_${'f'.repeat(26)}` }));
    expect(operations.create).toHaveBeenCalledWith(expect.objectContaining({
      type: 'recovery.drill', action: 'drill', resourceId: pointId,
      request: expect.objectContaining({ assertions: expect.objectContaining({ guestAgent: 'required' }),
        automaticCleanupAuthorized: true, startAfterRestore: false, overwrite: false }),
    }));
    const second = await service.submitForHost(host, pointId, body, deps());
    expect(second.deduplicated).toBe(true);
    expect(second.run.id).toBe(first.run.id);
    expect(operations.create).toHaveBeenCalledTimes(1);
  });

  it('reconciles immutable evidence into RTO, cleanup duration and compliance', async () => {
    const plan = await service.preflightForHost(host, pointId, input(), deps());
    const result = await service.submitForHost(host, pointId, input({ planHash: plan.planHash,
      confirm: true, confirmText: 'DRILL 9123', cleanupConfirmText: 'DRILL DELETE 9123',
      idempotencyKey: 'restore-drill-request-2' }), deps());
    operations.stored.set(result.operation.id, { ...result.operation, state: 'succeeded',
      startedAt: '2026-07-26T10:00:00.000Z', completedAt: '2026-07-26T10:03:00.000Z', error: null,
      result: { timing: { restoreStartedAt: '2026-07-26T10:00:00.000Z',
        assertionCompletedAt: '2026-07-26T10:02:00.000Z',
        cleanupStartedAt: '2026-07-26T10:02:30.000Z', cleanupCompletedAt: '2026-07-26T10:03:00.000Z' },
        cleanup: { completed: true }, targetRetained: false } });
    await service.reconcile({ database: db, operations, hostId: 7 });
    expect(service.getRun(7, result.run.id, { database: db, operations })).toEqual(
      expect.objectContaining({ state: 'succeeded', rtoSeconds: 120, cleanupSeconds: 30,
        evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/), compliance: 'met' }));
  });
});
