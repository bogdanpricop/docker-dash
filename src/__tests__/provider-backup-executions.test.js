'use strict';

jest.mock('../config', () => ({
  app: { env: 'test' }, security: { encryptionKey: 'backup-execution-test-key-32-chars' },
  features: { providerBackupPolicies: true, providerBackupExecution: true, providerRecoveryPointInventory: true },
}));
jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('inject database'); }) }));
jest.mock('../services/provider-sdk/registry', () => ({
  capabilitiesForHost: jest.fn(), resourcesForHost: jest.fn(), recoveryPointsForHost: jest.fn(),
}));
jest.mock('../services/provider-operations/index', () => ({ create: jest.fn(), get: jest.fn(), requestCancel: jest.fn() }));
jest.mock('../services/audit', () => ({ log: jest.fn() }));

const Database = require('better-sqlite3');
const identityMigration = require('../db/migrations/106_provider_resource_identities');
const operationMigration = require('../db/migrations/107_provider_operations');
const recoveryMigration = require('../db/migrations/117_provider_recovery_points');
const policyMigration = require('../db/migrations/118_provider_backup_policies');
const executionMigration = require('../db/migrations/119_provider_backup_execution');
const identityStore = require('../services/provider-sdk/identity-store');
const recoveryCatalog = require('../services/provider-sdk/recovery-point-catalog');
const registry = require('../services/provider-sdk/registry');
const engine = require('../services/provider-operations/index');
const policies = require('../services/provider-operations/backup-policies');
const executions = require('../services/provider-operations/backup-executions');

const host = { id: 7, name: 'pve-a', daemon_type: 'proxmox', is_active: 1 };

