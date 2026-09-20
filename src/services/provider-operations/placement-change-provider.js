'use strict';

const { fromHostRow: proxmoxFromHost } = require('../proxmox');
const { fromHostRow: vsphereFromHost } = require('../vsphere');
const xen = require('../xen');
const identityStore = require('../provider-sdk/identity-store');
const registrySingleton = require('../provider-sdk/registry');
const advisory = require('../provider-sdk/placement-advisory');
const { sha256 } = require('../../utils/crypto');

function _error(message, code = 'PROVIDER_PLACEMENT_MUTATION_UNAVAILABLE', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function _identity(host, id, kind, database) {
  const value = identityStore.resolveCanonical(id, { hostId: Number(host.id), kind }, database);
  if (!value || value.providerType !== host.daemon_type || value.stability === 'transient') {
    throw _error(`Stable ${kind} identity was not found`, 'UNSTABLE_PROVIDER_IDENTITY', 409);
  }
  return value;
}

async function open(host, database) {
  let client;
  if (host.daemon_type === 'proxmox') client = proxmoxFromHost(host);
  else if (host.daemon_type === 'vsphere') { client = vsphereFromHost(host); await client.login(); }
  else if (host.daemon_type === 'xen') {
    client = xen.clientForHost(host);
    if (client.provider !== 'xapi') throw _error('Placement mutation requires an XAPI endpoint');
  } else throw _error('Placement mutation is unavailable for this provider');
  return { host, database, client, variant: client.provider || host.daemon_type };
}

async function close(target) {
  if (!target?.client) return;
  try { await target.client.logout?.(); } catch { /* best effort */ }
  try { await target.client.close?.(); } catch { /* best effort */ }
  try { target.client._agent?.destroy?.(); } catch { /* best effort */ }
}

function _proxmoxSid(identity) {
  const match = /^(qemu|lxc)\/(\d+)$/.exec(String(identity.nativeRef || ''));
  if (!match) throw _error('Proxmox workload identity is invalid', 'INVALID_PROVIDER_RESOURCE', 409);
  return `${match[1] === 'lxc' ? 'ct' : 'vm'}:${match[2]}`;
}

function _ruleId(host, nativeId, kind) {
  return `ddp_rule_${sha256(`${host.id}|${nativeId}|${kind}`).slice(0, 26)}`;
}

function _portableKind(rawKind) { return advisory._internals._ruleKind(rawKind); }

async function _canonicalMaps(target) {
  const registry = registrySingleton;
  const [vms, hosts, clusters] = await Promise.all([
    registry.resourcesForHost(target.host, 'virtual-machines', { limit: 500, database: target.database }),
    registry.resourcesForHost(target.host, 'hosts', { limit: 64, database: target.database }),
    registry.resourcesForHost(target.host, 'clusters', { limit: 64, database: target.database }).catch(() => ({ items: [] })),
  ]);
  const collect = (items, kind) => {
    const map = new Map();
    for (const item of items) {
      const identity = _identity(target.host, item.id, kind, target.database);
      const nativeRef = String(identity.nativeRef);
      map.set(nativeRef, item.id);
      if (identity.uuid) map.set(String(identity.uuid), item.id);
      const guest = /^(qemu|lxc)\/(\d+)$/.exec(nativeRef);
      if (guest) {
        map.set(guest[2], item.id);
        map.set(`${guest[1] === 'lxc' ? 'ct' : 'vm'}:${guest[2]}`, item.id);
      }
    }
    return map;
  };
  return { vm: collect(vms.items, 'virtualMachine'), host: collect(hosts.items, 'host'), cluster: collect(clusters.items, 'cluster') };
}

async function snapshotHaPolicy(target, input) {
  const vmIdentity = _identity(target.host, input.vmId, 'virtualMachine', target.database);
  if (target.host.daemon_type === 'proxmox') {
    const sid = _proxmoxSid(vmIdentity);
    const row = (await target.client.getHaResources()).find(item => String(item.sid || item.id) === sid) || null;
    return {
      portable: {
        vmId: input.vmId, restartPolicy: !row || String(row.state || '').toLowerCase() === 'disabled' ? 'disabled' : 'guaranteed',
        maxRestarts: row?.max_restart === undefined ? 1 : Number(row.max_restart),
        maxRelocations: row?.max_relocate === undefined ? 1 : Number(row.max_relocate),
      },
      native: { vmRef: vmIdentity.nativeRef, sid, exists: !!row },
    };
  }
  if (target.host.daemon_type === 'vsphere') {
    const clusterIdentity = _identity(target.host, input.clusterId, 'cluster', target.database);
    const clusters = await target.client.listClusters({ placement: true });
    const cluster = clusters.find(item => String(item.moref) === String(clusterIdentity.nativeRef));
    if (!cluster) throw _error('vSphere cluster was not found', 'PROVIDER_CLUSTER_NOT_FOUND', 404);
    const override = cluster.vmPriorities?.[vmIdentity.nativeRef] || null;
    const nativePriority = override?.restartPriority || 'default';
    const priority = nativePriority === 'clusterDefault' ? 'default' : nativePriority;
    return {
      portable: { vmId: input.vmId, clusterId: input.clusterId,
        restartPolicy: priority === 'disabled' ? 'disabled' : 'guaranteed', restartPriority: priority },
      native: { vmRef: vmIdentity.nativeRef, clusterRef: clusterIdentity.nativeRef, overrideExists: !!override },
    };
  }
  const vm = await target.client.getVm(vmIdentity.nativeRef);
  const priority = String(vm.ha_restart_priority || '');
  return {
    portable: {
      vmId: input.vmId,
      restartPolicy: priority === 'restart' ? 'guaranteed' : (priority === 'best-effort' ? 'best_effort' : 'disabled'),
      startOrder: Number(vm.order || 0), startDelaySeconds: Number(vm.start_delay || 0),
    },
    native: { vmRef: vmIdentity.nativeRef },
  };
}

async function snapshotAffinity(target, input) {
  const inventory = await registrySingleton.placementInventoryForHost(target.host, { database: target.database });
  const maps = await _canonicalMaps(target);
  const rules = inventory.rules.map(raw => {
    const kind = _portableKind(raw.kind);
    const nativeId = String(raw.nativeId || '');
    return {
      portable: {
        id: _ruleId(target.host, nativeId, kind), name: String(raw.name || nativeId), kind,
        enabled: raw.enabled !== false, mandatory: raw.mandatory === true,
        vmIds: (raw.vmRefs || []).map(ref => maps.vm.get(String(ref))).filter(Boolean),
        hostIds: (raw.hostRefs || []).map(ref => maps.host.get(String(ref))).filter(Boolean),
        clusterId: raw.scopeRef ? maps.cluster.get(String(raw.scopeRef)) || null : null,
      },
      native: { id: nativeId, scopeRef: raw.scopeRef || null, vmRefs: raw.vmRefs || [], hostRefs: raw.hostRefs || [] },
    };
  });
  if (input.action === 'create') return { portable: null, native: null, rules };
  const found = rules.find(rule => rule.portable.id === input.ruleId);
  if (!found) throw _error('Placement rule was not found', 'PLACEMENT_RULE_NOT_FOUND', 404);
  return { ...found, rules };
}

async function snapshot(target, kind, input) {
  if (kind === 'ha_policy') return snapshotHaPolicy(target, input);
  if (kind === 'affinity_rule') return snapshotAffinity(target, input);
  throw _error('Provider snapshot kind is invalid', 'INVALID_PLACEMENT_CHANGE_KIND');
}

function _pveRuleBody(target, desired) {
  const vmRefs = desired.vmIds.map(id => _proxmoxSid(_identity(target.host, id, 'virtualMachine', target.database)));
  if (desired.kind === 'vm_vm_affinity' || desired.kind === 'vm_vm_anti_affinity') return {
    type: 'resource-affinity', resources: vmRefs.join(','),
    affinity: desired.kind === 'vm_vm_anti_affinity' ? 'separate' : 'together',
    disable: desired.enabled === false ? 1 : 0,
  };
  if (desired.kind === 'vm_host_affinity') return {
    type: 'node-affinity', resources: vmRefs.join(','),
    nodes: desired.hostIds.map(id => _identity(target.host, id, 'host', target.database).nativeRef).join(','),
    strict: desired.mandatory === true ? 1 : 0, disable: desired.enabled === false ? 1 : 0,
  };
  throw _error('This Proxmox affinity rule kind is unsupported', 'PLACEMENT_RULE_KIND_UNSUPPORTED');
}

async function applyHaPolicy(target, desired, beforeNative) {
  if (target.host.daemon_type === 'proxmox') {
    if (desired.restartPolicy === 'best_effort') throw _error('Proxmox has no portable best-effort restart policy', 'HA_POLICY_VALUE_UNSUPPORTED');
    const body = { state: desired.restartPolicy === 'disabled' ? 'disabled' : 'started' };
    if (desired.maxRestarts !== undefined) body.max_restart = desired.maxRestarts;
    if (desired.maxRelocations !== undefined) body.max_relocate = desired.maxRelocations;
    if (beforeNative.exists) await target.client.updateHaResource(beforeNative.sid, body);
    else await target.client.createHaResource({ sid: beforeNative.sid, ...body });
    return { completed: true };
  }
  if (target.host.daemon_type === 'vsphere') {
    if (desired.restartPolicy === 'best_effort') throw _error('vSphere HA has no portable best-effort VM override', 'HA_POLICY_VALUE_UNSUPPORTED');
    const priority = desired.restartPolicy === 'disabled' ? 'disabled'
      : (desired.restartPriority === 'default' ? 'clusterDefault' : desired.restartPriority);
    return target.client.reconfigureCluster(beforeNative.clusterRef, {
      kind: 'ha_policy', operation: beforeNative.overrideExists ? 'edit' : 'add',
      vmRef: beforeNative.vmRef, restartPriority: priority,
    });
  }
  const priority = { disabled: '', best_effort: 'best-effort', guaranteed: 'restart' }[desired.restartPolicy];
  return target.client.setVmHaPolicy(beforeNative.vmRef, {
    haRestartPriority: priority, order: desired.startOrder, startDelay: desired.startDelaySeconds,
  });
}

async function _applyXapiAffinity(target, action, desired, before) {
  if ((desired || before)?.kind === 'home_host_preference') {
    const vmId = (desired || before).vmIds[0];
    const vmRef = _identity(target.host, vmId, 'virtualMachine', target.database).nativeRef;
    const hostRef = action === 'delete' ? null
      : _identity(target.host, desired.hostIds[0], 'host', target.database).nativeRef;
    return target.client.setVmAffinity(vmRef, hostRef);
  }
  if (action === 'create') {
    const created = await target.client.createVmGroup({ name: desired.name, placement: 'anti_affinity' });
    for (const vmId of desired.vmIds) {
      const vmRef = _identity(target.host, vmId, 'virtualMachine', target.database).nativeRef;
      const vm = await target.client.getVm(vmRef);
      await target.client.setVmGroups(vmRef, [...new Set([...(vm.groups || []), created.ref])]);
    }
    return { completed: true, createdRef: created.ref };
  }
  const groupRef = before._nativeId;
  const beforeIds = new Set(before.vmIds);
  const desiredIds = new Set(action === 'delete' ? [] : desired.vmIds);
  for (const vmId of new Set([...beforeIds, ...desiredIds])) {
    const vmRef = _identity(target.host, vmId, 'virtualMachine', target.database).nativeRef;
    const vm = await target.client.getVm(vmRef);
    const groups = (vm.groups || []).filter(ref => String(ref) !== String(groupRef));
    if (desiredIds.has(vmId)) groups.push(groupRef);
    await target.client.setVmGroups(vmRef, [...new Set(groups)]);
  }
  if (action === 'delete') await target.client.destroyVmGroup(groupRef);
  return { completed: true };
}

async function applyAffinity(target, action, desired, before, beforeNative) {
  if (target.host.daemon_type === 'proxmox') {
    if (action === 'delete') { await target.client.deleteHaRule(beforeNative.id); return { completed: true }; }
    const body = _pveRuleBody(target, desired);
    if (action === 'create') await target.client.createHaRule({ rule: desired.name, ...body });
    else await target.client.updateHaRule(beforeNative.id, body);
    return { completed: true };
  }
  if (target.host.daemon_type === 'vsphere') {
    const clusterRef = action === 'create'
      ? _identity(target.host, desired.clusterId, 'cluster', target.database).nativeRef
      : beforeNative.scopeRef;
    if (!clusterRef) throw _error('vSphere rule cluster scope is unavailable', 'PROVIDER_CLUSTER_NOT_FOUND', 404);
    const change = action === 'delete'
      ? { kind: 'affinity_rule', operation: 'remove', key: beforeNative.id }
      : { kind: 'affinity_rule', operation: action === 'create' ? 'add' : 'edit',
        key: action === 'create' ? null : beforeNative.id, ruleKind: desired.kind,
        name: desired.name, enabled: desired.enabled, mandatory: desired.mandatory,
        vmRefs: desired.vmIds.map(id => _identity(target.host, id, 'virtualMachine', target.database).nativeRef) };
    return target.client.reconfigureCluster(clusterRef, change);
  }
  const portableBefore = before ? { ...before, _nativeId: beforeNative.id } : null;
  return _applyXapiAffinity(target, action, desired, portableBefore);
}

async function apply(target, plan) {
  if (plan.changeKind === 'ha_policy') return applyHaPolicy(target, plan.desired, plan._native.before);
  if (plan.changeKind === 'affinity_rule') return applyAffinity(target, plan.action, plan.desired, plan.before, plan._native.before);
  throw _error('Provider apply kind is invalid', 'INVALID_PLACEMENT_CHANGE_KIND');
}

function taskRef(target, result) {
  if (result?.completed === true) return null;
  if (typeof result?.taskRef !== 'string' || !result.taskRef || result.taskRef.length > 1600) {
    throw _error('Provider returned no durable task', 'INVALID_PROVIDER_TASK_RESPONSE', 502);
  }
  return JSON.stringify({ provider: target.host.daemon_type, variant: target.variant, ref: result.taskRef });
}

function parseTask(value, provider) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed?.provider === provider && typeof parsed.ref === 'string' && parsed.ref.length <= 1600 ? parsed : null;
  } catch { return null; }
}

async function taskStatus(target, task) {
  if (target.host.daemon_type === 'vsphere') return target.client.getTaskStatus(task.ref);
  throw _error('Provider task reconciliation is unavailable', 'PROVIDER_TASK_UNAVAILABLE', 502);
}

function taskOutcome(status) {
  const state = String(status?.state || status?.status || '').toLowerCase();
  if (['success', 'succeeded', 'completed', 'complete'].includes(state)) return { done: true };
  if (['error', 'failed', 'failure', 'cancelled', 'canceled'].includes(state)) {
    return { failed: true, message: status?.error || 'Provider placement mutation task failed' };
  }
  return { pending: true, state: state || 'unknown' };
}

module.exports = {
  open, close, snapshot, apply, taskRef, parseTask, taskStatus, taskOutcome,
  _internals: { _identity, _proxmoxSid, _ruleId, _portableKind, _pveRuleBody },
};
