'use strict';

const { fromHostRow } = require('../../vsphere');
const { supported, unsupported, conditional, adapterNotImplemented } = require('./helpers');

const NOT_IMPLEMENTED = [
  'inventory.task',
  'storage.mutate', 'network.mutate', 'task.read',
  'task.cancel', 'task.cleanup', 'event.stream', 'backup.read', 'backup.run',
  'backup.restore.vm', 'backup.restore.disk', 'backup.restore.file',
  'backup.restore.instant', 'backup.restore.differential', 'backup.restore.drill',
  'replication.read', 'replication.configure', 'dr.failover', 'dr.failback', 'dr.test',
];

function declared() {
  const features = {
    'inventory.vm': supported(),
    'inventory.host': supported(),
    'inventory.cluster': conditional('ClusterComputeResource inventory requires a vCenter management plane', { requiresVCenter: true, readOnly: true }),
    'inventory.storage': supported(),
    'inventory.network': supported(),
    'inventory.image': supported(),
    'vm.read': supported(),
    'vm.migration.preflight': conditional('vCenter VMotion compatibility and target host state are queried read-only', { perResource: true, requiresVCenterForMultipleHosts: true }),
    'vm.migration.live': conditional('Live migration requires vCenter, VMotion compatibility, shared fabric and a running VM', { perResource: true }),
    'vm.migration.cold': conditional('Cold migration requires a compatible target host and accessible VM files', { perResource: true }),
    'vm.migration.storage': conditional('Storage relocation feasibility requires target datastore mapping', { perResource: true }),
    'vm.migration.crossCluster': conditional('Cross-cluster readiness is limited to candidates visible inside the same vCenter credential boundary', { sameEndpointOnly: true }),
    'vm.migrate': conditional('RelocateVM_Task is reconciled through its durable vCenter Task and verified from VM runtime placement', {
      perResource: true, modes: ['live', 'cold', 'storage'], durableTask: true,
      cancel: 'when_task_cancelable', confirmation: 'typed_name', revalidate: true,
    }),
    'host.maintenance': conditional('HostSystem maintenance tasks are durable and activation follows controlled evacuation and an empty-host post-check', {
      goals: ['drain', 'enter'], pause: true, resume: true, waves: true,
      nativeEnterExit: true, durableTask: true, confirmation: 'typed_name',
    }),
    'cluster.ha.read': conditional('vSphere HA configuration, admission control and current failover summary are read from ClusterComputeResource', {
      requiresVCenter: true, readOnly: true, simulations: true, history: true,
    }),
    'placement.affinity.read': conditional('vCenter DRS groups and affinity rules are read from ClusterComputeResource', { requiresVCenter: true, readOnly: true }),
    'placement.recommend': conditional('DRS recommendations and common migration evidence are ranked without applying a recommendation', { requiresVCenter: true, readOnly: true }),
    'placement.rebalance.plan': conditional('A bounded dry-run is generated from DRS policy and observed capacity', { requiresVCenter: true, readOnly: true, dryRunOnly: true }),
    'cluster.ha.policy.mutate': conditional('Per-VM DAS settings use one incremental ClusterConfigSpecEx change and a durable task', {
      requiresVCenter: true, fields: ['restartPolicy', 'restartPriority'], approval: 'four_eyes', durableTask: true,
    }),
    'placement.affinity.mutate': conditional('VM affinity and anti-affinity rules use one incremental ClusterRuleSpec change and a durable task', {
      requiresVCenter: true, kinds: ['vm_vm_affinity', 'vm_vm_anti_affinity'], approval: 'four_eyes', durableTask: true,
    }),
    'placement.rebalance.apply': conditional('Approved plans execute through bounded durable RelocateVM_Task child operations', {
      requiresVCenter: true, waves: true, pauseResume: true, rollbackPlan: true, approval: 'four_eyes',
    }),
    'vm.disk.read': conditional('Virtual devices and datastore backing are read live with PropertyCollector', { perResource: true, readOnly: true }),
    'vm.disk.hotplug': conditional('Hot-plug remains unknown unless the VM/device configuration proves it', { perResource: true, evidenceOnly: true }),
    'vm.disk.create': conditional('VirtualDeviceConfigSpec add uses ReconfigVM_Task and post-read verification', {
      perResource: true, durableTask: true, postVerify: true, shrink: false,
    }),
    'vm.disk.attach': adapterNotImplemented('VMware vSphere managed-volume reattachment'),
    'vm.disk.detach': conditional('VirtualDeviceConfigSpec remove omits fileOperation so the backing is retained', {
      perResource: true, durableTask: true, retainBacking: true, postVerify: true,
    }),
    'vm.disk.resize': conditional('VirtualDisk capacity changes use ReconfigVM_Task and reject shrink', {
      perResource: true, durableTask: true, shrink: false, guestExpansionRequired: true, postVerify: true,
    }),
    'vm.disk.move': conditional('Per-disk storage relocation uses RelocateVM_Task and a disk locator', {
      perResource: true, durableTask: true, postVerify: true,
    }),
    'vm.disk.delete': adapterNotImplemented('VMware vSphere detached managed-volume backing deletion'),
    'vm.disk.convert': adapterNotImplemented('VMware vSphere safe common disk conversion'),
    'storage.orphan.read': conditional('Inventory is limited to Docker Dash-managed detached volumes', { readOnly: true, managedOnly: true }),
    'storage.snapshotRisk.read': conditional('Snapshot inventory is correlated with disk mutation preflight', { readOnly: true }),
    'storage.health.read': conditional('Datastore accessibility, maintenance mode and capacity are read from the vSphere PropertyCollector', { readOnly: true, signals: ['accessibility', 'maintenance', 'capacity'] }),
    'storage.policy.read': conditional('Datastore type and shared capacity evidence are read from the vSphere PropertyCollector', { readOnly: true, evidenceOnly: true }),
    'storage.qos.read': adapterNotImplemented('VMware vSphere datastore QoS telemetry'),
    'storage.multipath.read': adapterNotImplemented('VMware vSphere multipath telemetry'),
    'vm.nic.read': conditional('Virtual NICs are correlated with VMware Tools guest-network observations when available', { perResource: true, readOnly: true }),
    'vm.nic.hotplug': conditional('Connect/disconnect evidence is derived from VirtualDeviceConnectInfo', { perResource: true, evidenceOnly: true }),
    'vm.clone': conditional('Full clone requires a valid folder, resource pool and datastore placement', { fromTemplate: true, modes: ['full'], durableTask: true, confirmation: true }),
    'vm.create': conditional('Create-from-template uses CloneVM_Task with live placement revalidation', { fromTemplate: true, durableTask: true, confirmation: true }),
    'vm.guestCustomize': conditional('LinuxPrep is checked against the source template before CloneVM_Task and applies on first boot', {
      duringProvisioning: true, osFamilies: ['linux'], methods: ['linuxPrep'], requiresGuestTools: true,
      fields: ['hostname', 'domain', 'timezone', 'ipv4', 'dns', 'searchDomains'],
    }),
    'vm.console': conditional('A one-time WebMKS ticket is consumed only by the same-origin Docker Dash gateway', {
      perResource: true, protocols: ['webmks', 'rfb'], clients: ['noVNC'],
      singleUseToken: true, credentialIsolation: 'server-side', emergencyLock: true,
    }),
    'vm.power.start': conditional('Availability is checked from current VM state', { perResource: true, durableTask: true }),
    'vm.power.shutdown': conditional('Clean shutdown requires running VMware Tools', { perResource: true, requiresGuestTools: true }),
    'vm.power.force': conditional('Forced power requires typed confirmation', { perResource: true, confirmation: true, durableTask: true }),
    'vm.power.reboot': conditional('Clean reboot requires running VMware Tools', { perResource: true, requiresGuestTools: true }),
    'vm.snapshot.list': conditional('Snapshot support is checked from VM capabilities', { perResource: true }),
    'vm.snapshot.create': conditional('Quiesced mode requires a powered-on VM and running VMware Tools', { perResource: true, durableTask: true, consistency: ['crash', 'quiesced'] }),
    'vm.snapshot.revert': conditional('Snapshot ownership and current VM state are revalidated', { perResource: true, durableTask: true, confirmation: true }),
    'vm.snapshot.delete': conditional('Snapshot child dependencies are revalidated', { perResource: true, durableTask: true, confirmation: true }),
    'vm.snapshot.consolidate': conditional('ConsolidateVMDisks_Task is offered only when runtime.consolidationNeeded is true and is post-read verified', {
      perResource: true, durableTask: true, confirmation: 'typed_name', postVerify: true, requiresConsolidationNeeded: true,
    }),
  };
  for (const key of NOT_IMPLEMENTED) features[key] = adapterNotImplemented('VMware vSphere');
  return features;
}

