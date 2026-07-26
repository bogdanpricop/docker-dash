'use strict';

const { fromHostRow } = require('../../proxmox');
const { supported, conditional, adapterNotImplemented } = require('./helpers');

const NOT_IMPLEMENTED = [
  'inventory.cluster', 'inventory.network', 'inventory.task',
  'vm.migrate', 'host.maintenance',
  'cluster.ha.read', 'storage.mutate', 'network.mutate', 'task.read',
  'task.cancel', 'task.cleanup', 'event.stream', 'backup.run',
];

function declared() {
  const features = {
    'inventory.vm': supported(),
    'inventory.host': supported(),
    'inventory.storage': supported(),
    'inventory.image': supported(),
    'vm.read': supported(),
    'vm.migration.preflight': conditional('Migration preconditions and target fabric are read without submitting a migration', { perResource: true, readOnly: true }),
    'vm.migration.live': conditional('Online migration depends on guest type, current state, local resources, storage and target networking', { perResource: true }),
    'vm.migration.cold': conditional('Cold migration depends on target storage/network reachability and local resources', { perResource: true }),
    'vm.migration.storage': conditional('Local disk movement requires explicit target storage mapping in the execution batch', { perResource: true }),
    'vm.migration.crossCluster': adapterNotImplemented('Proxmox VE cross-cluster migration'),
    'vm.disk.read': conditional('QEMU and LXC configuration is read live from the current node', { perResource: true, readOnly: true }),
    'vm.disk.hotplug': conditional('The VM hotplug configuration and device type determine availability', { perResource: true, evidenceOnly: true }),
    'vm.nic.read': conditional('Configured NICs are read live; guest IP addresses require the QEMU guest agent', { perResource: true, readOnly: true }),
    'vm.nic.hotplug': conditional('The VM hotplug configuration determines availability', { perResource: true, evidenceOnly: true }),
    'vm.clone': conditional('VM templates support full and storage-dependent linked clones', { fromTemplate: true, modes: ['full', 'linked'], durableTask: true, confirmation: true }),
    'vm.create': conditional('Create-from-template is revalidated against node and storage placement', { fromTemplate: true, durableTask: true, confirmation: true }),
    'vm.guestCustomize': conditional('Cloud-Init settings require a compatible QEMU template and are verified on the cloned VM config', {
      duringProvisioning: true, osFamilies: ['linux'], methods: ['cloud-init'],
      fields: ['hostname', 'user', 'sshAuthorizedKeys', 'ipv4', 'dns', 'searchDomains'],
    }),
    'vm.console': conditional('A short-lived VNC proxy is terminated by the same-origin Docker Dash gateway', {
      perResource: true, protocols: ['rfb'], clients: ['noVNC'],
      singleUseToken: true, credentialIsolation: 'server-side', emergencyLock: true,
    }),
    'backup.read': supported(),
    'vm.power.start': conditional('Availability is checked from current guest state', { perResource: true, durableTask: true }),
    'vm.power.shutdown': conditional('Availability is checked from current guest state', { perResource: true, durableTask: true }),
    'vm.power.force': conditional('Forced power requires typed confirmation', { perResource: true, confirmation: true, durableTask: true }),
    'vm.power.reboot': conditional('Availability is checked from current guest state', { perResource: true, durableTask: true }),
    'vm.snapshot.list': conditional('Snapshot availability depends on guest type and storage backend', { perResource: true }),
    'vm.snapshot.create': conditional('Storage support is revalidated before snapshot creation', { perResource: true, durableTask: true, consistency: ['crash'] }),
    'vm.snapshot.revert': conditional('Snapshot ownership and dependencies are revalidated before revert', { perResource: true, durableTask: true, confirmation: true }),
    'vm.snapshot.delete': conditional('Snapshot ownership and child dependencies are revalidated before delete', { perResource: true, durableTask: true, confirmation: true }),
  };
  for (const key of NOT_IMPLEMENTED) features[key] = adapterNotImplemented('Proxmox VE');
  return features;
}

