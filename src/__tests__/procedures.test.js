'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-dash-procedures-'));
process.env.APP_SECRET = 'procedures-test-secret';
process.env.ENCRYPTION_KEY = 'procedures-test-key-32-characters';
process.env.DB_PATH = ':memory:';
process.env.DATA_DIR = testDataDir;

const { getDb, closeDb } = require('../db');
const procedures = require('../services/procedures');

let adminId;
let operatorId;
let sequence = 0;
const HOST_ID = 6201;

function makeProcedure(steps, overrides = {}) {
  sequence += 1;
  return procedures.create({
    name: `procedure-${sequence}`,
    description: 'test procedure',
    steps,
    created_by: adminId,
    ...overrides,
  });
}

const waitStep = (seconds = 0, onError = 'stop') => ({
  action_type: 'wait_seconds', action_config: { seconds }, on_error: onError,
});

beforeAll(() => {
  const db = getDb();
  adminId = Number(db.prepare(
    "INSERT INTO users (username, password_hash, role) VALUES ('procedure-admin', 'hash', 'admin')"
  ).run().lastInsertRowid);
  operatorId = Number(db.prepare(
    "INSERT INTO users (username, password_hash, role) VALUES ('procedure-operator', 'hash', 'operator')"
  ).run().lastInsertRowid);
  db.prepare(`
    INSERT INTO docker_hosts
      (id, name, connection_type, host, port, daemon_type, is_active)
    VALUES (?, 'Procedure Host', 'tcp', '127.0.0.1', 26201, 'docker', 1)
  `).run(HOST_ID);
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
  await Promise.allSettled([...procedures._runPromises.values()]);
  closeDb();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

describe('procedure validation and CRUD', () => {
  it('creates, reads, updates, and deletes ordered procedures', () => {
    const procedure = makeProcedure([waitStep(1)]);
    expect(procedure.steps).toEqual([expect.objectContaining(waitStep(1))]);
    expect(procedure.steps[0]).toMatchObject({ id: 'step-1', stage: 1, needs: [], enabled: true });
    expect(procedure.max_parallel).toBe(4);
    expect(procedures.list().map(item => item.id)).toContain(procedure.id);

    const updated = procedures.update(procedure.id, {
      description: 'updated', steps: [waitStep(2), waitStep(0, 'continue')],
    });
    expect(updated.description).toBe('updated');
    expect(updated.steps).toHaveLength(2);

    procedures.delete(procedure.id);
    expect(procedures.get(procedure.id)).toBeNull();
  });

  it('rejects empty, oversized, unknown, and malformed steps', () => {
    expect(() => procedures.validateSteps([])).toThrow('At least one');
    expect(() => procedures.validateSteps(Array.from({ length: 51 }, () => waitStep())))
      .toThrow('at most 50');
    expect(() => procedures.validateSteps([{ action_type: 'shell', action_config: {} }]))
      .toThrow('unsupported');
    expect(() => procedures.validateSteps([{ action_type: 'wait_seconds', action_config: { seconds: 3601 } }]))
      .toThrow('between 0 and 3600');
    expect(() => procedures.validateSteps([{
      action_type: 'restart_container', target_host_id: HOST_ID, action_config: {},
    }])).toThrow('container ID/name');
    expect(() => procedures.validateSteps([
      { ...waitStep(), id: 'duplicate', stage: 1 },
      { ...waitStep(), id: 'duplicate', stage: 1 },
    ])).toThrow('duplicate step ID');
    expect(() => procedures.validateSteps([
      { ...waitStep(), id: 'first', stage: 1, needs: ['missing'] },
    ])).toThrow('does not exist');
    expect(() => procedures.validateSteps([
      { ...waitStep(), id: 'first', stage: 1, needs: ['second'] },
      { ...waitStep(), id: 'second', stage: 1, needs: ['first'] },
    ])).toThrow('cycle');
    expect(() => makeProcedure([waitStep()], { max_parallel: 11 })).toThrow('between 1 and 10');
  });

  it('ships configurable sample procedure templates', () => {
    expect(procedures.getTemplates().map(template => template.name)).toEqual([
      'Blue/green deploy', 'Roll all containers', 'Emergency stop stack',
    ]);
  });
});

describe('procedure runner', () => {
  it('executes steps strictly in serial order and records live logs', async () => {
    const procedure = makeProcedure([waitStep(), waitStep(), waitStep()]);
    const order = [];
    let stepIndex = 0;
    jest.spyOn(procedures, '_executeStep').mockImplementation(async (_runId, _procedure, _step, _actor) => {
      const index = stepIndex++;
      order.push(`start-${index}`);
      await Promise.resolve();
      order.push(`end-${index}`);
      return `done-${index}`;
    });

    const started = procedures.run(procedure.id, {
      userId: adminId, username: 'procedure-admin', isAdmin: true,
    });
    const run = await procedures.waitForRun(started.id);

    expect(order).toEqual(['start-0', 'end-0', 'start-1', 'end-1', 'start-2', 'end-2']);
    expect(run.status).toBe('success');
    expect(run.current_step).toBe(3);
    expect(run.logs.filter(entry => entry.status === 'success')).toHaveLength(3);
  });

  it('stops at the first failure when on_error is stop', async () => {
    const procedure = makeProcedure([waitStep(), waitStep(), waitStep()]);
    let calls = 0;
    jest.spyOn(procedures, '_executeStep').mockImplementation(async () => {
      calls += 1;
      if (calls === 2) throw new Error('step exploded');
      return 'ok';
    });

    const run = procedures.run(procedure.id, { userId: adminId, isAdmin: true });
    const finished = await procedures.waitForRun(run.id);
    expect(calls).toBe(2);
    expect(finished.status).toBe('failed');
    expect(finished.error).toBe('step exploded');
  });

  it('continues after configured failures and marks the run partial', async () => {
    const procedure = makeProcedure([waitStep(0, 'continue'), waitStep()]);
    let calls = 0;
    jest.spyOn(procedures, '_executeStep').mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error('allowed failure');
      return 'recovered';
    });

    const run = procedures.run(procedure.id, { userId: adminId, isAdmin: true });
    const finished = await procedures.waitForRun(run.id);
    expect(calls).toBe(2);
    expect(finished.status).toBe('partial');
  });

  it('runs independent steps in the same stage concurrently with a bounded limit', async () => {
    const steps = Array.from({ length: 4 }, (_, index) => ({
      ...waitStep(), id: `parallel-${index + 1}`, stage: 1,
    }));
    const procedure = makeProcedure(steps, { max_parallel: 2 });
    let active = 0;
    let maxActive = 0;
    jest.spyOn(procedures, '_executeStep').mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 15));
      active--;
      return 'parallel done';
    });

    const run = procedures.run(procedure.id, { userId: adminId, isAdmin: true });
    const finished = await procedures.waitForRun(run.id);
    expect(finished.status).toBe('success');
    expect(maxActive).toBe(2);
    expect(finished.step_results.every(result => result.status === 'success')).toBe(true);
    expect(finished.current_stage).toBe(1);
  });

  it('skips a dependent step after a continued failure but runs independent work', async () => {
    const procedure = makeProcedure([
      { ...waitStep(0, 'continue'), id: 'prepare', stage: 1 },
      { ...waitStep(), id: 'dependent', stage: 2, needs: ['prepare'] },
      { ...waitStep(), id: 'independent', stage: 2 },
    ], { max_parallel: 3 });
    const executed = [];
    jest.spyOn(procedures, '_executeStep').mockImplementation(async (_runId, _procedure, step) => {
      executed.push(step.id);
      if (step.id === 'prepare') throw new Error('prepare failed');
      return 'ok';
    });

    const run = procedures.run(procedure.id, { userId: adminId, isAdmin: true });
    const finished = await procedures.waitForRun(run.id);
    expect(finished.status).toBe('partial');
    expect(executed).toEqual(['prepare', 'independent']);
    expect(finished.step_results.find(result => result.id === 'dependent').status).toBe('skipped');
  });

  it('cancels a cooperative wait and skips remaining steps', async () => {
    const procedure = makeProcedure([waitStep(2), waitStep()]);
    const run = procedures.run(procedure.id, { userId: adminId, username: 'procedure-admin', isAdmin: true });
    await new Promise(resolve => setTimeout(resolve, 30));
    procedures.cancel(run.id, { userId: adminId, username: 'procedure-admin' });
    const finished = await procedures.waitForRun(run.id);
    expect(finished.status).toBe('cancelled');
    expect(finished.current_step).toBe(1);
    expect(finished.logs.some(entry => entry.status === 'cancelled')).toBe(true);
  });

  it('prevents a second concurrent run of the same procedure', async () => {
    const procedure = makeProcedure([waitStep(1)]);
    const run = procedures.run(procedure.id, { userId: adminId, isAdmin: true });
    expect(() => procedures.run(procedure.id, { userId: adminId, isAdmin: true }))
      .toThrow('already running');
    procedures.cancel(run.id, { userId: adminId });
    await procedures.waitForRun(run.id);
  });

  it('enforces per-host operate access for operators', async () => {
    getDb().prepare(`
      INSERT INTO settings (key, value) VALUES ('legacy_host_access_default', 'false')
      ON CONFLICT(key) DO UPDATE SET value = 'false'
    `).run();
    const procedure = makeProcedure([{
      action_type: 'restart_container', target_host_id: HOST_ID,
      action_config: { container_id: 'web' }, on_error: 'stop',
    }]);
    expect(() => procedures.run(procedure.id, {
      userId: operatorId, username: 'procedure-operator', isAdmin: false,
    })).toThrow('Insufficient operate access');

    getDb().prepare(`
      INSERT INTO host_permissions (user_id, host_id, permission, granted_by)
      VALUES (?, ?, 'operate', ?)
    `).run(operatorId, HOST_ID, adminId);
    jest.spyOn(procedures, '_executeStep').mockResolvedValue('restarted');
    const run = procedures.run(procedure.id, {
      userId: operatorId, username: 'procedure-operator', isAdmin: false,
    });
    expect((await procedures.waitForRun(run.id)).status).toBe('success');
  });

  it('writes start and completion entries to the audit trail', async () => {
    const procedure = makeProcedure([waitStep()]);
    const run = procedures.run(procedure.id, {
      userId: adminId, username: 'procedure-admin', isAdmin: true,
    });
    await procedures.waitForRun(run.id);
    const actions = getDb().prepare(
      "SELECT action FROM audit_log WHERE target_type = 'procedure_run' AND target_id = ? ORDER BY id"
    ).all(String(run.id)).map(row => row.action);
    expect(actions).toEqual(['procedure_run_start', 'procedure_run_complete']);
  });
});
