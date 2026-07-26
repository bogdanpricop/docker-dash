'use strict';

const xen = require('../../xen');
const {
  supported, unsupported, conditional, adapterNotImplemented,
} = require('./helpers');

function _fromCapabilities(capabilities = {}) {
  const features = {
    'inventory.vm': capabilities.vms ? supported() : unsupported('VM inventory is unavailable for this Xen provider'),
    'inventory.host': capabilities.hosts ? supported() : unsupported('Host inventory is unavailable for this Xen provider'),
    'inventory.cluster': capabilities.pools ? supported() : unsupported('Pools are unavailable for standalone raw Xen'),
    'inventory.storage': capabilities.storages ? supported() : unsupported('Storage inventory is unavailable for this Xen provider'),
    'inventory.network': capabilities.networks ? supported() : unsupported('Network inventory is unavailable for this Xen provider'),
    'inventory.task': capabilities.tasks ? supported() : unsupported('Native tasks are unavailable for this Xen provider'),
    'vm.read': capabilities.vms ? supported() : unsupported('VM detail is unavailable for this Xen provider'),
    'cluster.ha.read': capabilities.pools
      ? conditional('HA evidence depends on pool configuration and shared storage', { requiresPool: true })
      : unsupported('HA is unavailable for standalone raw Xen'),
    'task.read': capabilities.tasks ? supported() : unsupported('Native tasks are unavailable for this Xen provider'),
    'task.cleanup': capabilities.taskCleanup ? supported() : unsupported('Task cleanup is unavailable for this Xen provider'),
    'event.stream': capabilities.events ? supported() : adapterNotImplemented('Xen'),
    'backup.read': capabilities.backups ? supported() : adapterNotImplemented('Xen'),
    'backup.run': capabilities.backups ? supported() : adapterNotImplemented('Xen'),
  };

  const actions = new Set(capabilities.vmActions || []);
  const actionEvidence = action => actions.has(action)
    ? conditional('Availability is checked again from per-VM allowed operations', { perResource: true })
    : unsupported(`The ${action} action is unavailable for this Xen provider`);
  features['vm.power.start'] = actionEvidence('start');
  features['vm.power.shutdown'] = actionEvidence('shutdown');
  features['vm.power.force'] = actions.has('forceShutdown') || actions.has('forceReboot')
    ? conditional('Forced power is capability-gated per VM and requires explicit confirmation', { perResource: true, confirmation: true })
    : unsupported('Forced power operations are unavailable for this Xen provider');
  features['vm.power.reboot'] = actionEvidence('reboot');

  for (const action of ['list', 'create', 'revert', 'delete']) {
    features[`vm.snapshot.${action}`] = capabilities.snapshots
      ? conditional('Snapshot support is checked per VM and storage backend', { perResource: true })
      : unsupported('Portable snapshots are unavailable for this Xen provider');
  }

  for (const key of [
    'vm.console', 'vm.clone', 'vm.create', 'vm.migrate', 'host.maintenance',
    'storage.mutate', 'network.mutate', 'task.cancel',
  ]) features[key] = adapterNotImplemented('Xen');
  return features;
}

function declared(host) {
  const client = xen.clientForHost(host);
  return _fromCapabilities(client.capabilities());
}

async function probe(host) {
  const client = xen.clientForHost(host);
  const info = await client.info();
  const capabilities = info?.capabilities || client.capabilities();
  return {
    provider: {
      type: 'xen', variant: client.provider || capabilities.provider || 'unknown',
      product: info?.product || 'Xen', version: info?.version || null,
      apiVersion: info?.apiVersion || info?.protocol || null,
    },
    features: _fromCapabilities(capabilities),
  };
}

module.exports = { type: 'xen', declared, probe, _internals: { _fromCapabilities } };
