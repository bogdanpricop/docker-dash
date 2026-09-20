'use strict';

const artifactCatalog = require('../provider-sdk/artifact-catalog');
const identityStore = require('../provider-sdk/identity-store');
const { normalizeResource } = require('../provider-sdk/resource-schema');
const proxmox = require('../proxmox');
const vsphere = require('../vsphere');
const xen = require('../xen');
const guestCustomization = require('./guest-customization');

function _nativeRef(raw) {
  return String(raw?.nativeRef ?? raw?.ref ?? raw?.moref ?? raw?.id ?? raw?.uuid ?? '');
}

function _matches(raw, resolved) {
  if (resolved.providerUuid && String(raw?.uuid || '') === resolved.providerUuid) return true;
  return _nativeRef(raw) === resolved.nativeRef;
}

async function _client(host) {
  if (host.daemon_type === 'proxmox') return proxmox.fromHostRow(host);
  if (host.daemon_type === 'vsphere') {
    const client = vsphere.fromHostRow(host); await client.login(); return client;
  }
  if (host.daemon_type === 'xen') return xen.clientForHost(host);
  throw Object.assign(new Error('Provider does not support create-from-template'), { code: 'PROVIDER_ACTION_UNAVAILABLE' });
}

async function open(host, artifactId, database) {
  const resolved = artifactCatalog.resolveArtifact(artifactId, { hostId: Number(host.id) }, database);
  if (!resolved || resolved.artifact.kind !== 'vmTemplate' || resolved.artifact.provider.type !== host.daemon_type) {
    throw Object.assign(new Error('Provider VM template was not found'), { code: 'PROVIDER_ARTIFACT_NOT_FOUND', status: 404 });
  }
  const client = await _client(host);
  const target = { host, artifactId, resolved, artifact: resolved.artifact, client };
  try {
    const rows = host.daemon_type === 'proxmox' ? await client.listArtifacts() : await client.listTemplates();
    target.template = rows.find(row => row.kind === 'vmTemplate' && _matches(row, resolved));
    if (!target.template) {
      throw Object.assign(new Error('Provider VM template is no longer present'), { code: 'PROVIDER_ARTIFACT_NOT_FOUND', status: 404 });
    }
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

function _resolveStorage(target, storageId, database) {
  if (!storageId) return null;
  const identity = identityStore.resolveCanonical(storageId, {
    hostId: Number(target.host.id), kind: 'storage',
  }, database);
  if (!identity || identity.providerType !== target.host.daemon_type || identity.stability === 'transient') {
    throw Object.assign(new Error('Selected provider storage was not found'), { code: 'PROVIDER_PLACEMENT_UNAVAILABLE', status: 409 });
  }
  return identity;
}

async function submit(target, request, database) {
  const storage = _resolveStorage(target, request.storageId, database);
  if (target.host.daemon_type === 'proxmox') {
    const source = /^qemu\/(\d{1,20})$/.exec(target.resolved.nativeRef);
    const node = String(target.template.node || target.artifact.provenance?.node || '');
    if (!source || !/^[A-Za-z0-9._-]{1,160}$/.test(node)) {
      throw Object.assign(new Error('Proxmox template placement is unavailable'), { code: 'PROVIDER_PLACEMENT_UNAVAILABLE' });
    }
    let storageName = null;
    if (storage) {
      const rows = await target.client.listStorages();
      const row = rows.find(item => [item.id, item.ref, item.storage, item.uuid].some(value => String(value || '') === storage.nativeRef));
      storageName = row?.storage || row?.name || null;
      if (!storageName) throw Object.assign(new Error('Selected Proxmox storage is unavailable'), { code: 'PROVIDER_PLACEMENT_UNAVAILABLE' });
    }
    if (request.targetNode) {
      const nodes = await target.client.listNodes();
      if (!nodes.some(item => item.node === request.targetNode)) {
        throw Object.assign(new Error('Selected Proxmox target node is unavailable'), { code: 'PROVIDER_PLACEMENT_UNAVAILABLE', status: 409 });
      }
    }
    const newid = request.targetVmid || await target.client.nextVmId();
    return target.client.cloneTemplate(node, source[1], {
      newid, name: request.name, mode: request.mode,
      targetNode: request.targetNode || null, storage: storageName,
    });
  }
  if (target.host.daemon_type === 'vsphere') {
    const placement = await target.client.getClonePlacement(target.resolved.nativeRef);
    const datastoreRef = storage?.nativeRef || placement.sourceDatastores[0]?.moref;
    if (!datastoreRef || (storage && !placement.datastores.some(item => item.moref === datastoreRef))) {
      throw Object.assign(new Error('Selected datastore is not attached to the source template'), { code: 'PROVIDER_PLACEMENT_UNAVAILABLE', status: 409 });
    }
    return target.client.cloneTemplate(target.resolved.nativeRef, {
      name: request.name, mode: request.mode, folderRef: placement.folderRef,
      poolRef: placement.poolRef, datastoreRef, customization: request.customization || null,
    });
  }
  if (target.client.provider === 'xo') {
    const poolId = String(target.template.pool || target.artifact.provenance?.pool || '');
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(poolId)) {
      throw Object.assign(new Error('Xen Orchestra template pool is unavailable'), { code: 'PROVIDER_PLACEMENT_UNAVAILABLE', status: 409 });
    }
    const customization = request.customization || null;
    return target.client.cloneTemplate(target.resolved.nativeRef, request.name, {
      mode: request.mode, poolId,
      ...(customization ? {
        cloudConfig: guestCustomization.renderCloudConfig(customization),
        networkConfig: guestCustomization.renderNetworkConfig(customization),
      } : {}),
    });
  }
  if (target.client.provider !== 'xapi') {
    throw Object.assign(new Error('Xen management provider has no task-safe template instantiation workflow'), { code: 'PROVIDER_ACTION_UNAVAILABLE', status: 409 });
  }
  if (request.customization) {
    throw Object.assign(new Error('Direct XAPI guest customization is unavailable'), { code: 'GUEST_CUSTOMIZATION_UNSUPPORTED', status: 409 });
  }
  const storageRef = request.mode === 'full'
    ? (storage?.nativeRef || await target.client.defaultStorageRef()) : null;
  return target.client.cloneTemplate(target.resolved.nativeRef, request.name, { mode: request.mode, storageRef });
}

async function taskStatus(target, task) {
  if (target.host.daemon_type === 'proxmox') return target.client.getTaskStatus(task.node, task.ref);
  if (target.host.daemon_type === 'vsphere') return target.client.getTaskStatus(task.ref);
  return target.client.getTask(task.ref);
}

function taskResultRef(target, status) {
  if (target.host.daemon_type === 'vsphere') return status?.resultRef || null;
  if (target.client.provider !== 'xapi') return null;
  const match = /OpaqueRef:[A-Za-z0-9._:-]{1,512}/.exec(String(status?.result || ''));
  return match?.[0] || null;
}

async function provision(target, vmRef) {
  if (target.client.provider !== 'xapi') throw Object.assign(new Error('Provider has no second provisioning stage'), { code: 'PROVIDER_ACTION_UNAVAILABLE' });
  return target.client.provisionClonedVm(vmRef);
}

async function provisionState(target, vmRef) {
  if (target.client.provider !== 'xapi') return { state: 'unsupported', taskRef: null };
  const record = await target.client.getVmRecordByRef(vmRef);
  const current = Object.entries(record?.current_operations || {})
    .find(([, action]) => String(action || '').toLowerCase() === 'provision');
  if (current?.[0]) return { state: 'running', taskRef: current[0] };
  const allowed = new Set((record?.allowed_operations || []).map(value => String(value).toLowerCase()));
  return allowed.has('provision')
    ? { state: 'ready', taskRef: null }
    : { state: 'complete', taskRef: null };
}

function _proxmoxVmTarget(found) {
  const vmid = String(found?.raw?.vmid || /^qemu\/(\d{1,20})$/.exec(String(found?.nativeRef || ''))?.[1] || '');
  const node = String(found?.raw?.node || '');
  if (!/^\d{1,20}$/.test(vmid) || !/^[A-Za-z0-9._-]{1,160}$/.test(node)) {
    throw Object.assign(new Error('Created Proxmox VM placement is unavailable'), { code: 'PROVIDER_PLACEMENT_UNAVAILABLE', status: 409 });
  }
  return { node, vmid };
}

async function customize(target, found, customization) {
  if (target.host.daemon_type !== 'proxmox') {
    throw Object.assign(new Error('Provider has no separate guest customization stage'), { code: 'PROVIDER_ACTION_UNAVAILABLE' });
  }
  const vm = _proxmoxVmTarget(found);
  return target.client.configureCloudInit(vm.node, vm.vmid, customization);
}

async function customizationStatus(target, found, customization) {
  if (target.host.daemon_type !== 'proxmox') return { configured: true, provider: target.client.provider };
  const vm = _proxmoxVmTarget(found);
  return target.client.cloudInitStatus(vm.node, vm.vmid, customization);
}

async function findByName(target, name, database, options = {}) {
  const rows = await target.client.listVMs();
  let selected = rows.filter(row => Number(row?.template) !== 1
    && String(row.name ?? row.name_label ?? '') === name);
  if (target.host.daemon_type === 'proxmox' && options.targetVmid) {
    selected = rows.filter(row => String(row.vmid ?? '').trim() === String(options.targetVmid));
  }
  if (selected.length > 1) {
    throw Object.assign(new Error('Provider returned multiple VMs with the requested target identity'), { code: 'PROVIDER_TARGET_AMBIGUOUS' });
  }
  if (!selected.length) return null;
  const raw = selected[0];
  const resource = normalizeResource({
    host: target.host, providerType: target.host.daemon_type, kind: 'virtualMachine', raw,
    observedAt: new Date().toISOString(), database,
  });
  return { resource, nativeRef: _nativeRef(raw), raw };
}

async function cancelTask(target, task) {
  if (target.host.daemon_type !== 'proxmox') return false;
  await target.client.stopTask(task.node, task.ref); return true;
}

module.exports = {
  open, close, submit, taskStatus, taskResultRef, provision, provisionState,
  customize, customizationStatus, findByName, cancelTask,
  _internals: { _nativeRef, _matches, _resolveStorage, _proxmoxVmTarget },
};
