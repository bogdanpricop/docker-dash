'use strict';

jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('test must inject database'); }) }));
jest.mock('../services/provider-operations/provision-provider', () => ({
  open: jest.fn(), close: jest.fn(), submit: jest.fn(), taskStatus: jest.fn(),
  taskResultRef: jest.fn(), provision: jest.fn(), provisionState: jest.fn(),
  findByName: jest.fn(), cancelTask: jest.fn(),
}));

const handler = require('../services/provider-operations/handlers/vm-provision');
const bridge = require('../services/provider-operations/provision-provider');

const ARTIFACT_ID = `dda_art_${'a'.repeat(26)}`;
const host = { id: 7, daemon_type: 'xen', is_active: 1 };
const target = { host, artifactId: ARTIFACT_ID, client: { provider: 'xapi' } };

function database() { return { prepare: () => ({ get: () => host }) }; }
function operation() {
  return {
    id: `op_${'c'.repeat(26)}`, provider: { type: 'xen', endpointId: 7 },
    resource: { id: ARTIFACT_ID, kind: 'artifact' }, action: 'clone',
    createdAt: new Date().toISOString(), startedAt: new Date().toISOString(),
  };
}
function context(nativeTaskRef = null) {
  return {
    operation: operation(), request: { name: 'app-01', mode: 'linked', storageId: null },
    nativeTaskRef, reportProgress: jest.fn(), bindNativeTask: jest.fn(),
  };
}

describe('durable create-from-template handler', () => {
  beforeEach(() => {
    jest.clearAllMocks(); bridge.open.mockResolvedValue(target); bridge.close.mockResolvedValue();
    bridge.findByName.mockResolvedValue(null);
  });

  it('submits exactly one clone and returns an encrypted-task envelope to the engine', async () => {
    bridge.submit.mockResolvedValue({ taskRef: 'OpaqueRef:clone-task', provider: 'xapi' });
    const result = await handler.execute(context(), { database: database() });
    expect(bridge.submit).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({
      state: 'reconciling', phase: 'clone-task', nativeTaskState: 'pending', nativeTaskRef: expect.any(String),
    }));
    expect(handler._internals._parseTask(result.nativeTaskRef, 'xen')).toEqual({
      provider: 'xen', ref: 'OpaqueRef:clone-task', stage: 'clone',
    });
  });

  it('advances a completed XAPI clone to a persisted pre-submit checkpoint', async () => {
    const cloneTask = handler._internals._taskRef('xen', { taskRef: 'OpaqueRef:clone-task' }, 'clone');
    bridge.taskStatus.mockResolvedValue({ status: 'success', result: '<value>OpaqueRef:cloned-vm</value>' });
    bridge.taskResultRef.mockReturnValue('OpaqueRef:cloned-vm');
    const ctx = context(cloneTask);
    const result = await handler.reconcile(ctx, { database: database() });
    expect(bridge.provision).not.toHaveBeenCalled();
    expect(ctx.bindNativeTask).toHaveBeenCalledWith(expect.any(String), 'ready');
    expect(handler._internals._parseTask(ctx.bindNativeTask.mock.calls[0][0], 'xen'))
      .toEqual({ provider: 'xen', ref: 'OpaqueRef:cloned-vm', stage: 'provision-ready' });
    expect(result).toEqual(expect.objectContaining({ state: 'reconciling', phase: 'provision-ready' }));
  });

  it('checkpoints provision submission before calling XAPI and then binds its task', async () => {
    const ready = handler._internals._taskRef('xen', { taskRef: 'OpaqueRef:cloned-vm' }, 'provision-ready');
    bridge.provision.mockResolvedValue({ taskRef: 'OpaqueRef:provision-task' });
    const ctx = context(ready);
    const result = await handler.reconcile(ctx, { database: database() });
    expect(ctx.bindNativeTask).toHaveBeenNthCalledWith(1, expect.any(String), 'submitting');
    expect(handler._internals._parseTask(ctx.bindNativeTask.mock.calls[0][0], 'xen'))
      .toEqual({ provider: 'xen', ref: 'OpaqueRef:cloned-vm', stage: 'provision-submit' });
    expect(bridge.provision).toHaveBeenCalledWith(target, 'OpaqueRef:cloned-vm');
    expect(ctx.bindNativeTask).toHaveBeenNthCalledWith(2, expect.any(String), 'pending');
    expect(result).toEqual(expect.objectContaining({ state: 'reconciling', phase: 'provision-task' }));
  });

  it('recovers an interrupted provision submit from VM current_operations without replay', async () => {
    const submitting = handler._internals._taskRef('xen', { taskRef: 'OpaqueRef:cloned-vm' }, 'provision-submit');
    bridge.provisionState.mockResolvedValue({ state: 'running', taskRef: 'OpaqueRef:recovered-task' });
    const ctx = context(submitting);
    const result = await handler.reconcile(ctx, { database: database() });
    expect(bridge.provision).not.toHaveBeenCalled();
    expect(handler._internals._parseTask(ctx.bindNativeTask.mock.calls[0][0], 'xen'))
      .toEqual({ provider: 'xen', ref: 'OpaqueRef:recovered-task', stage: 'provision' });
    expect(result).toEqual(expect.objectContaining({ state: 'reconciling', phase: 'provision-task' }));
  });

  it('verifies provider inventory after the provision task succeeds', async () => {
    const provisionTask = handler._internals._taskRef('xen', { taskRef: 'OpaqueRef:provision-task' }, 'provision');
    bridge.taskStatus.mockResolvedValue({ status: 'success' });
    bridge.findByName.mockResolvedValue({ resource: {
      id: `ddr_vm_${'d'.repeat(26)}`, displayName: 'app-01', status: { powerState: 'poweredOff' },
    } });
    const result = await handler.reconcile(context(provisionTask), { database: database() });
    expect(result).toEqual(expect.objectContaining({
      state: 'succeeded', phase: 'verified',
      result: expect.objectContaining({ vm: expect.objectContaining({ displayName: 'app-01' }), verified: true }),
    }));
  });
});
