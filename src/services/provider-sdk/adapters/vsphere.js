'use strict';

const { fromHostRow } = require('../../vsphere');
const { supported, adapterNotImplemented } = require('./helpers');

const NOT_IMPLEMENTED = [
  'inventory.cluster', 'inventory.task', 'vm.read',
  'vm.power.start', 'vm.power.shutdown', 'vm.power.force', 'vm.power.reboot',
  'vm.snapshot.list', 'vm.snapshot.create', 'vm.snapshot.revert', 'vm.snapshot.delete',
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
  };
  for (const key of NOT_IMPLEMENTED) features[key] = adapterNotImplemented('VMware vSphere');
  return features;
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
    if (kind === 'virtualMachine') return await client.listVMs();
    if (kind === 'host') return await client.listHosts();
    if (kind === 'storage') return await client.listDatastores();
    if (kind === 'network') return await client.listNetworks();
    throw new Error(`vSphere resource kind is unavailable: ${kind}`);
  } finally {
    try { await client.logout?.(); } catch { /* best-effort session cleanup */ }
    client._agent?.destroy?.();
  }
}

module.exports = { type: 'vsphere', declared, probe, listResources, _internals: { _variant } };
