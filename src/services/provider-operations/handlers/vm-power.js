'use strict';

const { getDb } = require('../../../db');
const identityStore = require('../../provider-sdk/identity-store');
const { _internals: resourceInternals } = require('../../provider-sdk/resource-schema');
const proxmox = require('../../proxmox');
const vsphere = require('../../vsphere');
const xen = require('../../xen');

const TYPE = 'vm.power';
const VERIFY_TIMEOUT_MS = 120_000;
const PENDING_TASK_STATES = new Set(['pending', 'queued', 'running', 'created']);
const SUCCESS_TASK_STATES = new Set(['success', 'succeeded', 'completed', 'complete', 'stopped']);
const FAILED_TASK_STATES = new Set(['failure', 'failed', 'error', 'cancelled', 'canceled']);

function _hostAndIdentity(operation, database) {
  const db = database || getDb();
  const host = db.prepare('SELECT * FROM docker_hosts WHERE id = ? AND is_active = 1')
    .get(operation.provider.endpointId);
  if (!host || host.daemon_type !== operation.provider.type) {
    throw Object.assign(new Error('Provider endpoint is unavailable'), { code: 'INVALID_OPERATION_HOST' });
  }
  const identity = identityStore.resolveCanonical(operation.resource.id, {
    hostId: host.id, kind: 'virtualMachine',
  }, db);
  if (!identity || identity.providerType !== host.daemon_type || identity.stability === 'transient') {
    throw Object.assign(new Error('Stable provider VM identity was not found'), { code: 'INVALID_OPERATION_RESOURCE' });
  }
  return { host, identity };
}

function _matches(row, identity) {
  if (identity.uuid && String(row?.uuid || row?.hostUuid || '') === identity.uuid) return true;
  return [row?.ref, row?.moref, row?.id, row?.vmid].filter(value => value !== undefined && value !== null)
    .some(value => String(value) === identity.nativeRef);
}

function _allowed(providerType, row, action) {
  if (providerType === 'proxmox') {
    return require('../../provider-sdk/adapters/proxmox')._internals._allowedVmActions(row).includes(action);
  }
  if (providerType === 'vsphere') {
    return require('../../provider-sdk/adapters/vsphere')._internals._allowedVmActions(row).includes(action);
  }
  return Array.isArray(row?.allowedActions) && row.allowedActions.includes(action);
}

function _expectedState(action) {
  if (action === 'start' || action === 'reboot' || action === 'forceReboot') return 'running';
  return 'stopped';
}

function _taskRef(provider, result) {
  const ref = result?.taskRef || null;
  if (!ref || typeof ref !== 'string' || ref.length > 1600) return null;
  const value = { provider, ref };
  if (provider === 'proxmox') value.node = result.node;
  return JSON.stringify(value);
}

function _parseTask(value, provider) {
  if (!value) return null;
  try {
    const task = JSON.parse(value);
    if (task?.provider !== provider || typeof task.ref !== 'string' || task.ref.length > 1600) return null;
    if (task.node !== undefined && !/^[A-Za-z0-9._-]{1,160}$/.test(task.node)) return null;
    return task;
  } catch { return null; }
}

async function _open(operation, database) {
  const { host, identity } = _hostAndIdentity(operation, database);
  let client;
  if (host.daemon_type === 'proxmox') client = proxmox.fromHostRow(host);
  else if (host.daemon_type === 'vsphere') client = vsphere.fromHostRow(host);
  else if (host.daemon_type === 'xen') client = xen.clientForHost(host);
  else throw Object.assign(new Error('Provider does not support common VM power'), { code: 'PROVIDER_ACTION_UNAVAILABLE' });
  return { host, identity, client };
}

async function _close(target) {
  if (!target?.client) return;
  if (target.host.daemon_type === 'vsphere') {
    try { await target.client.logout?.(); } catch { /* best-effort */ }
    target.client._agent?.destroy?.();
  } else if (target.host.daemon_type === 'proxmox') target.client._agent?.destroy?.();
  else await target.client.close?.();
}

async function _read(target) {
  const rows = await target.client.listVMs();
  const row = rows.find(item => _matches(item, target.identity));
  if (!row) throw Object.assign(new Error('Provider VM was not found'), { code: 'PROVIDER_VM_NOT_FOUND' });
  return row;
}

function _nativeVmTarget(target, row) {
  if (target.host.daemon_type === 'proxmox') {
    const id = String(row.id || target.identity.nativeRef || '');
    const match = /^(qemu|lxc)\/(\d+)$/.exec(id);
    const node = String(row.node || '');
    if (!match || !/^[A-Za-z0-9._-]{1,160}$/.test(node)) {
      throw Object.assign(new Error('Proxmox VM placement is unavailable'), { code: 'INVALID_PROVIDER_RESOURCE' });
    }
    return { node, guestType: match[1], vmid: match[2] };
  }
  if (target.host.daemon_type === 'vsphere') return { vmMoref: String(row.moref || target.identity.nativeRef) };
  return { vmId: target.client.provider === 'xapi' && target.identity.uuid
    ? target.identity.uuid : target.identity.nativeRef };
}

