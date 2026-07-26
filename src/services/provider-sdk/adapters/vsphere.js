'use strict';

const { fromHostRow } = require('../../vsphere');
const { supported, conditional, adapterNotImplemented } = require('./helpers');

const NOT_IMPLEMENTED = [
  'inventory.cluster', 'inventory.task',
  'vm.console', 'vm.clone', 'vm.create', 'vm.migrate', 'host.maintenance',
  'cluster.ha.read', 'storage.mutate', 'network.mutate', 'task.read',
  'task.cancel', 'task.cleanup', 'event.stream', 'backup.read', 'backup.run',
];

function declared() {
  const features = {
    'inventory.vm': supported(),
    'inventory.host': supported(),
    'inventory.storage': supported(),
    'inventory.network': supported(),
    'inventory.image': supported(),
    'vm.read': supported(),
    'vm.power.start': conditional('Availability is checked from current VM state', { perResource: true, durableTask: true }),
    'vm.power.shutdown': conditional('Clean shutdown requires running VMware Tools', { perResource: true, requiresGuestTools: true }),
    'vm.power.force': conditional('Forced power requires typed confirmation', { perResource: true, confirmation: true, durableTask: true }),
    'vm.power.reboot': conditional('Clean reboot requires running VMware Tools', { perResource: true, requiresGuestTools: true }),
    'vm.snapshot.list': conditional('Snapshot support is checked from VM capabilities', { perResource: true }),
    'vm.snapshot.create': conditional('Quiesced mode requires a powered-on VM and running VMware Tools', { perResource: true, durableTask: true, consistency: ['crash', 'quiesced'] }),
    'vm.snapshot.revert': conditional('Snapshot ownership and current VM state are revalidated', { perResource: true, durableTask: true, confirmation: true }),
    'vm.snapshot.delete': conditional('Snapshot child dependencies are revalidated', { perResource: true, durableTask: true, confirmation: true }),
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
    return {
      provider: {
        type: 'vsphere', variant: _variant(info),
        product: info?.productFullName || 'VMware vSphere / ESXi',
        version: info?.version || null, apiVersion: info?.apiVersion || null,
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
    await client.login();
    if (kind === 'virtualMachine') return (await client.listVMs()).map(row => ({
      ...row, allowedActions: [..._allowedVmActions(row), ..._allowedSnapshotActions(row)],
    }));
    if (kind === 'host') return await client.listHosts();
    if (kind === 'storage') return await client.listDatastores();
    if (kind === 'network') return await client.listNetworks();
    throw new Error(`vSphere resource kind is unavailable: ${kind}`);
  } finally {
    try { await client.logout?.(); } catch { /* best-effort session cleanup */ }
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

module.exports = { type: 'vsphere', declared, probe, listResources, listArtifacts, _internals: { _variant, _allowedVmActions, _allowedSnapshotActions } };
