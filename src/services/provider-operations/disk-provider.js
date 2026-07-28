'use strict';

const identityStore = require('../provider-sdk/identity-store');
const { normalizeVmHardware, _internals: hardwareInternals } = require('../provider-sdk/vm-hardware');
const proxmox = require('../proxmox');
const vsphere = require('../vsphere');
const xen = require('../xen');

function _matches(row, identity) {
  if (identity.uuid && String(row?.uuid || row?.hostUuid || '') === identity.uuid) return true;
  return [row?.ref, row?.moref, row?.id, row?.vmid].filter(value => value !== undefined && value !== null)
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
  return { vmId: target.client.provider === 'xapi' && target.identity.uuid
    ? target.identity.uuid : target.identity.nativeRef };
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
  else throw Object.assign(new Error('Provider does not support common VM disks'), { code: 'PROVIDER_ACTION_UNAVAILABLE' });
  if (host.daemon_type === 'xen' && client.provider !== 'xapi') {
    throw Object.assign(new Error('Disk mutation requires a conformance-tested XenAPI endpoint'), { code: 'PROVIDER_ACTION_UNAVAILABLE' });
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
  const disks = (raw.disks || []).slice(0, 128).map((row, index) => ({
    raw: row,
    portable: portable.disks.find(item => item.id === hardwareInternals._opaqueId(
      'disk', Number(target.host.id), target.vmId, row?.nativeRef ?? row?.id ?? row?.device, index
    )),
  })).filter(item => item.portable);
  return { portable, disks };
}

function diskById(current, diskId) {
  return current.disks.find(item => item.portable.id === diskId) || null;
}

function backingRef(disk) {
  const value = disk?.raw?.backing?.nativeRef ?? disk?.raw?.backing?.path;
  return value === null || value === undefined || value === '' ? null : String(value);
}

function _storageIdentity(target, canonicalId, database) {
  const identity = identityStore.resolveCanonical(canonicalId,
    { hostId: Number(target.host.id), kind: 'storage' }, database);
  if (!identity || identity.providerType !== target.host.daemon_type || identity.stability === 'transient') {
    throw Object.assign(new Error('Target storage identity is unavailable'), { code: 'PROVIDER_STORAGE_NOT_FOUND' });
  }
  return identity;
}

function _proxmoxStorage(value) {
  const text = String(value || '');
  const last = text.split('/').filter(Boolean).at(-1) || text;
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(last)) {
    throw Object.assign(new Error('Invalid Proxmox storage identity'), { code: 'INVALID_PROVIDER_RESOURCE' });
  }
  return last;
}

async function mutate(target, action, request, disk, database) {
  const type = target.host.daemon_type;
  if (action === 'create') {
    const storage = _storageIdentity(target, request.targetStorageId, database);
    if (type === 'proxmox') {
      return target.client.createVmDisk(target.native.node, target.native.vmid, target.native.guestType, {
        device: `${request.bus}${request.unit}`, storage: _proxmoxStorage(storage.nativeRef), sizeBytes: request.sizeBytes,
      });
    }
    if (type === 'vsphere') {
      const current = await inventory(target);
      const controllerKey = current.disks.map(item => item.raw)
        .find(item => item.bus === request.bus && Number.isSafeInteger(Number(item.controllerKey)))?.controllerKey;
      if (!Number.isSafeInteger(Number(controllerKey))) {
        throw Object.assign(new Error('A compatible vSphere disk controller was not found'), { code: 'VM_DISK_CONTROLLER_UNAVAILABLE' });
      }
      return target.client.createVmDisk(target.native.vmMoref, {
        controllerKey: Number(controllerKey), unit: request.unit, sizeBytes: request.sizeBytes,
        datastoreRef: storage.nativeRef, datastoreName: request.targetStorageName,
        provisioning: request.provisioning,
      });
    }
    return target.client.createVmDisk(target.native.vmId, {
      storageRef: storage.nativeRef, sizeBytes: request.sizeBytes, unit: request.unit, label: request.label,
    });
  }
  if (!disk) throw Object.assign(new Error('Provider disk was not found'), { code: 'PROVIDER_VM_DISK_NOT_FOUND' });
  if (action === 'detach') {
    if (type === 'proxmox') return target.client.detachVmDisk(target.native.node, target.native.vmid, target.native.guestType, disk.raw.nativeRef);
    if (type === 'vsphere') return target.client.detachVmDisk(target.native.vmMoref, disk.raw);
    return target.client.detachVmDisk(disk.raw.nativeRef);
  }
  if (action === 'resize') {
    if (type === 'proxmox') return target.client.resizeVmDisk(target.native.node, target.native.vmid, target.native.guestType, disk.raw.nativeRef, request.sizeBytes);
    if (type === 'vsphere') return target.client.resizeVmDisk(target.native.vmMoref, disk.raw, request.sizeBytes);
    const vdi = backingRef(disk);
    if (!vdi) throw Object.assign(new Error('XAPI VDI backing is unavailable'), { code: 'VM_DISK_OWNERSHIP_UNPROVEN' });
    return target.client.resizeVmDisk(vdi, request.sizeBytes);
  }
  if (action === 'move') {
    const storage = _storageIdentity(target, request.targetStorageId, database);
    if (type === 'proxmox') return target.client.moveVmDisk(target.native.node, target.native.vmid, target.native.guestType,
      disk.raw.nativeRef, _proxmoxStorage(storage.nativeRef));
    if (type === 'vsphere') return target.client.moveVmDisk(target.native.vmMoref, disk.raw, storage.nativeRef);
    throw Object.assign(new Error('XAPI disk move is not released'), { code: 'PROVIDER_ACTION_UNAVAILABLE' });
  }
  throw Object.assign(new Error('Unsupported disk action'), { code: 'INVALID_VM_DISK_ACTION' });
}

async function deleteBacking(target, managed) {
  if (target.host.daemon_type === 'proxmox') {
    return target.client.deleteDetachedVmDisk(target.native.node, target.native.vmid,
      target.native.guestType, managed.nativeRef);
  }
  if (target.host.daemon_type === 'xen') return target.client.deleteDetachedVmDisk(managed.nativeRef);
  throw Object.assign(new Error('Managed backing deletion is unavailable for this provider'), { code: 'PROVIDER_ACTION_UNAVAILABLE' });
}

async function backingExists(target, managed) {
  if (target.host.daemon_type === 'proxmox') {
    const config = await target.client.getVmConfig(target.native.node, target.native.guestType, target.native.vmid);
    return Object.entries(config || {}).some(([key, value]) => /^unused\d+$/.test(key)
      && String(value || '').split(',')[0] === managed.nativeRef);
  }
  if (target.host.daemon_type === 'xen') {
    try { await target.client._call('VDI.get_record', [managed.nativeRef]); return true; }
    catch (err) { return !/HANDLE_INVALID|UUID_INVALID|not found/i.test(`${err?.code || ''} ${err?.message || ''}`); }
  }
  return true;
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
  open, close, inventory, diskById, backingRef, mutate, deleteBacking, backingExists, taskStatus, cancelTask,
  _internals: { _matches, _nativeVm, _storageIdentity, _proxmoxStorage },
};
