'use strict';

const { fromHostRow: proxmoxFromHost } = require('../proxmox');
const { fromHostRow: vsphereFromHost } = require('../vsphere');
const xen = require('../xen');
const identityStore = require('../provider-sdk/identity-store');

function _error(message, code = 'PROVIDER_ACTION_UNAVAILABLE', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function _identity(host, sourceHostId, database) {
  const value = identityStore.resolveCanonical(sourceHostId, {
    hostId: Number(host.id), kind: 'host',
  }, database);
  if (!value || value.providerType !== host.daemon_type || value.stability === 'transient') {
    throw _error('Stable source host identity was not found', 'PROVIDER_HOST_NOT_FOUND', 404);
  }
  return value;
}

async function open(host, sourceHostId, database) {
  const identity = _identity(host, sourceHostId, database);
  let client;
  if (host.daemon_type === 'proxmox') client = proxmoxFromHost(host);
  else if (host.daemon_type === 'vsphere') {
    client = vsphereFromHost(host); await client.login();
  } else if (host.daemon_type === 'xen') client = xen.clientForHost(host);
  else throw _error('Provider host maintenance is unavailable');
  return { host, identity, client, variant: client.provider || host.daemon_type };
}

async function close(target) {
  if (!target?.client) return;
  try { await target.client.logout?.(); } catch { /* best-effort */ }
  try { target.client._agent?.destroy?.(); } catch { /* best-effort */ }
  try { target.client.close?.(); } catch { /* best-effort */ }
}

function _proxmoxKey(row) { return `${String(row.type || 'qemu')}/${Number(row.vmid)}`; }

async function workloads(target) {
  if (target.host.daemon_type === 'proxmox') {
    const source = String(target.identity.nativeRef);
    return (await target.client.listVMs()).filter(row => Number(row?.template) !== 1 && String(row.node) === source)
      .map(row => ({ nativeRef: _proxmoxKey(row), uuid: null, name: row.name || String(row.vmid) }));
  }
  if (target.host.daemon_type === 'vsphere') {
    const source = String(target.identity.nativeRef);
    return (await target.client.listVMs()).filter(row => String(row.hostRef) === source)
      .map(row => ({ nativeRef: String(row.moref), uuid: row.uuid || null, name: row.name || String(row.moref) }));
  }
  if (target.host.daemon_type === 'xen' && target.client.provider === 'xapi') {
    const source = String(target.identity.nativeRef);
    return (await target.client.listVMs()).filter(row => String(row.hostRef) === source)
      .map(row => ({ nativeRef: String(row.ref), uuid: row.uuid || null, name: row.name || row.uuid }));
  }
  if (target.host.daemon_type === 'xen' && target.client.provider === 'xo') {
    const source = String(target.identity.nativeRef);
    return (await target.client.listVMs()).filter(row => String(row.hostId) === source)
      .map(row => ({ nativeRef: String(row.id), uuid: row.uuid || null, name: row.name || row.id }));
  }
  throw _error('This Xen management plane cannot verify host placement');
}

async function hostState(target) {
  const ref = String(target.identity.nativeRef);
  if (target.host.daemon_type === 'proxmox') {
    const row = (await target.client.listNodes()).find(item => String(item.node || item.id) === ref);
    if (!row) throw _error('Proxmox source node disappeared', 'PROVIDER_HOST_NOT_FOUND', 404);
    return { online: String(row.status || '').toLowerCase() === 'online', maintenance: null, enabled: true };
  }
  if (target.host.daemon_type === 'vsphere') {
    const row = (await target.client.listHosts()).find(item => String(item.moref) === ref);
    if (!row) throw _error('vSphere source host disappeared', 'PROVIDER_HOST_NOT_FOUND', 404);
    return {
      online: String(row.connectionState || '').toLowerCase() === 'connected',
      maintenance: row.maintenanceMode === true, enabled: true,
    };
  }
  if (target.client.provider === 'xapi') {
    const row = await target.client.getHost(ref);
    return { online: true, maintenance: row.enabled === false, enabled: row.enabled };
  }
  const row = (await target.client.listHosts()).find(item => String(item.id) === ref || String(item.uuid) === target.identity.uuid);
  if (!row) throw _error('Xen source host disappeared', 'PROVIDER_HOST_NOT_FOUND', 404);
  return { online: true, maintenance: null, enabled: row.enabled !== false };
}

async function prepare(target, goal, timeoutSeconds) {
  if (target.host.daemon_type !== 'xen') return null;
  if (target.client.provider !== 'xapi') {
    if (goal === 'enter') throw _error('Native Xen maintenance requires an XAPI endpoint');
    return null;
  }
  const state = await hostState(target);
  if (state.enabled === false) return { completed: true, action: 'disable' };
  const result = await target.client.disableHost(target.identity.nativeRef, { timeoutSeconds });
  return { ...result, action: 'disable' };
}

async function enter(target, timeoutSeconds) {
  if (target.host.daemon_type === 'vsphere') {
    const state = await hostState(target);
    if (state.maintenance) return { completed: true, action: 'enter' };
    return target.client.enterHostMaintenance(target.identity.nativeRef, { timeoutSeconds });
  }
  if (target.host.daemon_type === 'xen' && target.client.provider === 'xapi') {
    const state = await hostState(target);
    if (state.maintenance) return { completed: true, action: 'enter' };
    throw _error('XAPI host must be disabled before maintenance entry', 'HOST_MAINTENANCE_REVALIDATION_BLOCKED', 409);
  }
  throw _error('Native maintenance entry is unavailable for this provider');
}

async function exit(target, timeoutSeconds) {
  if (target.host.daemon_type === 'proxmox') return { completed: true, action: 'exit' };
  if (target.host.daemon_type === 'vsphere') {
    const state = await hostState(target);
    if (!state.maintenance) return { completed: true, action: 'exit' };
    return target.client.exitHostMaintenance(target.identity.nativeRef, { timeoutSeconds });
  }
  if (target.host.daemon_type === 'xen' && target.client.provider === 'xapi') {
    const state = await hostState(target);
    if (state.enabled) return { completed: true, action: 'exit' };
    return target.client.enableHost(target.identity.nativeRef, { timeoutSeconds });
  }
  throw _error('Native maintenance exit is unavailable for this provider');
}

function taskRef(target, result, action) {
  if (result?.completed === true) return null;
  if (typeof result?.taskRef !== 'string' || !result.taskRef || result.taskRef.length > 1600) {
    throw _error('Provider maintenance returned no durable task', 'INVALID_PROVIDER_TASK_RESPONSE', 502);
  }
  return JSON.stringify({ provider: target.host.daemon_type, variant: target.variant, ref: result.taskRef, action });
}

function parseTask(value, provider) {
  try {
    const task = JSON.parse(String(value || ''));
    if (task?.provider !== provider || typeof task.ref !== 'string' || task.ref.length > 1600
      || !['disable', 'enter', 'exit'].includes(task.action)) return null;
    return task;
  } catch { return null; }
}

async function taskStatus(target, task) {
  if (target.host.daemon_type === 'vsphere') return target.client.getTaskStatus(task.ref);
  if (target.client.provider === 'xapi') return target.client.getTask(task.ref);
  throw _error('Provider maintenance task cannot be reconciled', 'PROVIDER_TASK_UNAVAILABLE', 502);
}

function taskOutcome(status) {
  const state = String(status?.status || status?.state || '').toLowerCase();
  if (['success', 'succeeded', 'completed', 'complete'].includes(state)) return { done: true };
  if (['failure', 'failed', 'error', 'cancelled', 'canceled'].includes(state)) {
    const detail = Array.isArray(status?.error) ? status.error.join(' ') : status?.error;
    return { failed: true, message: detail || 'Provider maintenance task failed' };
  }
  return { pending: true, state: state || 'unknown' };
}

async function cancelTask(target, task) {
  if (target.host.daemon_type === 'vsphere') {
    const state = await target.client.getTaskStatus(task.ref);
    if (state.cancelable !== true) return false;
    await target.client.cancelTask(task.ref); return true;
  }
  if (target.client.provider === 'xapi') {
    await target.client.cancelTask(task.ref); return true;
  }
  return false;
}

module.exports = {
  open, close, workloads, hostState, prepare, enter, exit,
  taskRef, parseTask, taskStatus, taskOutcome, cancelTask,
  _internals: { _identity, _proxmoxKey },
};
