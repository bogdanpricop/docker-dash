'use strict';

const mockPreflight = jest.fn();
const mockProvider = {
  open: jest.fn(), close: jest.fn(), readVm: jest.fn(), isOnTarget: jest.fn(),
  powerState: jest.fn(), revalidateTarget: jest.fn(), submit: jest.fn(), taskRef: jest.fn(), parseTask: jest.fn(),
  taskStatus: jest.fn(), taskOutcome: jest.fn(), cancel: jest.fn(),
};

jest.mock('../services/provider-sdk/vm-migration-preflight', () => ({
  preflightForHost: (...args) => mockPreflight(...args),
}));
jest.mock('../services/provider-operations/migration-provider', () => mockProvider);

const handler = require('../services/provider-operations/handlers/vm-migration');

const VM_ID = `ddr_vm_${'a'.repeat(26)}`;
const SOURCE_ID = `ddr_host_${'b'.repeat(26)}`;
const TARGET_ID = `ddr_host_${'c'.repeat(26)}`;
const target = { host: { id: 7, daemon_type: 'proxmox' }, client: {} };
const request = { targetId: TARGET_ID, sourceTargetId: SOURCE_ID, mode: 'live', expectedPowerState: 'running' };
const operation = {
  id: `op_${'d'.repeat(26)}`, provider: { type: 'proxmox', endpointId: 7 },
  resource: { id: VM_ID, kind: 'virtualMachine' }, action: 'live',
  createdAt: new Date().toISOString(), startedAt: new Date().toISOString(),
};

describe('durable native VM migration handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockProvider.open.mockResolvedValue(target);
    mockProvider.close.mockResolvedValue();
    mockProvider.readVm.mockResolvedValue({ node: 'pve-a', status: 'running' });
    mockProvider.isOnTarget.mockReturnValue(false);
    mockProvider.powerState.mockReturnValue('running');
    mockProvider.revalidateTarget.mockResolvedValue({ ready: true });
    mockPreflight.mockResolvedValue({
      sourceTargetId: SOURCE_ID,
      candidates: [{ target: { id: TARGET_ID }, modes: { live: { state: 'ready' } } }],
    });
  });

  it('revalidates and submits exactly one native task', async () => {
    mockProvider.submit.mockResolvedValue({ taskRef: 'UPID:1' });
    mockProvider.taskRef.mockReturnValue('{"provider":"proxmox","ref":"UPID:1","node":"pve-a"}');
    const reportProgress = jest.fn();
    const result = await handler.execute({ operation, request, reportProgress }, { database: {} });
    expect(mockPreflight).toHaveBeenCalledWith(target.host, VM_ID, { database: {}, executionEnabled: true });
    expect(mockProvider.submit).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ state: 'reconciling', phase: 'native-task', nativeTaskState: 'pending' }));
    expect(reportProgress).toHaveBeenCalledWith(15, 'pre-submit', expect.any(String));
  });

  it('does not replay a response-lost mutation and recovers only from observed placement', async () => {
    mockProvider.parseTask.mockReturnValue(null);
    let result = await handler.reconcile({ operation, request, nativeTaskRef: null, reportProgress: jest.fn() }, { database: {} });
    expect(result.state).toBe('unknown');
    expect(mockProvider.submit).not.toHaveBeenCalled();
    mockProvider.isOnTarget.mockReturnValue(true);
    result = await handler.reconcile({ operation, request, nativeTaskRef: null, reportProgress: jest.fn() }, { database: {} });
    expect(result).toEqual(expect.objectContaining({ state: 'succeeded', result: expect.objectContaining({ recoveredByPlacement: true }) }));
  });

  it('waits for native progress then verifies placement and expected power state', async () => {
    mockProvider.parseTask.mockReturnValue({ provider: 'proxmox', ref: 'UPID:1', node: 'pve-a' });
    mockProvider.taskStatus.mockResolvedValue({ status: 'running' });
    mockProvider.taskOutcome.mockReturnValue({ pending: true, progress: 55 });
    const reportProgress = jest.fn();
    let result = await handler.reconcile({ operation, request, nativeTaskRef: 'task', reportProgress }, { database: {} });
    expect(result).toEqual({ state: 'reconciling', phase: 'native-task', delayMs: 2000 });
    expect(reportProgress).toHaveBeenCalledWith(55, 'native-task', expect.any(String));

    mockProvider.taskOutcome.mockReturnValue({ done: true, progress: 100 });
    mockProvider.isOnTarget.mockReturnValue(true);
    result = await handler.reconcile({ operation, request, nativeTaskRef: 'task', reportProgress }, { database: {} });
    expect(result).toEqual(expect.objectContaining({ state: 'succeeded', phase: 'verified' }));
  });

  it('confirms cancellation only through the provider bridge', async () => {
    mockProvider.parseTask.mockReturnValue({ provider: 'proxmox', ref: 'UPID:1' });
    mockProvider.cancel.mockResolvedValue(true);
    await expect(handler.cancel({ operation, request, nativeTaskRef: 'task' }, { database: {} }))
      .resolves.toEqual({ confirmed: true, result: { providerTaskCancelled: true } });
  });
});
