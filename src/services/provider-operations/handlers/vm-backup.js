'use strict';

const { getDb } = require('../../../db');
const { fromHostRow } = require('../../proxmox');
const identityStore = require('../../provider-sdk/identity-store');
const recoveryCatalog = require('../../provider-sdk/recovery-point-catalog');
const registry = require('../../provider-sdk/registry');

const TYPE = 'vm.backup';
const DISCOVERY_TIMEOUT_MS = 30 * 60 * 1000;
const SAFE_EXECUTION_ID = /^pbex_[a-f0-9]{26}$/;
const SAFE_POLICY_ID = /^pbp_[a-f0-9]{26}$/;
const SAFE_REPOSITORY_ID = /^ddr_repo_[a-f0-9]{26}$/;
const SAFE_POINT_ID = /^ddr_rp_[a-f0-9]{26}$/;

function _host(operation, database) {
  const host = database.prepare('SELECT * FROM docker_hosts WHERE id = ? AND is_active = 1')
    .get(operation.provider.endpointId);
  if (!host || host.daemon_type !== 'proxmox' || operation.provider.type !== 'proxmox') {
    throw Object.assign(new Error('Proxmox backup endpoint is unavailable'), { code: 'BACKUP_PROVIDER_UNSUPPORTED' });
  }
  return host;
}

function _request(context) {
  const request = context.request || {};
  if (!SAFE_EXECUTION_ID.test(String(request.executionId || ''))
    || !SAFE_POLICY_ID.test(String(request.policyId || ''))
    || !SAFE_REPOSITORY_ID.test(String(request.repositoryId || ''))
    || !/^[a-f0-9]{64}$/.test(String(request.planHash || ''))
    || !Array.isArray(request.baselinePointIds) || request.baselinePointIds.length > 500
    || request.baselinePointIds.some(id => !SAFE_POINT_ID.test(String(id)))) {
    throw Object.assign(new Error('Backup execution request is invalid'), { code: 'INVALID_BACKUP_EXECUTION' });
  }
  if (request.consistency !== 'crash') {
    throw Object.assign(new Error('Proxmox backup execution currently requires crash-consistent policy semantics'), {
      code: 'BACKUP_CONSISTENCY_UNSUPPORTED',
    });
  }
  return request;
}

function _taskRef(task) {
  return JSON.stringify({ provider: 'proxmox', node: task.node, upid: task.taskRef });
}

function _parseTask(value) {
  try {
    const task = JSON.parse(value || '{}');
    return task?.provider === 'proxmox' && /^[A-Za-z0-9._-]{1,128}$/.test(String(task.node || ''))
      && String(task.upid || '').startsWith('UPID:') ? task : null;
  } catch { return null; }
}

function _target(operation, request, database) {
  const identity = identityStore.resolveCanonical(operation.resource.id, {
    hostId: operation.provider.endpointId, kind: 'virtualMachine',
  }, database);
  const repository = recoveryCatalog.resolveRepository(request.repositoryId, {
    hostId: operation.provider.endpointId,
  }, database);
  if (!identity || identity.providerType !== 'proxmox') {
    throw Object.assign(new Error('Backup workload identity is unavailable'), { code: 'PROVIDER_VM_NOT_FOUND' });
  }
  if (!repository || repository.providerType !== 'proxmox') {
    throw Object.assign(new Error('Backup repository identity is unavailable'), { code: 'PROVIDER_BACKUP_REPOSITORY_NOT_FOUND' });
  }
  const match = /^(qemu|lxc)\/(\d+)$/.exec(String(identity.nativeRef || ''));
  if (!match) throw Object.assign(new Error('Backup workload identity is unsupported'), { code: 'INVALID_PROVIDER_RESOURCE' });
  return { identity, repository, guestType: match[1], vmid: Number(match[2]) };
}

function _storageForNode(nativeRef, node) {
  const value = String(nativeRef || '');
  const local = /^([A-Za-z0-9._-]{1,128})@([A-Za-z0-9._-]{1,128})$/.exec(value);
  if (local && local[2] !== node) {
    throw Object.assign(new Error('Local backup repository is attached to a different node'), {
      code: 'BACKUP_REPOSITORY_NODE_MISMATCH',
    });
  }
  const storage = local ? local[1] : value;
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(storage)) {
    throw Object.assign(new Error('Backup repository native identity is invalid'), { code: 'INVALID_BACKUP_EXECUTION' });
  }
  return storage;
}

function _deadline(operation) {
  const started = Date.parse(operation.startedAt || operation.createdAt || 0);
  return (Number.isFinite(started) ? started : Date.now()) + DISCOVERY_TIMEOUT_MS;
}