async function listArtifacts(host) {
  const client = fromHostRow(host);
  try {
    await client.login();
    const [templates, isoImages] = await Promise.all([client.listTemplates(), client.listIsoImages()]);
    return [...templates, ...isoImages];
  } finally {
    try { await client.logout?.(); } catch { /* best-effort session cleanup */ }
    client._agent?.destroy?.();
  }
}

function _variant(info) {
  const product = `${info?.productFullName || ''} ${info?.name || ''}`.toLowerCase();
  if (product.includes('vcenter')) return 'vcenter';
  if (product.includes('esxi') || product.includes('esx')) return 'esxi';
  return 'unknown';
}

async function probe(host) {
  const client = fromHostRow(host);
  try {
    await client.login();
    const info = await client.retrieveServiceContent();
    const variant = _variant(info);
    const features = declared();
    if (variant === 'esxi') {
      for (const key of ['inventory.cluster', 'cluster.ha.read', 'vm.migration.preflight', 'vm.migration.live', 'vm.migration.cold', 'vm.migration.storage', 'vm.migration.crossCluster', 'vm.migrate', 'placement.affinity.read', 'placement.recommend', 'placement.rebalance.plan', 'cluster.ha.policy.mutate', 'placement.affinity.mutate', 'placement.rebalance.apply']) {
        features[key] = unsupported('Standalone ESXi exposes no alternate host inside this provider endpoint');
      }
    }
    return {
      provider: {
        type: 'vsphere', variant,
        product: info?.productFullName || 'VMware vSphere / ESXi',
        version: info?.version || null, apiVersion: info?.apiVersion || null,
      },
      features,
    };
  } finally {
    client._agent?.destroy?.();
  }
}

