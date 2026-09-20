'use strict';

const identityStore = require('../provider-sdk/identity-store');
const proxmox = require('../proxmox');
const vsphere = require('../vsphere');
const xen = require('../xen');

function _matches(row, identity) {
  if (identity.uuid && String(row?.uuid || row?.hostUuid || '') === identity.uuid) return true;
  return [row?.ref, row?.moref, row?.id, row?.vmid].filter(value => value !== undefined && value !== null)
    .some(value => String(value) === identity.nativeRef);
}

function _nativeVmTarget(target, row) {
  if (target.host.daemon_type === 'proxmox') {
    const match = /^(qemu|lxc)\/(\d+)$/.exec(String(row.id || target.identity.nativeRef || ''));
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

function _clientForHost(host) {
  let client;
  if (host.daemon_type === 'proxmox') client = proxmox.fromHostRow(host);
  else if (host.daemon_type === 'vsphere') client = vsphere.fromHostRow(host);
  else if (host.daemon_type === 'xen') client = xen.clientForHost(host);
  else throw Object.assign(new Error('Provider does not support common VM snapshots'), { code: 'PROVIDER_ACTION_UNAVAILABLE' });
  return client;
}

async function openHost(host) {
  const session = { host, client: _clientForHost(host), rows: [] };
  try {
    session.rows = await session.client.listVMs();
    if (!Array.isArray(session.rows)) throw Object.assign(new Error('Provider returned invalid VM inventory'), { code: 'INVALID_PROVIDER_RESOURCE' });
    return session;
  } catch (err) { await close(session); throw err; }
}

function targetFromSession(session, vmId, database) {
  const identity = identityStore.resolveCanonical(vmId, {
    hostId: Number(session?.host?.id), kind: 'virtualMachine',
  }, database);
  if (!identity || identity.providerType !== session?.host?.daemon_type || identity.stability === 'transient') {
    throw Object.assign(new Error('Stable provider VM identity was not found'), { code: 'INVALID_OPERATION_RESOURCE' });
  }
  const target = { host: session.host, identity, client: session.client, vmId };
  target.row = session.rows.find(item => _matches(item, identity));
  if (!target.row) throw Object.assign(new Error('Provider VM was not found'), { code: 'PROVIDER_VM_NOT_FOUND' });
  target.native = _nativeVmTarget(target, target.row);
  return target;
}

async function open(host, vmId, database) {
  const session = await openHost(host);
  try { return targetFromSession(session, vmId, database); }
  catch (err) { await close(session); throw err; }
}

async function close(target) {
  if (!target?.client) return;
  if (target.host.daemon_type === 'vsphere') {
    try { await target.client.logout?.(); } catch { /* best-effort */ }
    target.client._agent?.destroy?.();
  } else if (target.host.daemon_type === 'proxmox') target.client._agent?.destroy?.();
  else await target.client.close?.();
}

async function list(target) {
  let rows;
  if (target.host.daemon_type === 'proxmox') {
    rows = await target.client.listVMSnapshots(target.native.node, target.native.vmid, target.native.guestType);
  } else if (target.host.daemon_type === 'vsphere') {
    rows = await target.client.listVMSnapshots(target.native.vmMoref);
  } else rows = await target.client.listSnapshots(target.native.vmId);
  if (!Array.isArray(rows)) throw Object.assign(new Error('Provider returned invalid snapshot inventory'), { code: 'INVALID_PROVIDER_SNAPSHOT_RESPONSE' });
  return rows.map(row => ({
    nativeRef: String(row.nativeRef ?? row.ref ?? row.id ?? ''),
    uuid: row.uuid || null, name: row.name || row.name_label || null,
    description: row.description || null, createdAt: row.createdAt || row.snapshot_time || null,
    sizeBytes: row.sizeBytes ?? null,
    parentRef: row.parentRef || null, isCurrent: row.isCurrent === true,
    consistency: row.consistency || 'unknown',
  }));
}

function _allowsCreate(target, consistency) {
  if (target.host.daemon_type === 'proxmox') return consistency === 'crash' && !target.row?.lock;
  if (target.host.daemon_type === 'vsphere') {
    if (target.row?.snapshotOperationsSupported !== true) return false;
    if (consistency === 'crash') return true;
    return String(target.row?.powerState).toLowerCase() === 'poweredon'
      && ['toolsok', 'toolsold'].includes(String(target.row?.toolsStatus || '').toLowerCase());
  }
  const allowed = new Set(target.row?.allowedActions || []);
  return allowed.has(consistency === 'quiesced' ? 'snapshotQuiesced' : 'snapshot');
}

async function mutate(target, action, input = {}, snapshot = null) {
  if (action === 'consolidate') {
    if (target.host.daemon_type !== 'vsphere' || target.row?.consolidationNeeded !== true) {
      throw Object.assign(new Error('Snapshot consolidation is not currently required by this provider VM'), { code: 'SNAPSHOT_CONSOLIDATION_NOT_REQUIRED' });
    }
    return target.client.consolidateVMDisks(target.native.vmMoref);
  }
  if (action === 'create') {
    if (!_allowsCreate(target, input.consistency)) {
      throw Object.assign(new Error('Snapshot create is unavailable for the current VM/provider state'), { code: 'RESOURCE_ACTION_BLOCKED' });
    }
    if (target.host.daemon_type === 'proxmox') {
      return target.client.createVMSnapshot(target.native.node, target.native.vmid, target.native.guestType, input);
    }
    if (target.host.daemon_type === 'vsphere') {
      return target.client.createVMSnapshot(target.native.vmMoref, { ...input, quiesce: input.consistency === 'quiesced' });
    }
    return target.client.createSnapshot(target.native.vmId, input.name, { quiesce: input.consistency === 'quiesced' });
  }
  if (!snapshot?.nativeRef) throw Object.assign(new Error('Provider snapshot was not found'), { code: 'PROVIDER_SNAPSHOT_NOT_FOUND' });
  if (target.host.daemon_type === 'proxmox') {
    const method = action === 'revert' ? 'revertVMSnapshot' : 'deleteVMSnapshot';
    return target.client[method](target.native.node, target.native.vmid, target.native.guestType, snapshot.nativeRef);
  }
  if (target.host.daemon_type === 'vsphere') {
    return target.client[action === 'revert' ? 'revertVMSnapshot' : 'deleteVMSnapshot'](snapshot.nativeRef);
  }
  const snapshotTarget = target.client.provider === 'xapi' && snapshot.uuid ? snapshot.uuid : snapshot.nativeRef;
  return target.client[action === 'revert' ? 'revertSnapshot' : 'deleteSnapshot'](snapshotTarget);
}

async function consolidationNeeded(target) {
  if (target?.host?.daemon_type !== 'vsphere') return null;
  const rows = await target.client.listVMs();
  const row = rows.find(item => _matches(item, target.identity));
  return row ? row.consolidationNeeded === true : null;
}

async function taskStatus(target, task) {
  if (target.host.daemon_type === 'proxmox') return target.client.getTaskStatus(task.node, task.ref);
  if (target.host.daemon_type === 'vsphere') return target.client.getTaskStatus(task.ref);
  return target.client.getTask(task.ref);
}

async function cancelTask(target, task) {
  if (target.host.daemon_type !== 'proxmox') return false;
  await target.client.stopTask(task.node, task.ref);
  return true;
}

module.exports = {
  open, openHost, targetFromSession, close, list, mutate, consolidationNeeded, taskStatus, cancelTask,
  _internals: { _matches, _nativeVmTarget, _allowsCreate, _clientForHost },
};
