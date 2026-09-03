'use strict';

const config = require('../../../config');
const { getDb } = require('../../../db');
const { sha256 } = require('../../../utils/crypto');
const bridge = require('../nic-provider');

const TYPE = 'vm.nic.link';
const PENDING = new Set(['pending', 'queued', 'running', 'created']);
const SUCCEEDED = new Set(['success', 'succeeded', 'completed', 'complete']);
const FAILED = new Set(['failure', 'failed', 'error', 'cancelled', 'canceled']);

function _canonical(value) {
  if (Array.isArray(value)) return `[${value.map(_canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${_canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function _fingerprint(vmId, nic) {
  return sha256(_canonical({
    vmId, nicId: nic.id, label: nic.label || null, device: nic.device || null,
    model: nic.model || null, macAddress: nic.macAddress || null,
    network: {
      id: nic.network?.id || null, bridge: nic.network?.bridge || null,
      vlanId: nic.network?.vlanId ?? null, distributedSwitch: nic.network?.distributedSwitch || null,
    },
  }));
}

function _enabled(providerType, options = {}) {
  if (typeof options.enabled === 'boolean') return options.enabled;
  const keys = {
    proxmox: 'providerVmNicLinkProxmox', vsphere: 'providerVmNicLinkVsphere', xen: 'providerVmNicLinkXen',
  };
  return config.features?.[keys[providerType]] === true;
}

function _host(operation, database) {
  const host = database.prepare('SELECT * FROM docker_hosts WHERE id=? AND is_active=1')
    .get(operation.provider.endpointId);
  if (!host || host.daemon_type !== operation.provider.type) {
    throw Object.assign(new Error('Provider endpoint is unavailable'), { code: 'INVALID_OPERATION_HOST' });
  }
  return host;
}

function _request(context) {
  const request = context.request || {};
  if (!/^[a-f0-9]{64}$/.test(String(request.planHash || ''))
    || !/^ddh_nic_[a-f0-9]{26}$/.test(String(request.nicId || ''))
    || !/^[a-f0-9]{64}$/.test(String(request.nicFingerprint || ''))
    || typeof request.expectedConnected !== 'boolean'
    || typeof request.previousConnected !== 'boolean'
    || !['connect', 'disconnect'].includes(String(request.rollbackAction || ''))
    || (request.safetyDeclarationId !== null && request.safetyDeclarationId !== undefined
      && (!Number.isInteger(Number(request.safetyDeclarationId)) || Number(request.safetyDeclarationId) <= 0))) {
    throw Object.assign(new Error('Stored NIC link request is invalid'), { code: 'INVALID_VM_NIC_LINK_REQUEST' });
  }
  return request;
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
    if (task.synchronous !== true && (typeof task.ref !== 'string' || !task.ref || task.ref.length > 1600)) return null;
    if (task.node !== undefined && !/^[A-Za-z0-9._-]{1,160}$/.test(task.node)) return null;
    return task;
  } catch { return null; }
}

function _taskOutcome(provider, status) {
  const state = String(status?.status || status?.state || '').toLowerCase();
  if (provider === 'proxmox' && state === 'stopped') {
    return String(status?.exitstatus || '').toUpperCase() === 'OK'
      ? { done: true, progress: 100 }
      : { failed: true, message: status?.exitstatus || 'Proxmox NIC link task failed' };
  }
  if (SUCCEEDED.has(state)) return { done: true, progress: 100 };
  if (FAILED.has(state)) return { failed: true, message: status?.error || 'Provider NIC link task failed' };
  if (PENDING.has(state) || !state || state === 'unknown') {
    const raw = Number(status?.progress);
    const progress = Number.isFinite(raw) ? (raw <= 1 ? raw * 100 : raw) : 70;
    return { pending: true, progress: Math.max(5, Math.min(94, Math.round(progress))) };
  }
  return { pending: true, progress: 70 };
}

function _deadline(operation) {
  const started = Date.parse(operation.startedAt || operation.createdAt || 0);
  const timeout = Number(config.providerVmNics?.verifyTimeoutMs || 120_000);
  return Number.isFinite(started) ? started + timeout : Date.now() + timeout;
}

function _assertDisconnectSafety(context, request, current, database) {
  if (request.expectedConnected !== false || current.portable.attachment?.connected === false) return;
  const row = database.prepare(`SELECT * FROM provider_vm_nic_safety_declarations
    WHERE id=? AND host_id=? AND vm_id=? AND nic_id=?`)
    .get(Number(request.safetyDeclarationId), context.operation.provider.endpointId,
      context.operation.resource.id, request.nicId);
  const valid = row && row.nic_fingerprint === request.nicFingerprint
    && Date.parse(row.expires_at) > Date.now()
    && row.management_role === 'non_management'
    && row.boot_dependency === 'not_required' && row.guest_dependency === 'not_required';
  if (!valid) throw Object.assign(new Error('NIC disconnect safety declaration changed or expired'), {
    code: 'VM_NIC_SAFETY_CHANGED',
  });
  const connectedCount = current.inventory.nics
    .filter(item => item.portable.attachment?.connected === true).length;
  if (connectedCount <= 1) throw Object.assign(new Error('Disconnecting the last connected NIC is forbidden'), {
    code: 'LAST_CONNECTED_NIC',
  });
}

async function _current(target, request, operation) {
  const inventory = await bridge.inventory(target);
  const nic = bridge.nicById(inventory, request.nicId);
  if (!nic) throw Object.assign(new Error('Provider NIC was not found'), { code: 'PROVIDER_VM_NIC_NOT_FOUND' });
  if (_fingerprint(operation.resource.id, nic.portable) !== request.nicFingerprint) {
    throw Object.assign(new Error('NIC hardware or network identity changed'), { code: 'VM_NIC_HARDWARE_CHANGED' });
  }
  return { ...nic, inventory };
}

async function _verify(context, target, request) {
  const current = await _current(target, request, context.operation);
  const observed = current.portable.attachment?.connected;
  if (observed === request.expectedConnected) {
    return { state: 'succeeded', phase: 'verified', result: {
      nicId: request.nicId, connected: observed, verified: true,
      noChange: request.previousConnected === request.expectedConnected,
    } };
  }
  if (Date.now() < _deadline(context.operation)) {
    context.reportProgress(95, 'post-verify', 'Waiting for NIC link-state verification', {
      observed, expected: request.expectedConnected,
    });
    return { state: 'reconciling', phase: 'post-verify', delayMs: 2000 };
  }
  return { state: 'unknown', result: {
    nicId: request.nicId, observedConnected: observed, expectedConnected: request.expectedConnected,
    rollbackPlan: { automatic: false, action: request.rollbackAction, requiresFreshPreflight: true },
  } };
}

async function execute(context, options = {}) {
  const database = options.database || getDb();
  const request = _request(context);
  const host = _host(context.operation, database);
  if (!_enabled(host.daemon_type, options)) throw Object.assign(new Error('VM NIC link control is disabled'), {
    code: 'VM_NIC_LINK_DISABLED',
  });
  const target = await bridge.open(host, context.operation.resource.id, database);
  try {
    const current = await _current(target, request, context.operation);
    if (current.portable.capabilities?.connectDisconnect !== true
      || typeof current.portable.attachment?.connected !== 'boolean') {
      throw Object.assign(new Error('NIC link capability or state changed before execution'), {
        code: 'VM_NIC_LINK_CAPABILITY_CHANGED',
      });
    }
    _assertDisconnectSafety(context, request, current, database);
    if (current.portable.attachment.connected === request.expectedConnected) {
      return { state: 'succeeded', phase: 'verified', result: {
        nicId: request.nicId, connected: request.expectedConnected, verified: true, noChange: true,
      } };
    }
    context.reportProgress(20, 'pre-submit', 'NIC identity, link state and safety evidence revalidated');
    const result = await bridge.mutate(target, context.operation.action, current);
    const nativeTaskRef = _taskRef(host.daemon_type, result);
    const task = _parseTask(nativeTaskRef, host.daemon_type);
    if (task?.synchronous) return _verify(context, target, request);
    return { state: 'reconciling', nativeTaskRef, nativeTaskState: 'pending', phase: 'native-task', delayMs: 1000 };
  } finally { await bridge.close(target); }
}

async function reconcile(context, options = {}) {
  const database = options.database || getDb();
  const request = _request(context);
  const host = _host(context.operation, database);
  const target = await bridge.open(host, context.operation.resource.id, database);
  try {
    const task = _parseTask(context.nativeTaskRef, host.daemon_type);
    if (task?.ref) {
      const outcome = _taskOutcome(host.daemon_type, await bridge.taskStatus(target, task));
      if (outcome.failed) throw Object.assign(new Error(outcome.message), { code: 'PROVIDER_TASK_FAILED' });
      if (outcome.pending) {
        if (Date.now() >= _deadline(context.operation)) return { state: 'unknown', result: {
          nicId: request.nicId, nativeTaskTimedOut: true,
          rollbackPlan: { automatic: false, action: request.rollbackAction, requiresFreshPreflight: true },
        } };
        context.reportProgress(outcome.progress, 'native-task', 'Waiting for provider NIC link task');
        return { state: 'reconciling', phase: 'native-task', delayMs: 1500 };
      }
    }
    return _verify(context, target, request);
  } finally { await bridge.close(target); }
}

async function cancel(context, options = {}) {
  const task = _parseTask(context.nativeTaskRef, context.operation.provider.type);
  if (!task?.ref) return { confirmed: false };
  const database = options.database || getDb();
  let target;
  try {
    target = await bridge.open(_host(context.operation, database), context.operation.resource.id, database);
    return { confirmed: await bridge.cancelTask(target, task), result: { providerTaskCancellationRequested: true } };
  } catch { return { confirmed: false }; }
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
  _internals: {
    _canonical, _fingerprint, _enabled, _host, _request, _taskRef, _parseTask,
    _taskOutcome, _deadline, _assertDisconnectSafety, _current, _verify,
  },
};