async function listArtifacts(host) {
  const client = fromHostRow(host);
  try { return await client.listArtifacts(); }
  finally { client._agent?.destroy?.(); }
}

async function probe(host) {
  const client = fromHostRow(host);
  try {
    const version = await client.version();
    return {
      provider: {
        type: 'proxmox', variant: 'pve', product: 'Proxmox VE',
        version: version?.version || null, apiVersion: version?.repoid || null,
      },
      features: declared(),
    };
  } finally {
    client._agent?.destroy?.();
  }
}

async function listResources(kind, host) {
  const client = fromHostRow(host);
  try {
    if (kind === 'virtualMachine') return (await client.listVMs())
      .filter(row => Number(row?.template) !== 1)
      .map(row => ({
        ...row, allowedActions: [..._allowedVmActions(row), ..._allowedSnapshotActions(row)],
      }));
    if (kind === 'host') return client.listNodes();
    if (kind === 'storage') return client.listStorages();
    throw new Error(`Proxmox resource kind is unavailable: ${kind}`);
  } finally {
    client._agent?.destroy?.();
  }
}

async function readVmHardware(host, context) {
  const client = fromHostRow(host);
  try {
    const match = /^(qemu|lxc)\/(\d+)$/.exec(String(context.identity.nativeRef || ''));
    const vmid = match ? Number(match[2]) : Number(context.identity.nativeRef);
    const guestType = match?.[1] || (context.resource?.extensions?.guestType === 'lxc' ? 'lxc' : 'qemu');
    let node = context.resource?.extensions?.node || null;
    if (!node) {
      const row = (await client.listVMs()).find(item => Number(item.vmid) === vmid
        && String(item.type || 'qemu') === guestType);
      node = row?.node || null;
    }
    return await client.getVmHardware(node, guestType, vmid);
  } finally { client._agent?.destroy?.(); }
}