async function _discover(context, host, database) {
  const request = _request(context);
  const inventory = await registry.recoveryPointsForHost(host, {
    repositoryId: request.repositoryId, workloadId: context.operation.resource.id,
    limit: 500, database,
  });
  if (inventory.truncated) {
    throw Object.assign(new Error('Recovery-point discovery inventory is truncated'), {
      code: 'BACKUP_DISCOVERY_TRUNCATED',
    });
  }
  const baseline = new Set(request.baselinePointIds);
  const startedAt = Date.parse(context.operation.startedAt || context.operation.createdAt || 0);
  const candidates = inventory.items.filter(point => !baseline.has(point.id)
    && point.repository?.id === request.repositoryId
    && point.workload?.id === context.operation.resource.id
    && (!point.createdAt || !Number.isFinite(startedAt) || Date.parse(point.createdAt) >= startedAt - 120_000))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  if (candidates.length) {
    const point = candidates[0];
    return { state: 'succeeded', phase: 'recovery-point-observed', result: {
      executionId: request.executionId, policyId: request.policyId,
      repositoryId: request.repositoryId, recoveryPointId: point.id,
      recoveryPointCreatedAt: point.createdAt || null,
      verificationState: point.verification?.state || 'unknown',
      verifiedBy: 'provider_task_and_live_recovery_point_inventory',
      retentionMutationAuthorized: false,
    } };
  }
  if (Date.now() < _deadline(context.operation)) {
    context.reportProgress(95, 'recovery-point-discovery', 'Waiting for the new recovery point to appear in live inventory');
    return { state: 'reconciling', phase: 'recovery-point-discovery', delayMs: 5000 };
  }
  return { state: 'unknown', result: {
    executionId: request.executionId, repositoryId: request.repositoryId,
    recoveryPointObserved: false, retentionMutationAuthorized: false,
  } };
}

async function execute(context, options = {}) {
  const database = options.database || getDb();
  const request = _request(context);
  const host = _host(context.operation, database);
  const target = _target(context.operation, request, database);
  const client = (options.clientFactory || fromHostRow)(host);
  try {
    const [vms, inventory] = await Promise.all([client.listVMs(), client.listRecoveryPoints()]);
    const vm = vms.find(item => Number(item.vmid) === target.vmid
      && String(item.type || 'qemu') === target.guestType);
    if (!vm?.node || vm.template === 1 || vm.lock) {
      throw Object.assign(new Error('Backup workload is unavailable or locked'), { code: 'BACKUP_WORKLOAD_UNAVAILABLE' });
    }
    const rawRepository = inventory.repositories.find(item => String(item.nativeRef) === target.repository.nativeRef);
    if (!rawRepository || rawRepository.enabled === false || rawRepository.accessible === false) {
      throw Object.assign(new Error('Backup repository is not currently accessible'), { code: 'BACKUP_REPOSITORY_UNAVAILABLE' });
    }
    const storage = _storageForNode(target.repository.nativeRef, String(vm.node));
    context.reportProgress(20, 'pre-submit', 'Workload and repository were revalidated against live Proxmox inventory');
    const result = await client.startVmBackup(String(vm.node), target.vmid, target.guestType, {
      storage, mode: 'snapshot', compress: 'zstd',
      bwlimitKiB: request.bandwidthLimitMbps ? Math.max(1, Math.round(Number(request.bandwidthLimitMbps) * 125)) : undefined,
    });
    return { state: 'reconciling', phase: 'native-task', nativeTaskRef: _taskRef(result),
      nativeTaskState: 'running', delayMs: 1500 };
  } finally { client._agent?.destroy?.(); }
}

async function reconcile(context, options = {}) {
  const database = options.database || getDb();
  const host = _host(context.operation, database);
  const task = _parseTask(context.nativeTaskRef);
  if (!task) return _discover(context, host, database);
  const client = (options.clientFactory || fromHostRow)(host);
  try {
    const status = await client.getTaskStatus(task.node, task.upid);
    if (String(status?.status || '').toLowerCase() !== 'stopped') {
      context.reportProgress(75, 'native-task', 'Waiting for the Proxmox backup task');
      return { state: 'reconciling', phase: 'native-task', delayMs: 3000 };
    }
    if (String(status?.exitstatus || '').toUpperCase() !== 'OK') {
      throw Object.assign(new Error('Proxmox backup task failed'), { code: 'PROVIDER_BACKUP_TASK_FAILED' });
    }
  } finally { client._agent?.destroy?.(); }
  return _discover(context, host, database);
}

async function cancel(context, options = {}) {
  const task = _parseTask(context.nativeTaskRef);
  if (!task) return { confirmed: false };
  const database = options.database || getDb();
  let host;
  try { host = _host(context.operation, database); } catch { return { confirmed: false }; }
  const client = (options.clientFactory || fromHostRow)(host);
  try {
    await client.stopTask(task.node, task.upid);
    return { confirmed: true, result: { providerTaskCancelled: true, retentionMutationAuthorized: false } };
  } catch { return { confirmed: false }; }
  finally { client._agent?.destroy?.(); }
}

function register(engine, options = {}) {
  engine.registerHandler({
    type: TYPE, idempotent: false, retryPolicy: 'none', timeoutSeconds: 86400,
    execute: context => execute(context, options),
    reconcile: context => reconcile(context, options),
    cancel: context => cancel(context, options),
  });
}

module.exports = {
  TYPE, register, execute, reconcile, cancel,
  _internals: { _host, _request, _target, _storageForNode, _taskRef, _parseTask, _discover, _deadline },
};
