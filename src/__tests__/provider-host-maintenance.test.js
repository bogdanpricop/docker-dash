'use strict';

jest.mock('../config', () => ({
  app: { env: 'test' },
  features: { providerHostMaintenance: true, providerVmMigration: true },
  security: { encryptionKey: 'provider-host-maintenance-test-key' },
  providerHostMaintenance: { pollLimit: 20, leaseMs: 90_000, nativeTimeoutSeconds: 3600 },
}));
jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('test must inject database'); }) }));
jest.mock('../services/provider-sdk/registry', () => ({}));
jest.mock('../services/provider-sdk/vm-migration-preflight', () => ({}));
jest.mock('../services/provider-operations/index', () => ({}));
jest.mock('../services/provider-operations/vm-migration', () => ({}));
jest.mock('../services/provider-operations/maintenance-provider', () => ({}));

const Database = require('better-sqlite3');
const operationMigration = require('../db/migrations/107_provider_operations');
const maintenanceMigration = require('../db/migrations/114_provider_host_maintenance');
const maintenance = require('../services/provider-operations/host-maintenance');

const SOURCE = `ddr_host_${'a'.repeat(26)}`;
const TARGET_A = `ddr_host_${'b'.repeat(26)}`;
const TARGET_B = `ddr_host_${'c'.repeat(26)}`;
const VM_A = `ddr_vm_${'d'.repeat(26)}`;
const VM_B = `ddr_vm_${'e'.repeat(26)}`;
const host = { id: 7, name: 'cluster-a', daemon_type: 'proxmox', is_active: 1 };

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
    CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY, name TEXT, daemon_type TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1);
    INSERT INTO users (id, username) VALUES (1, 'admin');
    INSERT INTO docker_hosts (id, name, daemon_type, is_active) VALUES (7, 'cluster-a', 'proxmox', 1);
  `);
  operationMigration.up(db); maintenanceMigration.up(db);
  return db;
}

function fixtures() {
  const hosts = [{
    id: SOURCE, displayName: 'pve-a', identity: { stability: 'derived' },
    status: { powerState: 'running', enabled: true, memoryFreeBytes: 64 * 1024 ** 3 },
  }, {
    id: TARGET_A, displayName: 'pve-b', identity: { stability: 'derived' },
    status: { powerState: 'running', enabled: true, memoryFreeBytes: 12 * 1024 ** 3 },
  }, {
    id: TARGET_B, displayName: 'pve-c', identity: { stability: 'derived' },
    status: { powerState: 'running', enabled: true, memoryFreeBytes: 32 * 1024 ** 3 },
  }];
  const vms = [{ id: VM_A, displayName: 'app-a', spec: { memoryBytes: 8 * 1024 ** 3 }, status: { powerState: 'running' } },
    { id: VM_B, displayName: 'db-b', spec: { memoryBytes: 8 * 1024 ** 3 }, status: { powerState: 'stopped' } }];
  const registry = {
    capabilitiesForHost: jest.fn(async () => ({ features: { 'host.maintenance': {
      state: 'conditional', reason: 'drain', constraints: { goals: ['drain'], waves: true },
    } } })),
    resourcesForHost: jest.fn(async (_host, kind) => kind === 'hosts'
      ? { items: hosts, totalObserved: hosts.length }
      : { items: vms, totalObserved: vms.length }),
  };
  const migrationPreflight = {
    preflightForHost: jest.fn(async (_host, vmId) => {
      const vm = vms.find(item => item.id === vmId);
      const mode = vm.status.powerState === 'running' ? 'live' : 'cold';
      const candidate = target => ({
        target: { id: target.id, displayName: target.displayName, capacity: { targetFreeMemoryBytes: target.status.memoryFreeBytes } },
        score: target.id === TARGET_A ? 100 : 90,
        modes: {
          live: { state: mode === 'live' ? 'ready' : 'blocked', blockers: [] },
          cold: { state: mode === 'cold' ? 'ready' : 'blocked', blockers: [] },
          storage: { state: 'unknown', blockers: [] },
        },
      });
      return { sourceTargetId: SOURCE, candidates: [candidate(hosts[1]), candidate(hosts[2])] };
    }),
  };
  return { registry, migrationPreflight, vms };
}

function native(workloads = []) {
  return {
    open: jest.fn(async () => ({ host, client: {}, identity: { nativeRef: 'pve-a' } })),
    close: jest.fn(async () => {}), prepare: jest.fn(async () => null),
    workloads: jest.fn(async () => workloads), hostState: jest.fn(async () => ({ maintenance: false, online: true })),
    exit: jest.fn(async () => ({ completed: true })), enter: jest.fn(async () => ({ completed: true })),
    parseTask: jest.fn(), taskStatus: jest.fn(), taskOutcome: jest.fn(), taskRef: jest.fn(),
  };
}

function insertOperation(db, id, vmId) {
  db.prepare(`INSERT INTO provider_operations
    (id, operation_type, provider_type, host_id, resource_kind, resource_id, action,
     request_hash, request_enc, idempotency_key_hash, lock_scopes_json,
     retry_policy, max_attempts, timeout_seconds, available_at)
    VALUES (?, 'vm.migrate', 'proxmox', 7, 'virtualMachine', ?, 'live',
      ?, ?, ?, '[]', 'none', 1, 3600, datetime('now'))`)
    .run(id, vmId, 'a'.repeat(64), 'encrypted', id.padEnd(64, 'b'));
}

describe('durable host maintenance orchestration', () => {
  let db;
  beforeEach(() => { db = createDb(); });
  afterEach(() => db.close());

  it('builds a deterministic aggregate-capacity plan and fails closed for unsupported native entry', async () => {
    const deps = fixtures();
    const first = await maintenance.preflightForHost(host, {
      sourceHostId: SOURCE, goal: 'drain', waveSize: 2, nonMigratablePolicy: 'block',
    }, { database: db, canOperate: true, enabled: true, ...deps });
    const second = await maintenance.preflightForHost(host, {
      sourceHostId: SOURCE, goal: 'drain', waveSize: 2, nonMigratablePolicy: 'block',
    }, { database: db, canOperate: true, enabled: true, ...deps });
    expect(first).toEqual(expect.objectContaining({
      allowed: true, itemCount: 2, readyCount: 2, deferredCount: 0,
      planHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      confirmation: { required: true, mode: 'typed_name', expected: 'pve-a' },
    }));
    expect(first.planHash).toBe(second.planHash);
    expect(first.items.map(item => item.target.id)).toEqual([TARGET_A, TARGET_B]);

    const enter = await maintenance.preflightForHost(host, {
      sourceHostId: SOURCE, goal: 'enter', waveSize: 2, nonMigratablePolicy: 'block',
    }, { database: db, canOperate: true, enabled: true, ...deps });
    expect(enter.allowed).toBe(false);
    expect(enter.blockers.map(item => item.type)).toContain('NATIVE_MAINTENANCE_UNAVAILABLE');
  });

  it('does not claim an empty host when VM placement cannot be proven', async () => {
    const deps = fixtures();
    deps.migrationPreflight.preflightForHost.mockResolvedValue({ sourceTargetId: null, candidates: [] });
    const plan = await maintenance.preflightForHost(host, {
      sourceHostId: SOURCE, goal: 'drain', waveSize: 2, nonMigratablePolicy: 'block',
    }, { database: db, canOperate: true, enabled: true, ...deps });
    expect(plan.allowed).toBe(false);
    expect(plan.blockers.map(item => item.type)).toContain('SOURCE_PLACEMENT_UNKNOWN');
    expect(plan.warnings.map(item => item.type)).not.toContain('HOST_ALREADY_EMPTY');
  });

  it('persists an encrypted idempotent run and rejects a second source reservation', async () => {
    const deps = fixtures(); const provider = native();
    const plan = await maintenance.preflightForHost(host, {
      sourceHostId: SOURCE, goal: 'drain', waveSize: 2, nonMigratablePolicy: 'block',
    }, { database: db, canOperate: true, enabled: true, ...deps });
    const input = { sourceHostId: SOURCE, goal: 'drain', waveSize: 2, nonMigratablePolicy: 'block',
      planHash: plan.planHash, confirm: true, confirmName: 'pve-a', idempotencyKey: 'maintenance-request-one' };
    const first = await maintenance.submitForHost(host, input, {
      database: db, canOperate: true, enabled: true, createdBy: 1, native: provider, ...deps,
    });
    expect(first.run).toEqual(expect.objectContaining({ state: 'draining', waveSize: 2 }));
    expect(first.run.items).toHaveLength(2);
    const stored = db.prepare('SELECT plan_enc, idempotency_key_hash FROM provider_host_maintenance_runs').get();
    expect(stored.plan_enc).not.toContain('app-a');
    expect(stored.idempotency_key_hash).not.toContain('maintenance-request-one');

    await expect(maintenance.submitForHost(host, { ...input, confirm: false }, {
      database: db, native: provider,
    })).rejects.toMatchObject({ code: 'HOST_MAINTENANCE_TYPED_CONFIRMATION_REQUIRED' });
    const duplicate = await maintenance.submitForHost(host, input, { database: db, native: provider });
    expect(duplicate.deduplicated).toBe(true);
    expect(duplicate.run.id).toBe(first.run.id);
    await expect(maintenance.submitForHost(host, { ...input, idempotencyKey: 'maintenance-request-two' }, {
      database: db, canOperate: true, enabled: true, native: provider, ...deps,
    })).rejects.toMatchObject({ code: 'HOST_MAINTENANCE_PREFLIGHT_BLOCKED', status: 409 });
  });

  it('dispatches a bounded wave, reconciles child success and retains a drained reservation until exit', async () => {
    const deps = fixtures(); const provider = native();
    const plan = await maintenance.preflightForHost(host, {
      sourceHostId: SOURCE, goal: 'drain', waveSize: 2, nonMigratablePolicy: 'block',
    }, { database: db, canOperate: true, enabled: true, ...deps });
    const created = await maintenance.submitForHost(host, {
      sourceHostId: SOURCE, goal: 'drain', waveSize: 2, nonMigratablePolicy: 'block',
      planHash: plan.planHash, confirm: true, confirmName: 'pve-a', idempotencyKey: 'maintenance-wave-one',
    }, { database: db, canOperate: true, enabled: true, createdBy: 1, native: provider, ...deps });
    const states = new Map(); let operationNumber = 0;
    const operations = { get: jest.fn(id => ({ id, state: states.get(id) || 'queued' })), requestCancel: jest.fn() };
    const vmMigration = {
      preflightForHost: jest.fn(async (_host, vmId, input) => ({
        sourceTargetId: SOURCE, planHash: 'f'.repeat(64), vm: { id: vmId, displayName: deps.vms.find(vm => vm.id === vmId).displayName }, ...input,
      })),
      submitForHost: jest.fn(async (_host, vmId) => {
        const id = `op_${String(++operationNumber).padStart(26, '0')}`; states.set(id, 'running');
        insertOperation(db, id, vmId);
        return { operation: { id } };
      }),
    };
    let run = await maintenance.reconcileRun(created.run.id, { database: db, operations, vmMigration, native: provider });
    expect(run).toEqual(expect.objectContaining({
      state: 'draining', counts: expect.objectContaining({ submitted: 2 }),
    }));
    expect(vmMigration.submitForHost).toHaveBeenCalledTimes(2);
    for (const item of run.items) states.set(item.operationId, 'succeeded');
    run = await maintenance.reconcileRun(run.id, { database: db, operations, vmMigration, native: provider });
    expect(run.state).toBe('drained');
    expect(maintenance.reservedHostIds(db)).toContain(SOURCE);

    run = await maintenance.exit(run.id, { database: db, operations, vmMigration, native: provider });
    expect(run.state).toBe('completed');
    expect(maintenance.reservedHostIds(db)).not.toContain(SOURCE);
  });

  it('auto-pauses on an unknown child and does not launch another wave', async () => {
    const deps = fixtures(); const provider = native();
    const plan = await maintenance.preflightForHost(host, {
      sourceHostId: SOURCE, goal: 'drain', waveSize: 1, nonMigratablePolicy: 'block',
    }, { database: db, canOperate: true, enabled: true, ...deps });
    const created = await maintenance.submitForHost(host, {
      sourceHostId: SOURCE, goal: 'drain', waveSize: 1, nonMigratablePolicy: 'block',
      planHash: plan.planHash, confirm: true, confirmName: 'pve-a', idempotencyKey: 'maintenance-unknown-one',
    }, { database: db, canOperate: true, enabled: true, native: provider, ...deps });
    let state = 'running';
    let operationNumber = 0;
    const operations = { get: jest.fn(id => ({ id, state })), requestCancel: jest.fn() };
    const vmMigration = {
      preflightForHost: jest.fn(async (_host, vmId) => ({ sourceTargetId: SOURCE, planHash: 'e'.repeat(64), vm: { id: vmId, displayName: 'app-a' } })),
      submitForHost: jest.fn(async (_host, vmId) => {
        const id = `op_${String(++operationNumber).padStart(26, '9')}`; insertOperation(db, id, vmId); return { operation: { id } };
      }),
    };
    let run = await maintenance.reconcileRun(created.run.id, { database: db, operations, vmMigration, native: provider });
    expect(run).toEqual(expect.objectContaining({
      state: 'draining', counts: expect.objectContaining({ submitted: 1 }),
    }));
    state = 'unknown';
    run = await maintenance.reconcileRun(run.id, { database: db, operations, vmMigration, native: provider });
    expect(run.state).toBe('paused');
    expect(run.counts.unknown).toBe(1);
    expect(vmMigration.submitForHost).toHaveBeenCalledTimes(1);
    expect(() => maintenance.resume(run.id, { database: db, operations }))
      .toThrow(expect.objectContaining({ code: 'CHILD_OPERATION_UNRESOLVED', status: 409 }));
    state = 'succeeded';
    run = maintenance.resume(run.id, { database: db, operations });
    expect(run.state).toBe('draining');
    expect(run.counts.succeeded).toBe(1);
    run = await maintenance.reconcileRun(run.id, { database: db, operations, vmMigration, native: provider });
    expect(run.counts.submitted).toBe(1);
    expect(vmMigration.submitForHost).toHaveBeenCalledTimes(2);
  });
});
