'use strict';

jest.mock('../config', () => ({
  app: { env: 'test' },
  features: { readOnly: false },
  security: { encryptionKey: 'provider-operation-engine-test-key' },
}));
jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('test must inject a database'); }) }));

const Database = require('better-sqlite3');
const migration = require('../db/migrations/107_provider_operations');
const { OperationPolicyService } = require('../services/provider-operations/policy');
const { ProviderOperationEngine } = require('../services/provider-operations/engine');

const RESOURCE_ID = `ddr_vm_${'a'.repeat(26)}`;

function createDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
    CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY, daemon_type TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1);
    INSERT INTO users (id, username) VALUES (1, 'admin');
    INSERT INTO docker_hosts (id, daemon_type, is_active) VALUES (7, 'xen', 1);
  `);
  migration.up(db);
  return db;
}

function createEngine(db, options = {}) {
  const policy = new OperationPolicyService(() => db);
  return new ProviderOperationEngine({
    dbProvider: () => db, policy, concurrency: options.concurrency || 4,
    owner: options.owner || 'worker-test', pollMs: 100, leaseMs: 1000,
  });
}

function spec(overrides = {}) {
  return {
    type: 'vm.power.test', providerType: 'xen', hostId: 7,
    resourceKind: 'virtualMachine', resourceId: RESOURCE_ID, action: 'test',
    idempotencyKey: `request-${Math.random().toString(16).slice(2)}`,
    request: { confirmation: true, password: 'encrypted-only' }, createdBy: 1,
    ...overrides,
  };
}

describe('Durable provider operation engine', () => {
  let db;
  beforeEach(() => { db = createDb(); });
  afterEach(() => db.close());

  it('persists encrypted requests, deduplicates idempotency keys and emits safe events', async () => {
    const engine = createEngine(db);
    engine.registerHandler({
      type: 'vm.power.test', idempotent: true,
      execute: async ctx => {
        ctx.reportProgress(40, 'provider-call', 'Calling provider', { token: 'must-drop', safe: true });
        ctx.bindNativeTask('OpaqueRef:native-secret', 'pending');
        return { state: 'succeeded', result: { ok: true, password: 'must-drop' } };
      },
    });
    const input = spec({ idempotencyKey: 'same-request-key' });
    const first = engine.create(input);
    const duplicate = engine.create(input);
    expect(duplicate.id).toBe(first.id);
    expect(duplicate.deduplicated).toBe(true);
    const storedBefore = db.prepare('SELECT * FROM provider_operations WHERE id = ?').get(first.id);
    expect(storedBefore.request_enc).not.toContain('encrypted-only');
    expect(storedBefore.idempotency_key_hash).not.toContain('same-request-key');
    await engine.tick();
    const completed = engine.get(first.id);
    expect(completed).toEqual(expect.objectContaining({ state: 'succeeded', progress: 100, hasNativeTask: true }));
    expect(completed.result).toEqual({ ok: true });
    expect(JSON.stringify(completed)).not.toContain('OpaqueRef:');
    const storedAfter = db.prepare('SELECT native_task_ref_enc FROM provider_operations WHERE id = ?').get(first.id);
    expect(storedAfter.native_task_ref_enc).not.toContain('native-secret');
    expect(JSON.stringify(engine.events(first.id))).not.toContain('must-drop');
    expect(() => engine.create({ ...input, request: { confirmation: false } }))
      .toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_CONFLICT', status: 409 }));
  });

  it('serializes operations that need the same resource lock', async () => {
    const engine = createEngine(db, { owner: 'lock-holder-worker', concurrency: 1 });
    const waiter = createEngine(db, { owner: 'lock-waiter-worker', concurrency: 1 });
    let release;
    let started;
    const startedPromise = new Promise(resolve => { started = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const handler = {
      type: 'vm.power.test', idempotent: true,
      execute: async ctx => {
        if (ctx.request.hold) { started(); await held; }
        return { result: { ok: true } };
      },
    };
    engine.registerHandler(handler);
    waiter.registerHandler(handler);
    const first = engine.create(spec({ idempotencyKey: 'lock-holder-1', request: { hold: true } }));
    const tickPromise = engine.tick();
    await startedPromise;
    const second = engine.create(spec({ idempotencyKey: 'lock-waiter-2', request: { hold: false } }));
    await waiter.tick();
    expect(engine.get(first.id).state).toBe('running');
    expect(engine.get(second.id).state).toBe('queued');
    expect(db.prepare('SELECT COUNT(*) AS count FROM provider_operation_locks').get().count).toBe(1);
    release();
    await tickPromise;
    db.prepare("UPDATE provider_operations SET available_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(second.id);
    await waiter.tick();
    expect(engine.get(second.id).state).toBe('succeeded');
  });

  it('retries only transient failures for idempotent handlers', async () => {
    const engine = createEngine(db);
    let calls = 0;
    engine.registerHandler({
      type: 'vm.power.test', idempotent: true, retryPolicy: 'transient',
      execute: async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('socket secret'), { code: 'ECONNRESET', transient: true });
        return { result: { ok: true } };
      },
    });
    const operation = engine.create(spec({ idempotencyKey: 'transient-retry-key' }));
    await engine.tick();
    expect(engine.get(operation.id)).toEqual(expect.objectContaining({ state: 'waiting_retry', attempt: 1 }));
    expect(engine.get(operation.id).error.message).not.toContain('socket secret');
    db.prepare("UPDATE provider_operations SET available_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(operation.id);
    await engine.tick();
    expect(engine.get(operation.id)).toEqual(expect.objectContaining({ state: 'succeeded', attempt: 2 }));
  });

  it('recovers expired running work through reconciliation instead of execute', async () => {
    const creator = createEngine(db, { owner: 'worker-old' });
    creator.registerHandler({ type: 'vm.power.test', idempotent: true, execute: async () => ({ result: { old: true } }) });
    const operation = creator.create(spec({ idempotencyKey: 'restart-reconcile-key' }));
    db.prepare(`UPDATE provider_operations SET state = 'running', attempt = 1,
      lease_owner = 'dead-worker', lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(operation.id);

    const recovered = createEngine(db, { owner: 'worker-new' });
    const execute = jest.fn();
    const reconcile = jest.fn().mockResolvedValue({ state: 'succeeded', result: { observed: 'done' } });
    recovered.registerHandler({ type: 'vm.power.test', idempotent: true, execute, reconcile });
    expect(recovered.recoverExpired()).toBe(1);
    expect(recovered.get(operation.id).state).toBe('reconciling');
    await recovered.tick();
    expect(execute).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(recovered.get(operation.id).state).toBe('succeeded');
  });

  it('allows only one of two worker owners to claim the same operation', async () => {
    const firstWorker = createEngine(db, { owner: 'worker-a' });
    const secondWorker = createEngine(db, { owner: 'worker-b' });
    const execute = jest.fn().mockResolvedValue({ result: { once: true } });
    firstWorker.registerHandler({ type: 'vm.power.test', idempotent: true, execute });
    secondWorker.registerHandler({ type: 'vm.power.test', idempotent: true, execute });
    const operation = firstWorker.create(spec({ idempotencyKey: 'two-worker-claim' }));
    await Promise.all([firstWorker.tick(), secondWorker.tick()]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(firstWorker.get(operation.id).state).toBe('succeeded');
  });

  it('uses confirmed cancellation and holds unconfirmed outcomes as unknown', async () => {
    const engine = createEngine(db);
    const started = [];
    engine.registerHandler({
      type: 'vm.power.test', idempotent: true,
      execute: ctx => new Promise(resolve => { started.push({ resolve, signal: ctx.signal }); }),
      cancel: async ctx => ({ confirmed: ctx.request.confirmCancel === true }),
    });
    const confirmed = engine.create(spec({ idempotencyKey: 'cancel-confirmed', request: { confirmCancel: true } }));
    const firstTick = engine.tick();
    while (!started.length) await new Promise(resolve => setImmediate(resolve));
    engine.requestCancel(confirmed.id);
    await firstTick;
    expect(engine.get(confirmed.id).state).toBe('cancelled');

    const unconfirmed = engine.create(spec({ idempotencyKey: 'cancel-unknown', request: { confirmCancel: false } }));
    const secondTick = engine.tick();
    while (started.length < 2) await new Promise(resolve => setImmediate(resolve));
    engine.requestCancel(unconfirmed.id);
    await secondTick;
    expect(engine.get(unconfirmed.id).state).toBe('unknown');
    expect(db.prepare('SELECT COUNT(*) AS count FROM provider_operation_locks WHERE operation_id = ?').get(unconfirmed.id).count).toBe(1);
    db.prepare('DELETE FROM provider_operation_locks WHERE operation_id = ?').run(unconfirmed.id);
    const restarted = createEngine(db, { owner: 'unknown-lock-recovery' });
    restarted.recoverExpired();
    expect(db.prepare('SELECT COUNT(*) AS count FROM provider_operation_locks WHERE operation_id = ?').get(unconfirmed.id).count).toBe(1);
    expect(engine.resolveUnknown(unconfirmed.id, 'cancelled', 'Verified in native provider console', 1).state).toBe('cancelled');
    expect(db.prepare('SELECT COUNT(*) AS count FROM provider_operation_locks WHERE operation_id = ?').get(unconfirmed.id).count).toBe(0);
  });

  it('moves a timed-out mutation to reconciliation when supported', async () => {
    const engine = createEngine(db);
    engine.registerHandler({
      type: 'vm.power.test', idempotent: true, timeoutSeconds: 1,
      execute: () => new Promise(() => {}),
      reconcile: async () => ({ state: 'succeeded', result: { observed: true } }),
    });
    const operation = engine.create(spec({ idempotencyKey: 'timeout-reconcile-key' }));
    await engine.tick();
    expect(engine.get(operation.id)).toEqual(expect.objectContaining({ state: 'reconciling' }));
    db.prepare("UPDATE provider_operations SET available_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(operation.id);
    await engine.tick();
    expect(engine.get(operation.id).state).toBe('succeeded');
  });

  it('starts and stops one unref worker timer symmetrically', () => {
    const engine = createEngine(db);
    engine.registerHandler({ type: 'vm.power.test', idempotent: true, execute: async () => ({}) });
    expect(engine.start()).toBe(true);
    expect(engine.start()).toBe(false);
    expect(engine.stop()).toBe(true);
    expect(engine._timer).toBeNull();
  });
});
