'use strict';

const { fromHostRow } = require('../../proxmox');
const { supported, conditional, adapterNotImplemented } = require('./helpers');

const NOT_IMPLEMENTED = [
  'inventory.cluster', 'inventory.network', 'inventory.task',
  'vm.console', 'vm.clone', 'vm.create', 'vm.migrate', 'host.maintenance',
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
    if (kind === 'virtualMachine') return (await client.listVMs()).map(row => ({
      ...row, allowedActions: [..._allowedVmActions(row), ..._allowedSnapshotActions(row)],
    }));
    if (kind === 'host') return client.listNodes();
    if (kind === 'storage') return client.listStorages();
    throw new Error(`Proxmox resource kind is unavailable: ${kind}`);
  } finally {
    client._agent?.destroy?.();
  }
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

module.exports = { type: 'proxmox', declared, probe, listResources, listArtifacts, _internals: { _allowedVmActions, _allowedSnapshotActions } };