describe('provider backup executions', () => {
  let db; let vmId; let repository; let policy; let operations; let operationIndex;
  beforeEach(async () => {
    jest.clearAllMocks(); operations = new Map(); operationIndex = 0;
    db = new Database(':memory:'); db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY,username TEXT); INSERT INTO users VALUES (9,'admin');
      CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY,name TEXT,daemon_type TEXT,is_active INTEGER);
      INSERT INTO docker_hosts VALUES (7,'pve-a','proxmox',1);`);
    identityMigration.up(db); operationMigration.up(db); recoveryMigration.up(db); policyMigration.up(db); executionMigration.up(db);
    vmId = identityStore.remember({ hostId: 7, providerType: 'proxmox', kind: 'virtualMachine',
      uuid: 'vm-101', nativeRef: 'qemu/101', stability: 'stable' }, db).id;
    repository = recoveryCatalog.normalizeRepositoryAndRemember({ host, providerType: 'proxmox', database: db,
      observedAt: '2026-07-26T10:00:00Z', raw: { nativeRef: 'pbs-prod', name: 'PBS production', type: 'pbs',
        enabled: true, accessible: true, supportsVerification: true,
        supportsClientSideEncryption: true, supportsImmutableRetention: true } }).repository;
    registry.capabilitiesForHost.mockResolvedValue({ probe: { status: 'reachable' },
      features: { 'backup.run': { state: 'conditional', reason: null } } });
    registry.resourcesForHost.mockResolvedValue({ truncated: false, items: [{ id: vmId, displayName: 'app-01',
      status: { powerState: 'running' }, identity: { stability: 'stable' }, labels: {} }] });
    registry.recoveryPointsForHost.mockResolvedValue({ truncated: false, repositories: [repository], items: [] });
    const saved = await policies.upsertForHost(host, {
      name: 'Production vzdump', repositoryId: repository.id, enabled: false, mode: 'plan_only',
      schedule: { frequency: 'daily', minute: 15, hour: 2, timezone: 'UTC' },
      scope: { includeAll: true, workloadIds: [], selectors: { labels: {}, powerStates: [] },
        exclusions: { workloadIds: [], labels: {}, diskSelectors: [] } },
      consistency: { requested: 'crash', fallback: 'fail' },
      controls: { maxConcurrent: 1 }, verification: { afterBackup: false, maximumUnverifiedHours: 24 },
    }, { database: db, createdBy: 9 });
    policy = executions.authorizeForHost(host, saved.policy.id, {
      mode: 'manual', confirmName: 'Production vzdump',
    }, { database: db, createdBy: 9 });
    engine.create.mockImplementation(input => {
      const id = `op_${String(++operationIndex).padStart(26, 'a')}`;
      db.prepare(`INSERT INTO provider_operations
        (id,operation_type,provider_type,host_id,resource_kind,resource_id,action,request_hash,request_enc,lock_scopes_json)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, input.type, input.providerType, input.hostId,
        input.resourceKind, input.resourceId, input.action, 'a'.repeat(64), 'enc', JSON.stringify(input.lockScopes));
      const operation = { id, state: 'queued', result: null, error: null }; operations.set(id, operation); return operation;
    });
    engine.get.mockImplementation(id => operations.get(id) || null);
  });
  afterEach(() => db.close());

  it('requires separate authorization, revalidates an accepted plan and dispatches idempotently', async () => {
    expect(policy.execution).toEqual(expect.objectContaining({ mode: 'manual', authorizedBy: 9 }));
    const first = await executions.createForHost(host, policy.id, { confirmName: policy.name }, {
      database: db, engine, registry, createdBy: 9, idempotencyKey: 'manual-run-0001',
    });
    expect(first.deduplicated).toBe(false);
    expect(first.execution).toEqual(expect.objectContaining({ state: 'running',
      summary: expect.objectContaining({ total: 1, retentionMutationAuthorized: false }) }));
    expect(engine.create).toHaveBeenCalledWith(expect.objectContaining({
      type: 'vm.backup', lockScopes: [`resource:${vmId}`, `repository:${repository.id}`],
      request: expect.objectContaining({ consistency: 'crash', verificationRequired: false }),
    }));
    const duplicate = await executions.createForHost(host, policy.id, { confirmName: policy.name }, {
      database: db, engine, registry, createdBy: 9, idempotencyKey: 'manual-run-0001',
    });
    expect(duplicate.deduplicated).toBe(true); expect(duplicate.execution.id).toBe(first.execution.id);
    expect(engine.create).toHaveBeenCalledTimes(1);
    expect(() => policies.removeForHost(7, policy.id, { database: db }))
      .toThrow(expect.objectContaining({ code: 'BACKUP_EXECUTION_ACTIVE' }));
  });

  it('marks success only after a child operation reports live recovery-point proof', async () => {
    const started = await executions.createForHost(host, policy.id, { confirmName: policy.name }, {
      database: db, engine, registry, createdBy: 9, idempotencyKey: 'manual-run-0002',
    });
    const point = recoveryCatalog.normalizeRecoveryPointAndRemember({ host, providerType: 'proxmox', database: db,
      repository, raw: { nativeRef: 'pbs-prod:new-point', repositoryRef: 'pbs-prod', workloadRef: 'qemu/101',
        workloadUuid: 'vm-101', createdAt: '2026-07-26T10:05:00Z', verification: 'unverified' } });
    const item = started.execution.items[0];
    operations.set(item.operationId, { id: item.operationId, state: 'succeeded', error: null, result: {
      recoveryPointId: point.id, verificationState: 'unverified', retentionMutationAuthorized: false,
    } });
    const result = await executions.reconcile({ database: db, engine, registry, executionId: started.execution.id });
    expect(result.updated[0]).toEqual(expect.objectContaining({ state: 'succeeded' }));
    expect(executions.get(started.execution.id, { database: db })).toEqual(expect.objectContaining({
      state: 'succeeded', summary: expect.objectContaining({ recoveryPointsObserved: 1,
        retentionMutationAuthorized: false }),
    }));
  });

  it('fails closed for XO and for unproven required verification', async () => {
    expect(() => executions.authorizeForHost({ ...host, daemon_type: 'xen' }, policy.id,
      { mode: 'manual', confirmName: policy.name }, { database: db, createdBy: 9 }))
      .toThrow(expect.objectContaining({ code: 'BACKUP_PROVIDER_UNSUPPORTED' }));
    const plan = { allowed: true, repository: { capabilities: {} } };
    const strict = { ...policy, verification: { afterBackup: true }, scope: { ...policy.scope, exclusions: { diskSelectors: [] } } };
    const check = await executions._internals._executionPreflight(host, strict, plan, { registry });
    expect(check.allowed).toBe(false);
    expect(check.blockers.map(item => item.code)).toContain('BACKUP_VERIFICATION_UNPROVEN');
  });

  it('cancels active children durably without authorizing recovery-point deletion', async () => {
    const started = await executions.createForHost(host, policy.id, { confirmName: policy.name }, {
      database: db, engine, registry, createdBy: 9, idempotencyKey: 'manual-run-cancel',
    });
    engine.requestCancel.mockImplementation(id => ({ ...operations.get(id), state: 'cancel_requested' }));
    const requested = await executions.cancelForHost(host, started.execution.id, { confirmName: policy.name }, {
      database: db, engine, registry, createdBy: 9,
    });
    expect(requested.state).toBe('running');
    expect(engine.requestCancel).toHaveBeenCalledWith(started.execution.items[0].operationId);
    operations.set(started.execution.items[0].operationId, { id: started.execution.items[0].operationId,
      state: 'cancelled', result: null, error: { code: 'CANCELLED' } });
    await executions.reconcile({ database: db, engine, registry, executionId: started.execution.id });
    expect(executions.get(started.execution.id, { database: db })).toEqual(expect.objectContaining({
      state: 'cancelled', summary: expect.objectContaining({ retentionMutationAuthorized: false }),
    }));
  });
});
