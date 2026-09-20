'use strict';

const { getDb } = require('../../../db');
const config = require('../../../config');
const snapshotStore = require('../../provider-sdk/vm-snapshot-store');
const bridge = require('../snapshot-provider');

const TYPE = 'vm.snapshot';
const VERIFY_TIMEOUT_MS = 30 * 60 * 1000;
const PENDING = new Set(['pending', 'queued', 'running', 'created']);
const SUCCEEDED = new Set(['success', 'succeeded', 'completed', 'complete']);
const FAILED = new Set(['failure', 'failed', 'error', 'cancelled', 'canceled']);

function _graphDepth(items = []) {
  const byId = new Map(items.map(item => [item.id, item]));
  const memo = new Map();
  const visit = (item, path = new Set()) => {
    if (!item || path.has(item.id)) return 0;
    if (memo.has(item.id)) return memo.get(item.id);
    const next = new Set(path); next.add(item.id);
    const depth = 1 + (item.parentId ? visit(byId.get(item.parentId), next) : 0);
    memo.set(item.id, depth);
    return depth;
  };
  return items.reduce((max, item) => Math.max(max, visit(item)), 0);
}

function _taskRef(provider, result) {
  const ref = typeof result?.taskRef === 'string' ? result.taskRef : null;
  if (ref && ref.length > 1600) return null;
  const task = ref ? { provider, ref } : { provider, synchronous: true };
  if (provider === 'proxmox' && ref) task.node = result.node;
  return JSON.stringify(task);
}

function _parseTask(value, provider) {
  if (!value) return null;
  try {
    const task = JSON.parse(value);
    if (task?.provider !== provider) return null;
    if (task.synchronous === true) return { provider, synchronous: true };
    if (typeof task.ref !== 'string' || !task.ref || task.ref.length > 1600) return null;
    if (task.node !== undefined && !/^[A-Za-z0-9._-]{1,160}$/.test(task.node)) return null;
    return task;
  } catch { return null; }
}

function _taskOutcome(provider, status) {
  const state = String(status?.status || status?.state || '').toLowerCase();
  if (provider === 'proxmox' && state === 'stopped') {
    return String(status?.exitstatus || '').toUpperCase() === 'OK'
      ? { done: true, progress: 100 }
      : { failed: true, message: status?.exitstatus || 'Proxmox snapshot task failed' };
  }
  if (SUCCEEDED.has(state)) return { done: true, progress: 100 };
  if (FAILED.has(state)) return { failed: true, message: status?.error || 'Provider snapshot task failed' };
  if (PENDING.has(state) || !state || state === 'unknown') {
    const raw = Number(status?.progress);
    const progress = Number.isFinite(raw) ? (raw <= 1 ? raw * 100 : raw) : 70;
    return { pending: true, progress: Math.max(5, Math.min(94, Math.round(progress))) };
  }
  return { pending: true, progress: 70 };
}

function _store(target, rows, database) {
  return snapshotStore.rememberMany({
    hostId: Number(target.host.id), vmId: target.vmId, providerType: target.host.daemon_type,
  }, rows, database);
}

async function _refresh(target, database) {
  return _store(target, await bridge.list(target), database);
}

function _resolve(operation, request, database) {
  if (!request.snapshotId) return null;
  return snapshotStore.resolve(request.snapshotId, {
    hostId: operation.provider.endpointId, vmId: operation.resource.id,
  }, database);
}

function _deadline(operation) {
  const started = Date.parse(operation.startedAt || operation.createdAt || 0);
  return Number.isFinite(started) ? started + VERIFY_TIMEOUT_MS : Date.now() + VERIFY_TIMEOUT_MS;
}

function _host(operation, database) {
  const host = database.prepare('SELECT * FROM docker_hosts WHERE id = ? AND is_active = 1')
    .get(operation.provider.endpointId);
  if (!host || host.daemon_type !== operation.provider.type) {
    throw Object.assign(new Error('Provider endpoint is unavailable'), { code: 'INVALID_OPERATION_HOST' });
  }
  return host;
}

async function _verify(context, target, database, confirmed) {
  const { operation, request } = context;
  if (operation.action === 'consolidate') {
    const needed = await bridge.consolidationNeeded(target);
    if (needed === false) {
      return { state: 'succeeded', phase: 'verified', result: {
        consolidated: true, verified: true, verifiedBy: 'runtime.consolidationNeeded',
      } };
    }
    if (Date.now() < _deadline(operation)) {
      context.reportProgress(95, 'post-verify', 'Waiting for provider runtime consolidation state to clear');
      return { state: 'reconciling', phase: 'post-verify', delayMs: 2000 };
    }
    return { state: 'unknown', result: { expected: 'runtime.consolidationNeeded=false', observed: needed } };
  }
  const items = await _refresh(target, database);
  if (operation.action === 'create') {
    const matches = items.filter(item => item.name === request.name);
    if (matches.length === 1) {
      return { state: 'succeeded', phase: 'verified', result: {
        snapshotId: matches[0].id, name: matches[0].name,
        consistency: matches[0].consistency === 'unknown' ? request.consistency : matches[0].consistency,
        verified: true, protection: matches[0].protection,
      } };
    }
  } else if (operation.action === 'delete') {
    if (!_resolve(operation, request, database)) {
      return { state: 'succeeded', phase: 'verified', result: { snapshotId: request.snapshotId, deleted: true, verified: true } };
    }
  } else if (operation.action === 'revert' && confirmed) {
    const snapshot = _resolve(operation, request, database);
    if (snapshot) {
      return { state: 'succeeded', phase: 'verified', result: {
        snapshotId: snapshot.id, reverted: true, verified: true,
        verifiedBy: 'provider_completion_and_inventory',
      } };
    }
  }
  if (Date.now() < _deadline(operation)) {
    context.reportProgress(95, 'post-verify', 'Waiting for snapshot inventory verification');
    return { state: 'reconciling', phase: 'post-verify', delayMs: 2000 };
  }
  return { state: 'unknown', result: { snapshotId: request.snapshotId || null, expected: operation.action } };
}