async function _submit(target, row, action) {
  const native = _nativeVmTarget(target, row);
  if (target.host.daemon_type === 'proxmox') {
    return target.client.vmPowerAction(native.node, native.vmid, native.guestType, action);
  }
  if (target.host.daemon_type === 'vsphere') return target.client.vmPowerAction(native.vmMoref, action);
  return target.client.vmAction(native.vmId, action, {});
}

function _taskOutcome(provider, status) {
  const state = String(status?.status || status?.state || '').toLowerCase();
  if (provider === 'proxmox' && state === 'stopped') {
    return String(status?.exitstatus || '').toUpperCase() === 'OK'
      ? { done: true, progress: 100 }
      : { failed: true, message: status?.exitstatus || 'Proxmox task failed' };
  }
  if (SUCCESS_TASK_STATES.has(state)) return { done: true, progress: 100 };
  if (FAILED_TASK_STATES.has(state)) return { failed: true, message: status?.error || 'Provider task failed' };
  if (PENDING_TASK_STATES.has(state) || !state || state === 'unknown') {
    const rawProgress = Number(status?.progress);
    const progress = Number.isFinite(rawProgress) ? (rawProgress <= 1 ? rawProgress * 100 : rawProgress) : 70;
    return { pending: true, progress: Math.max(5, Math.min(94, Math.round(progress))) };
  }
  return { pending: true, progress: 70 };
}

async function _taskStatus(target, task) {
  if (target.host.daemon_type === 'proxmox') return target.client.getTaskStatus(task.node, task.ref);
  if (target.host.daemon_type === 'vsphere') return target.client.getTaskStatus(task.ref);
  return target.client.getTask(task.ref);
}

async function execute(context, options = {}) {
  const target = await _open(context.operation, options.database);
  try {
    const row = await _read(target);
    const currentState = resourceInternals._powerState(row.powerState ?? row.status);
    if (!_allowed(target.host.daemon_type, row, context.operation.action)) {
      throw Object.assign(new Error(`VM power action is unavailable while the VM is ${currentState}`), { code: 'RESOURCE_ACTION_BLOCKED' });
    }
    context.reportProgress(20, 'pre-submit', 'Provider VM state revalidated', { powerState: currentState });
    const result = await _submit(target, row, context.operation.action);
    const nativeTaskRef = _taskRef(target.host.daemon_type, result);
    return {
      state: 'reconciling', nativeTaskRef, nativeTaskState: nativeTaskRef ? 'pending' : null,
      phase: nativeTaskRef ? 'native-task' : 'post-verify', delayMs: 1000,
    };
  } finally { await _close(target); }
}

async function reconcile(context, options = {}) {
  const target = await _open(context.operation, options.database);
  try {
    const task = _parseTask(context.nativeTaskRef, target.host.daemon_type);
    if (task) {
      const outcome = _taskOutcome(target.host.daemon_type, await _taskStatus(target, task));
      if (outcome.failed) throw Object.assign(new Error(outcome.message), { code: 'PROVIDER_TASK_FAILED' });
      if (outcome.pending) {
        context.reportProgress(outcome.progress, 'native-task', 'Waiting for provider task');
        return { state: 'reconciling', phase: 'native-task', delayMs: 1500 };
      }
    }
    const row = await _read(target);
    const observed = resourceInternals._powerState(row.powerState ?? row.status);
    const expected = _expectedState(context.operation.action);
    if (observed === expected) {
      return { state: 'succeeded', phase: 'verified', result: { powerState: observed, verified: true } };
    }
    const startedAt = Date.parse(context.operation.startedAt || context.operation.createdAt || 0);
    if (Number.isFinite(startedAt) && Date.now() - startedAt < VERIFY_TIMEOUT_MS) {
      context.reportProgress(95, 'post-verify', 'Waiting for VM power-state verification', { observed, expected });
      return { state: 'reconciling', phase: 'post-verify', delayMs: 2000 };
    }
    return { state: 'unknown', result: { observedPowerState: observed, expectedPowerState: expected } };
  } finally { await _close(target); }
}

async function cancel(context, options = {}) {
  const task = _parseTask(context.nativeTaskRef, context.operation.provider.type);
  if (!task || task.provider !== 'proxmox') return { confirmed: false };
  const target = await _open(context.operation, options.database);
  try {
    await target.client.stopTask(task.node, task.ref);
    return { confirmed: true, result: { providerTaskCancelled: true } };
  } catch { return { confirmed: false }; }
  finally { await _close(target); }
}

function register(engine, options = {}) {
  engine.registerHandler({
    type: TYPE, idempotent: false, retryPolicy: 'none', timeoutSeconds: 120,
    execute: context => execute(context, options),
    reconcile: context => reconcile(context, options),
    cancel: context => cancel(context, options),
  });
}

module.exports = {
  TYPE, register, execute, reconcile, cancel,
  _internals: { _matches, _allowed, _expectedState, _taskRef, _parseTask, _taskOutcome, _nativeVmTarget },
};
