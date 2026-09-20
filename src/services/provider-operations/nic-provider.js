'use strict';

const identityStore = require('../provider-sdk/identity-store');
const { normalizeVmHardware, _internals: hardwareInternals } = require('../provider-sdk/vm-hardware');
const proxmox = require('../proxmox');
const vsphere = require('../vsphere');
const xen = require('../xen');

function _matches(row, identity) {
  if (identity.uuid && String(row?.uuid || row?.hostUuid || '') === identity.uuid) return true;
  return [row?.ref, row?.moref, row?.id, row?.vmid]
    .filter(value => value !== undefined && value !== null)
    .some(value => String(value) === identity.nativeRef);
}

function _nativeVm(target, row) {
  if (target.host.daemon_type === 'proxmox') {
    const match = /^(qemu|lxc)\/(\d+)$/.exec(String(row.id || target.identity.nativeRef || ''));
    const guestType = match?.[1] || String(row.type || 'qemu');
    const vmid = match?.[2] || String(row.vmid || target.identity.nativeRef || '');
    const node = String(row.node || '');
    if (!['qemu', 'lxc'].includes(guestType) || !/^\d{1,20}$/.test(vmid)
      || !/^[A-Za-z0-9._-]{1,160}$/.test(node)) {
      throw Object.assign(new Error('Proxmox VM placement is unavailable'), { code: 'INVALID_PROVIDER_RESOURCE' });
    }
    return { node, guestType, vmid };
  }
  if (target.host.daemon_type === 'vsphere') return { vmMoref: String(row.moref || target.identity.nativeRef) };
  return { vmId: target.identity.uuid || target.identity.nativeRef };
}

async function open(host, vmId, database) {
  const identity = identityStore.resolveCanonical(vmId,
    { hostId: Number(host.id), kind: 'virtualMachine' }, database);
  if (!identity || identity.providerType !== host.daemon_type || identity.stability === 'transient') {
    throw Object.assign(new Error('Stable provider VM identity was not found'), { code: 'INVALID_OPERATION_RESOURCE' });
  }
  let client;
  if (host.daemon_type === 'proxmox') client = proxmox.fromHostRow(host);
  else if (host.daemon_type === 'vsphere') client = vsphere.fromHostRow(host);
  else if (host.daemon_type === 'xen') client = xen.clientForHost(host);
  else throw Object.assign(new Error('Provider does not support common VM NIC link control'), { code: 'PROVIDER_ACTION_UNAVAILABLE' });
  if (host.daemon_type === 'xen' && client.provider !== 'xapi') {
    throw Object.assign(new Error('NIC link mutation requires a conformance-tested XenAPI endpoint'), {
      code: 'PROVIDER_ACTION_UNAVAILABLE',
    });
  }
  const target = { host, identity, client, vmId };
  try {
    if (host.daemon_type === 'vsphere') await client.login();
    const rows = await client.listVMs();
    target.row = rows.find(item => _matches(item, identity));
    if (!target.row) throw Object.assign(new Error('Provider VM was not found'), { code: 'PROVIDER_VM_NOT_FOUND' });
    target.native = _nativeVm(target, target.row);
    return target;
  } catch (err) { await close(target); throw err; }
}

async function close(target) {
  if (!target?.client) return;
  if (target.host.daemon_type === 'vsphere') {
    try { await target.client.logout?.(); } catch { /* best effort */ }
    target.client._agent?.destroy?.();
  } else if (target.host.daemon_type === 'proxmox') target.client._agent?.destroy?.();
  else await target.client.close?.();
}

async function _rawHardware(target) {
  if (target.host.daemon_type === 'proxmox') {
    return target.client.getVmHardware(target.native.node, target.native.guestType, target.native.vmid);
  }
  if (target.host.daemon_type === 'vsphere') return target.client.getVmHardware(target.native.vmMoref);
  return target.client.getVmHardware(target.native.vmId);
}

async function inventory(target) {
  const raw = await _rawHardware(target);
  const resource = {
    id: target.vmId, kind: 'virtualMachine', provider: { endpointId: Number(target.host.id) },
  };
  const portable = normalizeVmHardware({
    host: target.host, providerType: target.host.daemon_type, resource, raw,
  });
  const nics = (raw.nics || []).slice(0, 64).map((row, index) => ({
    raw: row,
    portable: portable.nics.find(item => item.id === hardwareInternals._opaqueId(
      'nic', Number(target.host.id), target.vmId,
      row?.nativeRef ?? row?.id ?? row?.device ?? row?.macAddress, index
    )),
  })).filter(item => item.portable);
  return { portable, nics };
}

function nicById(current, nicId) {
  return current.nics.find(item => item.portable.id === nicId) || null;
}

async function mutate(target, action, nic) {
  if (!nic || !['connect', 'disconnect'].includes(action)) {
    throw Object.assign(new Error('Invalid VM NIC link action'), { code: 'INVALID_VM_NIC_LINK_REQUEST' });
  }
  const connected = action === 'connect';
  if (target.host.daemon_type === 'proxmox') {
    return target.client.setVmNicLinkState(target.native.node, target.native.vmid,
      target.native.guestType, nic.raw.nativeRef, connected);
  }
  if (target.host.daemon_type === 'vsphere') {
    return target.client.setVmNicLinkState(target.native.vmMoref, nic.raw, connected);
  }
  return target.client.setVmNicLinkState(nic.raw.nativeRef, connected);
}

async function taskStatus(target, task) {
  if (target.host.daemon_type === 'proxmox') return target.client.getTaskStatus(task.node, task.ref);
  if (target.host.daemon_type === 'vsphere') return target.client.getTaskStatus(task.ref);
  return target.client.getTask(task.ref);
}

async function cancelTask(target, task) {
  if (target.host.daemon_type === 'proxmox') {
    await target.client.stopTask(task.node, task.ref); return true;
  }
  if (target.host.daemon_type === 'vsphere') {
    try { await target.client.cancelTask(task.ref); return true; } catch { return false; }
  }
  try { await target.client.cancelTask(task.ref); return true; } catch { return false; }
}

module.exports = {
  open, close, inventory, nicById, mutate, taskStatus, cancelTask,
  _internals: { _matches, _nativeVm },
};