async function execute(context, options = {}) {
  const database = options.database || getDb();
  const target = await bridge.open(_host(context.operation, database), context.operation.resource.id, database);
  try {
    const items = await _refresh(target, database);
    let snapshot = null;
    if (context.operation.action === 'create') {
      if (items.some(item => !['valid', 'unknown'].includes(item.integrity?.state))) {
        throw Object.assign(new Error('Snapshot parent graph is invalid'), { code: 'SNAPSHOT_GRAPH_INVALID' });
      }
      if (items.some(item => item.name.toLowerCase() === String(context.request.name).toLowerCase())) {
        throw Object.assign(new Error('Snapshot name already exists'), { code: 'SNAPSHOT_NAME_CONFLICT' });
      }
      const maxCount = Math.min(128, Math.max(1, Number(config.providerSnapshots?.maxCount) || 32));
      if (items.length >= maxCount) throw Object.assign(new Error('Snapshot count limit reached'), { code: 'SNAPSHOT_LIMIT_REACHED' });
      const maxDepth = Math.min(64, Math.max(1, Number(config.providerSnapshots?.maxDepth) || 16));
      if (_graphDepth(items) >= maxDepth) {
        throw Object.assign(new Error('Snapshot chain depth limit reached'), { code: 'SNAPSHOT_CHAIN_LIMIT_REACHED' });
      }
    } else if (context.operation.action !== 'consolidate') {
      snapshot = _resolve(context.operation, context.request, database);
      if (!snapshot) throw Object.assign(new Error('Provider snapshot was not found'), { code: 'PROVIDER_SNAPSHOT_NOT_FOUND' });
      if (context.operation.action === 'delete' && snapshot.childCount > 0) {
        throw Object.assign(new Error('Snapshot has child dependencies'), { code: 'SNAPSHOT_HAS_CHILDREN' });
      }
    }
    if (context.operation.action === 'consolidate' && target.row?.consolidationNeeded !== true) {
      throw Object.assign(new Error('Provider does not currently require snapshot disk consolidation'), { code: 'SNAPSHOT_CONSOLIDATION_NOT_REQUIRED' });
    }
    context.reportProgress(20, 'pre-submit', 'Snapshot state and ownership revalidated', { count: items.length });
    const result = await bridge.mutate(target, context.operation.action, context.request, snapshot);
    const nativeTaskRef = _taskRef(target.host.daemon_type, result);
    const task = _parseTask(nativeTaskRef, target.host.daemon_type);
    if (task?.synchronous) return await _verify(context, target, database, true);
    return { state: 'reconciling', nativeTaskRef, nativeTaskState: 'pending', phase: 'native-task', delayMs: 1000 };
  } finally { await bridge.close(target); }
}

async function reconcile(context, options = {}) {
  const database = options.database || getDb();
  const host = _host(context.operation, database);
  const target = await bridge.open(host, context.operation.resource.id, database);
  try {
    const task = _parseTask(context.nativeTaskRef, target.host.daemon_type);
    let confirmed = task?.synchronous === true;
    if (task?.ref) {
      const outcome = _taskOutcome(target.host.daemon_type, await bridge.taskStatus(target, task));
      if (outcome.failed) throw Object.assign(new Error(outcome.message), { code: 'PROVIDER_TASK_FAILED' });
      if (outcome.pending) {
        if (Date.now() >= _deadline(context.operation)) return { state: 'unknown', result: { nativeTaskTimedOut: true } };
        context.reportProgress(outcome.progress, 'native-task', 'Waiting for provider snapshot task');
        return { state: 'reconciling', phase: 'native-task', delayMs: 1500 };
      }
      confirmed = true;
    }
    return await _verify(context, target, database, confirmed);
  } finally { await bridge.close(target); }
}

async function cancel(context, options = {}) {
  const task = _parseTask(context.nativeTaskRef, context.operation.provider.type);
  if (!task?.ref || task.provider !== 'proxmox') return { confirmed: false };
  const database = options.database || getDb();
  let host;
  try { host = _host(context.operation, database); } catch { return { confirmed: false }; }
  const target = await bridge.open(host, context.operation.resource.id, database);
  try { return { confirmed: await bridge.cancelTask(target, task), result: { providerTaskCancelled: true } }; }
  catch { return { confirmed: false }; }
  finally { await bridge.close(target); }
}

function register(engine, options = {}) {
  engine.registerHandler({
    type: TYPE, idempotent: false, retryPolicy: 'none', timeoutSeconds: 300,
    execute: context => execute(context, options),
    reconcile: context => reconcile(context, options),
    cancel: context => cancel(context, options),
  });
}

module.exports = {
  TYPE, register, execute, reconcile, cancel,
  _internals: { _taskRef, _parseTask, _taskOutcome, _deadline, _host, _verify, _graphDepth },
};