async function placementInventory(host) {
  const client = fromHostRow(host);
  try {
    await client.login();
    const clusters = await client.listClusters({ placement: true });
    return {
      rules: clusters.flatMap(cluster => (cluster.rules || []).map(rule => ({ ...rule, scopeRef: cluster.moref }))).slice(0, 500),
      nativeRecommendations: clusters.flatMap(cluster => (cluster.drsRecommendations || []).map(item => ({ ...item, scopeRef: cluster.moref }))).slice(0, 500),
      limitations: ['Mandatory DRS rules are feasibility constraints; optional rules affect ranking only'],
    };
  } finally {
    try { await client.logout?.(); } catch { /* best-effort */ }
    client._agent?.destroy?.();
  }
}

async function listResources(kind, host) {
  const client = fromHostRow(host);
  try {
    await client.login();
    if (kind === 'virtualMachine') return (await client.listVMs()).map(row => ({
      ...row, allowedActions: [..._allowedVmActions(row), ..._allowedSnapshotActions(row)],
    }));
    if (kind === 'host') return await client.listHosts();
    if (kind === 'cluster') return await client.listClusters();
    if (kind === 'storage') return await client.listDatastores();
    if (kind === 'network') return await client.listNetworks();
    throw new Error(`vSphere resource kind is unavailable: ${kind}`);
  } finally {
    try { await client.logout?.(); } catch { /* best-effort session cleanup */ }
    client._agent?.destroy?.();
  }
}

