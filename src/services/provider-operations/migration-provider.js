'use strict';

const { getDb } = require('../../db');
const identityStore = require('../provider-sdk/identity-store');
const { _internals: resourceInternals } = require('../provider-sdk/resource-schema');
const proxmox = require('../proxmox');
const vsphere = require('../vsphere');
const xen = require('../xen');

const SAFE_NODE = /^[A-Za-z0-9._-]{1,160}$/;

function _error(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function _resolve(id, host, kind, database) {
  const identity = identityStore.resolveCanonical(id, { hostId: Number(host.id), kind }, database);
  if (!identity || identity.providerType !== host.daemon_type || identity.stability === 'transient') {
    throw _error(`Stable provider ${kind} identity was not found`, 'INVALID_OPERATION_RESOURCE');
  }
  return identity;
}

async function open(operation, request, database) {
  const db = database || getDb();
  const host = db.prepare('SELECT * FROM docker_hosts WHERE id = ? AND is_active = 1')
    .get(operation.provider.endpointId);
  if (!host || host.daemon_type !== operation.provider.type) {
    throw _error('Provider endpoint is unavailable', 'INVALID_OPERATION_HOST');
  }
  const identity = _resolve(operation.resource.id, host, 'virtualMachine', db);
  const targetIdentity = _resolve(request.targetId, host, 'host', db);
  const storageIdentity = request.targetStorageId
    ? _resolve(request.targetStorageId, host, 'storage', db) : null;
  let client;
  if (host.daemon_type === 'proxmox') client = proxmox.fromHostRow(host);
  else if (host.daemon_type === 'vsphere') {
    client = vsphere.fromHostRow(host); await client.login();
  } else if (host.daemon_type === 'xen') client = xen.clientForHost(host);
  else throw _error('Provider does not support native VM migration', 'PROVIDER_ACTION_UNAVAILABLE');
  return { host, identity, targetIdentity, storageIdentity, client };
}

async function close(target) {
  if (!target?.client) return;
  if (target.host.daemon_type === 'vsphere') {
    try { await target.client.logout?.(); } catch { /* best effort */ }
    target.client._agent?.destroy?.();
  } else if (target.host.daemon_type === 'proxmox') target.client._agent?.destroy?.();
  else await target.client.close?.();
}

function _matches(row, identity) {
  if (identity.uuid && String(row?.uuid || row?.hostUuid || '') === identity.uuid) return true;
  return [row?.ref, row?.moref, row?.id, row?.vmid].filter(value => value !== undefined && value !== null)
    .some(value => String(value) === identity.nativeRef
      || `${row?.type || 'qemu'}/${value}` === identity.nativeRef);
}

async function readVm(target) {
  const row = (await target.client.listVMs()).find(item => _matches(item, target.identity));
  if (!row) throw _error('Provider VM was not found', 'PROVIDER_VM_NOT_FOUND', 404);
  return row;
}

function placement(target, row) {
  if (target.host.daemon_type === 'proxmox') return String(row?.node || '');
  if (target.host.daemon_type === 'vsphere') return String(row?.hostRef || '');
  if (target.client.provider === 'xapi') return String(row?.hostRef || '');
  if (target.client.provider === 'xo') return String(row?.hostId || '');
  return '';
}

function isOnTarget(target, row) {
  const observed = placement(target, row);
  return !!observed && observed === String(target.targetIdentity.nativeRef);
}

function powerState(row) {
  return resourceInternals._powerState(row?.powerState ?? row?.status);
}

function _proxmoxVm(target, row) {
  const raw = String(row?.id || target.identity.nativeRef || '');
  const match = /^(qemu|lxc)\/(\d+)$/.exec(raw);
  const guestType = match?.[1] || (String(row?.type) === 'lxc' ? 'lxc' : 'qemu');
  const vmid = match?.[2] || String(row?.vmid || target.identity.nativeRef || '');
  const node = String(row?.node || '');
  if (!SAFE_NODE.test(node) || !/^\d{1,20}$/.test(vmid)) {
    throw _error('Proxmox VM placement is unavailable', 'INVALID_PROVIDER_RESOURCE');
  }
  return { node, guestType, vmid };
}

async function revalidateTarget(target, row, request) {
  if (isOnTarget(target, row)) return { alreadyOnTarget: true };
  if (target.host.daemon_type === 'proxmox') {
    const vm = _proxmoxVm(target, row);
    const [preconditions, inventory] = await Promise.all([
      target.client.getVmMigrationPreconditions(vm.node, vm.guestType, vm.vmid),
      target.client.getNodeMigrationInventory(target.targetIdentity.nativeRef),
    ]);
    if (Array.isArray(preconditions?.local_resources) && preconditions.local_resources.length) {
      throw _error('Proxmox reports host-local resources that block migration', 'VM_MIGRATION_REVALIDATION_BLOCKED', 409);
    }
    if (target.storageIdentity) {
      const storage = (inventory.storages || []).find(item => String(item.storage) === target.storageIdentity.nativeRef);
      if (!storage || storage.active === 0 || storage.enabled === 0) {
        throw _error('Proxmox target storage is no longer available', 'VM_MIGRATION_REVALIDATION_BLOCKED', 409);
      }
    }
    return { ready: true };
  }
  if (target.host.daemon_type === 'vsphere') {
    const hosts = await target.client.listHosts();
    const host = hosts.find(item => String(item.moref) === target.targetIdentity.nativeRef);
    if (!host || String(host.connectionState).toLowerCase() !== 'connected' || host.maintenanceMode === true) {
      throw _error('vSphere target host is no longer connected and available', 'VM_MIGRATION_REVALIDATION_BLOCKED', 409);
    }
    if (target.storageIdentity) {
      const datastores = await target.client.listDatastores();
      const datastore = datastores.find(item => String(item.moref) === target.storageIdentity.nativeRef);
      if (!datastore || datastore.accessible === false || String(datastore.maintenanceMode).toLowerCase() === 'inmaintenance') {
        throw _error('vSphere target datastore is no longer accessible', 'VM_MIGRATION_REVALIDATION_BLOCKED', 409);
      }
    }
    return { ready: true };
  }
  const vmId = target.client.provider === 'xapi'
    ? (target.identity.uuid || target.identity.nativeRef) : target.identity.nativeRef;
  const result = await target.client.getVmMigrationCompatibility(vmId, [target.targetIdentity.nativeRef]);
  const candidate = result?.candidates?.[0];
  if (!candidate || candidate.current || !['conditional', 'supported'].includes(candidate.modes?.[request.mode])) {
    throw _error('Xen target compatibility changed before submission', 'VM_MIGRATION_REVALIDATION_BLOCKED', 409);
  }
  return { ready: true };
}

async function submit(target, row, request) {
  if (isOnTarget(target, row)) return { alreadyOnTarget: true };
  if (target.host.daemon_type === 'proxmox') {
    const vm = _proxmoxVm(target, row);
    return target.client.migrateVm(vm.node, vm.vmid, vm.guestType, {
      target: target.targetIdentity.nativeRef, mode: request.mode,
      targetStorage: target.storageIdentity?.nativeRef || null,
    });
  }
  if (target.host.daemon_type === 'vsphere') {
    return target.client.relocateVm(String(row.moref || target.identity.nativeRef), {
      hostRef: target.targetIdentity.nativeRef,
      datastoreRef: target.storageIdentity?.nativeRef || null,
    });
  }
  if (!['xapi', 'xo'].includes(target.client.provider)) {
    throw _error('Raw Xen cannot provide a durable migration task', 'PROVIDER_ACTION_UNAVAILABLE');
  }
  if (request.mode === 'storage' && target.client.provider === 'xapi') {
    throw _error('XAPI storage remapping is outside the same-pool workflow', 'PROVIDER_ACTION_UNAVAILABLE');
  }
  const vmId = target.client.provider === 'xapi'
    ? (target.identity.uuid || target.identity.nativeRef) : target.identity.nativeRef;
  return target.client.migrateVm(vmId, target.targetIdentity.nativeRef, {
    live: request.mode === 'live', targetStorage: target.storageIdentity?.nativeRef || null,
  });
}

function taskRef(target, result) {
  const ref = result?.taskRef;
  if (typeof ref !== 'string' || !ref || ref.length > 1600) return null;
  const value = { provider: target.host.daemon_type, ref };
  if (target.host.daemon_type === 'proxmox') value.node = result.node;
  if (target.host.daemon_type === 'xen') value.variant = target.client.provider;
  return JSON.stringify(value);
}

function parseTask(value, provider) {
  if (!value) return null;
  try {
    const task = JSON.parse(value);
    if (task?.provider !== provider || typeof task.ref !== 'string' || task.ref.length > 1600) return null;
    if (task.node !== undefined && !SAFE_NODE.test(task.node)) return null;
    if (task.variant !== undefined && !['xapi', 'xo'].includes(task.variant)) return null;
    return task;
  } catch { return null; }
}

async function taskStatus(target, task) {
  if (target.host.daemon_type === 'proxmox') return target.client.getTaskStatus(task.node, task.ref);
  if (target.host.daemon_type === 'vsphere') return target.client.getTaskStatus(task.ref);
  if (task.variant !== target.client.provider) throw _error('Xen management plane changed during migration', 'PROVIDER_TASK_UNAVAILABLE');
  return target.client.getTask(task.ref);
}

function taskOutcome(provider, status) {
  const state = String(status?.status || status?.state || '').toLowerCase();
  if (provider === 'proxmox' && state === 'stopped') {
    return String(status?.exitstatus || '').toUpperCase() === 'OK'
      ? { done: true, progress: 100 }
      : { failed: true, message: status?.exitstatus || 'Proxmox migration task failed' };
  }
  if (['success', 'succeeded', 'completed', 'complete'].includes(state)) return { done: true, progress: 100 };
  if (['failure', 'failed', 'error', 'cancelled', 'canceled'].includes(state)) {
    const detail = Array.isArray(status?.error) ? status.error.join(' ') : status?.error;
    return { failed: true, message: detail || 'Provider migration task failed' };
  }
  const raw = Number(status?.progress);
  const progress = Number.isFinite(raw) ? (raw <= 1 ? raw * 100 : raw) : 60;
  return { pending: true, progress: Math.max(5, Math.min(94, Math.round(progress))) };
}

async function cancel(target, task) {
  if (target.host.daemon_type === 'proxmox') {
    await target.client.stopTask(task.node, task.ref); return true;
  }
  if (target.host.daemon_type === 'vsphere') {
    const status = await target.client.getTaskStatus(task.ref);
    if (status.cancelable !== true) return false;
    await target.client.cancelTask(task.ref); return true;
  }
  if (task.variant === 'xapi' && target.client.provider === 'xapi') {
    await target.client.cancelTask(task.ref); return true;
  }
  return false;
}

module.exports = {
  open, close, readVm, placement, isOnTarget, powerState, revalidateTarget, submit,
  taskRef, parseTask, taskStatus, taskOutcome, cancel,
  _internals: { _matches, _proxmoxVm },
};
