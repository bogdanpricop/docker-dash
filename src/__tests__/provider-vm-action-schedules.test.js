'use strict';

jest.mock('../config', () => ({
  security: { encryptionKey: 'vm-action-schedule-test-key-32' },
  features: { providerVmActionSchedules: false, providerVmPower: true, providerVmSnapshots: true },
}));
jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('test must inject database'); }) }));
jest.mock('../services/provider-sdk/registry', () => ({}));
jest.mock('../services/provider-operations/vm-power', () => ({}));
jest.mock('../services/provider-operations/vm-snapshots', () => ({}));
jest.mock('../services/audit', () => ({ log: jest.fn() }));

const Database = require('better-sqlite3');
const operationsMigration = require('../db/migrations/107_provider_operations');
const scheduleMigration = require('../db/migrations/157_provider_vm_action_schedules');
const { sha256 } = require('../utils/crypto');
const { VmActionSchedulesService } = require('../services/provider-operations/vm-action-schedules');

const VM_ID = `ddr_vm_${'a'.repeat(26)}`;
const host = { id: 7, name: 'vcenter-a', daemon_type: 'vsphere', is_active: 1 };
const actor = { id: 9, username: 'admin', role: 'admin' };

function database() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY,username TEXT);
    INSERT INTO users VALUES (9,'admin');
    CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY,name TEXT,daemon_type TEXT,is_active INTEGER);
    INSERT INTO docker_hosts VALUES (7,'vcenter-a','vsphere',1);
    CREATE TABLE governance_scopes (id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES governance_scopes(id));
    CREATE TABLE governance_blackout_windows (
      id INTEGER PRIMARY KEY,name TEXT,scope_id INTEGER,action_pattern TEXT,environment TEXT,
      starts_at TEXT,ends_at TEXT,reason TEXT,allow_emergency_override INTEGER,enabled INTEGER
    );`);
  operationsMigration.up(db); scheduleMigration.up(db); return db;
}

function vm(name = 'web-01') {
  return { id: VM_ID, displayName: name, identity: { stability: 'stable' },
    status: { powerState: 'stopped' }, actions: ['start', 'shutdown', 'reboot', 'snapshot'] };
}

function operation(db, type, action, resourceId, key) {
  const id = `ddop_${String(db.prepare('SELECT COUNT(*) AS c FROM provider_operations').get().c + 1).padStart(26, '0')}`;
  db.prepare(`INSERT INTO provider_operations
    (id,operation_type,provider_type,host_id,resource_kind,resource_id,action,request_hash,request_enc,idempotency_key_hash)
    VALUES (?,?, 'vsphere',7,'virtualMachine',?,?,?,'encrypted',?)`).run(
    id, type, resourceId, action, id, sha256(`7|${type}|${key}`)
  );
  return db.prepare('SELECT * FROM provider_operations WHERE id=?').get(id);
}

function dependencies(db, overrides = {}) {
  const registry = { resourcesForHost: jest.fn().mockResolvedValue({ items: [vm()] }) };
  const power = {
    preflightForHost: jest.fn(async (_host, _vmId, action) => ({ allowed: true, planHash: 'a'.repeat(64),
      resource: { id: VM_ID, displayName: 'web-01' }, action, blockers: [] })),
    submitForHost: jest.fn(async (_host, resourceId, input) => ({ plan: {},
      operation: operation(db, 'vm.power', input.action, resourceId, input.idempotencyKey) })),
  };
  const snapshots = {
    preflightForHost: jest.fn(async (_host, _vmId, _action, input) => ({ allowed: true, planHash: 'b'.repeat(64),
      vm: { id: VM_ID, displayName: 'web-01' }, name: input.name, blockers: [] })),
    submitForHost: jest.fn(async (_host, resourceId, action, input) => ({ plan: {},
      operation: operation(db, 'vm.snapshot', action, resourceId, input.idempotencyKey) })),
  };
  return { registry, power, snapshots, service: new VmActionSchedulesService({
    dbProvider: () => db, registry, power, snapshots, ...overrides,
  }) };
}

async function create(service, input = {}, options = {}) {
  return service.createForHost(host, VM_ID, input, { database: options.database, createdBy: actor.id,
    executeEnabled: options.executeEnabled });
}

describe('B045 scheduled VM actions', () => {
  let db; let service; let registry; let power; let snapshots;
  beforeEach(() => {
    db = database(); ({ service, registry, power, snapshots } = dependencies(db));
  });
  afterEach(() => db.close());

  test('creates disabled dry-run defaults and requires release plus typed authorization for execute', async () => {
    const saved = await create(service);
    expect(saved).toEqual(expect.objectContaining({ enabled: false, mode: 'dry_run', action: 'start',
      cron: '0 7 * * 1-5', timezone: 'UTC', dstPolicy: 'first', version: 1 }));
    await expect(create(service, { name: 'execute-start', enabled: true, mode: 'execute',
      confirm: true, confirmName: 'web-01' })).rejects.toMatchObject({ code: 'VM_ACTION_SCHEDULE_EXECUTION_DISABLED' });
    await expect(create(service, { name: 'execute-start', enabled: true, mode: 'execute',
      confirm: true, confirmName: 'wrong' }, { executeEnabled: true }))
      .rejects.toMatchObject({ code: 'VM_ACTION_SCHEDULE_TYPED_CONFIRMATION_REQUIRED' });
  });

  test('records one dry-run for a local due slot and never submits a provider operation', async () => {
    const saved = await create(service, { enabled: true, cron: '0 9 * * *', timezone: 'Europe/Bucharest' });
    const now = new Date('2026-07-30T06:00:00.000Z');
    const first = await service.runDue({ database: db, now });
    const duplicate = await service.runDue({ database: db, now });
    expect(first.started).toHaveLength(1);
    expect(first.started[0]).toEqual(expect.objectContaining({ state: 'previewed', decision: 'preview_allowed',
      localTime: '2026-07-30T09:00' }));
    expect(duplicate.started).toHaveLength(0);
    expect(service.listRuns(saved.id, { database: db })).toHaveLength(1);
    expect(power.submitForHost).not.toHaveBeenCalled();
    expect(snapshots.submitForHost).not.toHaveBeenCalled();
  });

  test('selects first/second DST occurrences and records ambiguous skip only once', async () => {
    const first = await create(service, { name: 'first', enabled: true, cron: '30 2 * * *',
      timezone: 'Europe/Berlin', dstPolicy: 'first' });
    const second = await create(service, { name: 'second', enabled: true, cron: '30 2 * * *',
      timezone: 'Europe/Berlin', dstPolicy: 'second' });
    const skip = await create(service, { name: 'skip', enabled: true, cron: '30 2 * * *',
      timezone: 'Europe/Berlin', dstPolicy: 'skip' });
    await service.runDue({ database: db, now: new Date('2026-10-25T00:30:00Z') });
    await service.runDue({ database: db, now: new Date('2026-10-25T01:30:00Z') });
    expect(service.listRuns(first.id, { database: db })).toEqual([expect.objectContaining({ state: 'previewed', dstOccurrence: 1 })]);
    expect(service.listRuns(second.id, { database: db })).toEqual([expect.objectContaining({ state: 'previewed', dstOccurrence: 2 })]);
    expect(service.listRuns(skip.id, { database: db })).toEqual([expect.objectContaining({ state: 'skipped',
      reason: expect.objectContaining({ code: 'DST_AMBIGUOUS_SKIPPED' }) })]);
  });

  test('records matching nonexistent minutes during a forward DST jump without shifting execution', async () => {
    const saved = await create(service, { enabled: true, cron: '30 2 * * *', timezone: 'Europe/Berlin' });
    const result = await service.runDue({ database: db, now: new Date('2026-03-29T01:00:00Z') });
    expect(result.started).toContainEqual(expect.objectContaining({ state: 'skipped', localTime: '2026-03-29T02:30',
      reason: expect.objectContaining({ code: 'DST_NONEXISTENT' }) }));
    expect(power.preflightForHost).not.toHaveBeenCalled();
    expect(service.listRuns(saved.id, { database: db })).toHaveLength(1);
  });

  test('suppresses local holidays and governance blackouts without emergency override', async () => {
    const holiday = await create(service, { name: 'holiday', enabled: true, cron: '0 8 * * *', holidays: ['2026-07-30'] });
    const frozen = await create(service, { name: 'frozen', enabled: true, action: 'reboot', cron: '0 8 * * *' });
    db.prepare(`INSERT INTO governance_blackout_windows
      (id,name,scope_id,action_pattern,environment,starts_at,ends_at,reason,allow_emergency_override,enabled)
      VALUES (1,'freeze',NULL,'provider.vm.schedule.reboot','production','2026-07-30T07:00:00Z','2026-07-30T09:00:00Z','Change freeze',1,1)`).run();
    await service.runDue({ database: db, now: new Date('2026-07-30T08:00:00Z') });
    expect(service.listRuns(holiday.id, { database: db })[0].reason.code).toBe('HOLIDAY');
    expect(service.listRuns(frozen.id, { database: db })[0]).toEqual(expect.objectContaining({ state: 'skipped',
      reason: { code: 'GOVERNANCE_BLACKOUT', message: 'Change freeze' }, plan: { blackout: expect.objectContaining({ emergencyOverrideUsed: false }) } }));
    expect(power.submitForHost).not.toHaveBeenCalled();
  });

  test('dispatches through operation core once and reconciles the durable child outcome', async () => {
    const saved = await create(service, { enabled: true, mode: 'execute', cron: '0 8 * * *',
      confirm: true, confirmName: 'web-01' }, { executeEnabled: true });
    const now = new Date('2026-07-30T08:00:00Z');
    const result = await service.runDue({ database: db, now, executeEnabled: true });
    expect(result.started[0]).toEqual(expect.objectContaining({ state: 'queued', operationId: expect.any(String) }));
    await service.runDue({ database: db, now, executeEnabled: true });
    expect(power.submitForHost).toHaveBeenCalledTimes(1);
    db.prepare("UPDATE provider_operations SET state='succeeded',completed_at=datetime('now') WHERE id=?")
      .run(result.started[0].operationId);
    await service.reconcilePending({ database: db, now: new Date('2026-07-30T08:01:00Z') });
    expect(service.listRuns(saved.id, { database: db })[0].state).toBe('succeeded');
    expect(service.listForVm(7, VM_ID, { database: db })[0].consecutiveFailures).toBe(0);
  });

  test('holds an unknown outcome and skips later slots instead of retrying the mutation', async () => {
    const saved = await create(service, { enabled: true, mode: 'execute', cron: '* * * * *', failureThreshold: 2,
      confirm: true, confirmName: 'web-01' }, { executeEnabled: true });
    const first = await service.runDue({ database: db, now: new Date('2026-07-30T08:00:00Z'), executeEnabled: true });
    db.prepare("UPDATE provider_operations SET state='unknown' WHERE id=?").run(first.started[0].operationId);
    const next = await service.runDue({ database: db, now: new Date('2026-07-30T08:01:00Z'), executeEnabled: true });
    expect(next.reconciled).toContainEqual(expect.objectContaining({ state: 'unknown' }));
    expect(next.started).toContainEqual(expect.objectContaining({ state: 'skipped',
      reason: expect.objectContaining({ code: 'ACTIVE_RUN' }) }));
    expect(service.listForVm(7, VM_ID, { database: db })[0]).toEqual(expect.objectContaining({ enabled: true, consecutiveFailures: 1 }));
    expect(service.removeForVm.bind(service, 7, VM_ID, saved.id, { database: db }))
      .toThrow(expect.objectContaining({ code: 'VM_ACTION_SCHEDULE_RUN_ACTIVE' }));
  });

  test('automatically disables an execute schedule at its consecutive failure threshold', async () => {
    const saved = await create(service, { enabled: true, mode: 'execute', cron: '0 8 * * *', failureThreshold: 1,
      confirm: true, confirmName: 'web-01' }, { executeEnabled: true });
    power.preflightForHost.mockRejectedValueOnce(Object.assign(new Error('provider unavailable'), { code: 'PROVIDER_UNAVAILABLE' }));
    const result = await service.runDue({ database: db, now: new Date('2026-07-30T08:00:00Z'), executeEnabled: true });
    expect(result.started[0]).toEqual(expect.objectContaining({ state: 'blocked',
      reason: expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE' }) }));
    expect(service.listForVm(7, VM_ID, { database: db })[0]).toEqual(expect.objectContaining({
      id: saved.id, enabled: false, consecutiveFailures: 1,
    }));
  });

  test('enforces optimistic versions and blocks target-changing active edits', async () => {
    const saved = await create(service, { name: 'versioned' });
    const updated = await service.updateForHost(host, VM_ID, saved.id, { version: 1, name: 'versioned-2' }, { database: db, createdBy: actor.id });
    expect(updated.version).toBe(2);
    await expect(service.updateForHost(host, VM_ID, saved.id, { version: 1, name: 'stale' }, { database: db, createdBy: actor.id }))
      .rejects.toMatchObject({ code: 'VM_ACTION_SCHEDULE_VERSION_CONFLICT' });
    expect(registry.resourcesForHost).toHaveBeenCalled();
  });
});
