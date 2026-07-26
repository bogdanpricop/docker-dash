'use strict';

const { fromHostRow } = require('../../proxmox');
const { supported, adapterNotImplemented } = require('./helpers');

const NOT_IMPLEMENTED = [
  'inventory.cluster', 'inventory.network', 'inventory.task',
  'vm.power.start', 'vm.power.shutdown', 'vm.power.force', 'vm.power.reboot',
  'vm.snapshot.list', 'vm.snapshot.create', 'vm.snapshot.revert', 'vm.snapshot.delete',
  'vm.console', 'vm.clone', 'vm.create', 'vm.migrate', 'host.maintenance',
  'cluster.ha.read', 'storage.mutate', 'network.mutate', 'task.read',
  'task.cancel', 'task.cleanup', 'event.stream', 'backup.run',
];

function declared() {
  const features = {
    'inventory.vm': supported(),
    'inventory.host': supported(),
    'inventory.storage': supported(),
    'vm.read': supported(),
    'backup.read': supported(),
  };
  for (const key of NOT_IMPLEMENTED) features[key] = adapterNotImplemented('Proxmox VE');
  return features;
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

module.exports = { type: 'proxmox', declared, probe };