async function readVmHardware(host, context) {
  const client = fromHostRow(host);
  try {
    await client.login();
    return await client.getVmHardware(context.identity.nativeRef);
  } finally {
    try { await client.logout?.(); } catch { /* best-effort session cleanup */ }
    client._agent?.destroy?.();
  }
}

async function migrationCompatibility(host, context) {
  const client = fromHostRow(host);
  try {
    await client.login();
    const refs = context.targets.map(target => String(target.identity.nativeRef));
    let result;
    const warnings = [];
    try { result = await client.getVmMigrationCompatibility(context.identity.nativeRef, refs); }
    catch {
      result = { sourceRef: null, candidates: [] };
      warnings.push('vSphere VMotion compatibility could not be queried; candidates remain unknown');
    }
    const compatibility = new Map(result.candidates.map(item => [item.hostRef, new Set(item.compatibility)]));
    return {
      sourceTargetId: context.targets.find(target => String(target.identity.nativeRef) === result.sourceRef)?.resource.id || null,
      warnings,
      candidates: context.targets.map(target => {
        const ref = String(target.identity.nativeRef);
        const current = ref === result.sourceRef;
        const values = compatibility.get(ref);
        const compatible = values?.has('cpu') && values?.has('software');
        const checks = [{
          key: 'vmotion.cpuSoftware', state: values ? (compatible ? 'pass' : 'fail') : 'unknown',
          reason: values ? (compatible ? 'vCenter reports CPU and software VMotion compatibility'
            : 'vCenter did not report both CPU and software VMotion compatibility')
            : 'vCenter returned no VMotion compatibility result for this host',
          confidence: values ? 'high' : 'low',
        }, {
          key: 'fabric.storageNetwork', state: 'unknown',
          reason: 'Storage and network reachability require relocation-specific validation before execution', confidence: 'low',
        }];
        const blockers = values && !compatible
          ? [{ type: 'VMOTION_INCOMPATIBLE', reason: 'vCenter reports CPU/software VMotion incompatibility', modes: ['live'] }] : [];
        return {
          targetId: target.resource.id, current, checks, blockers,
          warnings: [{ type: 'FABRIC_VALIDATION_REQUIRED', reason: 'Datastore and network mappings must be revalidated before execution', modes: ['live', 'cold', 'storage'] }],
          modes: {
            live: current ? 'unsupported' : (compatible ? 'conditional' : (values ? 'unsupported' : 'unknown')),
            cold: current ? 'unsupported' : (values ? 'conditional' : 'unknown'),
            storage: current ? 'unsupported' : (values ? 'conditional' : 'unknown'),
          },
        };
      }),
    };
  } finally {
    try { await client.logout?.(); } catch { /* best-effort */ }
    client._agent?.destroy?.();
  }
}

function _allowedVmActions(row) {
  const state = String(row?.powerState || '').toLowerCase();
  if (state === 'poweredoff') return ['start'];
  if (state !== 'poweredon') return [];
  const actions = ['forceShutdown', 'forceReboot'];
  if (['toolsok', 'toolsold'].includes(String(row?.toolsStatus || '').toLowerCase())) {
    actions.push('shutdown', 'reboot');
  }
  return actions;
}

function _allowedSnapshotActions(row) {
  if (row?.snapshotOperationsSupported !== true) return [];
  const actions = ['snapshot'];
  const state = String(row?.powerState || '').toLowerCase();
  const tools = String(row?.toolsStatus || '').toLowerCase();
  if (state === 'poweredon' && ['toolsok', 'toolsold'].includes(tools)) actions.push('snapshotQuiesced');
  return actions;
}

module.exports = { type: 'vsphere', declared, probe, listResources, listArtifacts, readVmHardware, migrationCompatibility, placementInventory, _internals: { _variant, _allowedVmActions, _allowedSnapshotActions } };