async function migrationCompatibility(host, context) {
  const client = fromHostRow(host);
  try {
    const match = /^(qemu|lxc)\/(\d+)$/.exec(String(context.identity.nativeRef || ''));
    const vmid = match ? Number(match[2]) : Number(context.identity.nativeRef);
    const guestType = match?.[1] || (context.resource?.extensions?.guestType === 'lxc' ? 'lxc' : 'qemu');
    let sourceNode = context.resource?.extensions?.node || null;
    let vmRow = null;
    if (!sourceNode) {
      vmRow = (await client.listVMs()).find(item => Number(item.vmid) === vmid && String(item.type || 'qemu') === guestType);
      sourceNode = vmRow?.node || null;
    }
    const warnings = [];
    const config = sourceNode ? await client.getVmConfig(sourceNode, guestType, vmid) : {};
    let preconditions = {};
    try { preconditions = sourceNode ? await client.getVmMigrationPreconditions(sourceNode, guestType, vmid) : {}; }
    catch { warnings.push('Proxmox migration preconditions could not be read; target checks are incomplete'); }
    const storageIds = new Set();
    const bridges = new Set();
    for (const [key, value] of Object.entries(config || {})) {
      if (/^(?:ide|sata|scsi|virtio)\d+$|^(?:rootfs|mp\d+)$/.test(key) && typeof value === 'string') {
        const storage = /^([^:,]+):/.exec(value)?.[1]; if (storage) storageIds.add(storage);
      }
      if (/^net\d+$/.test(key) && typeof value === 'string') {
        const bridge = /(?:^|,)bridge=([^,]+)/.exec(value)?.[1]; if (bridge) bridges.add(bridge);
      }
    }
    const localResources = [
      ...(Array.isArray(preconditions?.local_resources) ? preconditions.local_resources : []),
      ...Object.keys(config || {}).filter(key => /^(?:hostpci|usb)\d+$/.test(key)),
    ];
    const candidates = [];
    for (const target of context.targets) {
      const node = String(target.identity.nativeRef || target.resource.displayName || '');
      const current = node === sourceNode;
      const blockers = [];
      const checks = [];
      let inventory = null;
      if (!current) {
        try { inventory = await client.getNodeMigrationInventory(node); }
        catch { warnings.push(`Target fabric inventory is unavailable for ${target.resource.displayName}`); }
      }
      if (inventory) {
        const targetStorages = new Set(inventory.storages.filter(item => item.enabled !== 0 && item.active !== 0).map(item => String(item.storage)));
        const missingStorage = [...storageIds].filter(id => !targetStorages.has(id));
        checks.push({ key: 'storage.mapping', state: missingStorage.length ? 'fail' : 'pass',
          reason: missingStorage.length ? 'Target is missing one or more source storage IDs' : 'All source storage IDs are visible on the target', confidence: 'high' });
        if (missingStorage.length) blockers.push({ type: 'STORAGE_MAPPING_REQUIRED', reason: 'Target storage mapping is incomplete', modes: ['live', 'cold', 'storage'] });
        const targetBridges = new Set(inventory.networks.filter(item => /bridge/i.test(String(item.type || item.iface || '')) || item.bridge_ports !== undefined)
          .map(item => String(item.iface || item.name || '')));
        const missingBridges = [...bridges].filter(name => !targetBridges.has(name));
        checks.push({ key: 'network.mapping', state: missingBridges.length ? 'fail' : 'pass',
          reason: missingBridges.length ? 'Target is missing one or more VM bridges' : 'All configured VM bridges exist on the target', confidence: 'high' });
        if (missingBridges.length) blockers.push({ type: 'NETWORK_MAPPING_REQUIRED', reason: 'Target network bridge mapping is incomplete', modes: ['live', 'cold', 'storage'] });
      } else if (!current) checks.push({ key: 'target.fabric', state: 'unknown', reason: 'Target storage and network inventory could not be read', confidence: 'low' });
      if (localResources.length) {
        checks.push({ key: 'device.localResources', state: 'fail', reason: 'VM has host-local or passthrough resources', confidence: 'high' });
        blockers.push({ type: 'LOCAL_RESOURCE_BLOCKED', reason: 'Host-local or passthrough devices require an explicit target mapping', modes: ['live', 'cold', 'storage'] });
      } else checks.push({ key: 'device.localResources', state: 'pass', reason: 'No host-local passthrough resources were reported', confidence: 'medium' });
      checks.push({ key: 'cpu.compatibility', state: 'unknown', reason: 'Proxmox does not expose a side-effect-free per-target CPU compatibility result', confidence: 'low' });
      candidates.push({
        targetId: target.resource.id, current, blockers, checks,
        warnings: [{ type: 'CPU_COMPATIBILITY_UNKNOWN', reason: 'CPU compatibility must be revalidated immediately before execution', modes: ['live'] }],
        modes: {
          live: current ? 'unsupported' : (guestType === 'qemu' && context.resource.status?.powerState === 'running' ? 'conditional' : 'unsupported'),
          cold: current ? 'unsupported' : 'conditional',
          storage: current ? 'unsupported' : (storageIds.size ? 'conditional' : 'unknown'),
        },
      });
    }
    return {
      sourceTargetId: context.targets.find(target => String(target.identity.nativeRef) === sourceNode)?.resource.id || null,
      candidates, warnings,
    };
  } finally { client._agent?.destroy?.(); }
}

function _allowedVmActions(row) {
  const state = String(row?.status || row?.powerState || '').toLowerCase();
  if (['stopped', 'halted', 'poweredoff'].includes(state)) return ['start'];
  if (!['running', 'paused', 'poweredon'].includes(state)) return [];
  const actions = ['shutdown', 'reboot', 'forceShutdown'];
  if (row?.type !== 'lxc') actions.push('forceReboot');
  return actions;
}

function _allowedSnapshotActions(row) {
  const state = String(row?.status || row?.powerState || '').toLowerCase();
  return !row?.lock && ['stopped', 'running', 'paused', 'poweredon', 'poweredoff'].includes(state)
    ? ['snapshot'] : [];
}

module.exports = { type: 'proxmox', declared, probe, listResources, listArtifacts, readVmHardware, migrationCompatibility, _internals: { _allowedVmActions, _allowedSnapshotActions } };
