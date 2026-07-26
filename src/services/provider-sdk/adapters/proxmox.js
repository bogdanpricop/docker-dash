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
    const guestType = match?.[1] || 'qemu';
    let node = context.resource?.extensions?.node || null;
    if (!node) {
      const row = (await client.listVMs()).find(item => Number(item.vmid) === vmid
        && String(item.type || 'qemu') === guestType);
      node = row?.node || null;
    }
    return await client.getVmHardware(node, guestType, vmid);
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

module.exports = { type: 'proxmox', declared, probe, listResources, listArtifacts, readVmHardware, _internals: { _allowedVmActions, _allowedSnapshotActions } };
