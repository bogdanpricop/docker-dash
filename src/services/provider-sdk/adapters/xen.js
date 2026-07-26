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
    'inventory.image': capabilities.templates
      ? supported() : unsupported('Template inventory is unavailable for this Xen provider'),
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
  features['vm.console'] = capabilities.console
    ? conditional(capabilities.provider === 'raw'
      ? 'The standalone Xen serial console is relayed over the pinned SSH connection'
      : 'RFB or VT100 is relayed through the same-origin gateway without exposing the management session', {
      perResource: true,
      protocols: capabilities.provider === 'raw' ? ['serial'] : ['rfb', 'serial'],
      clients: capabilities.provider === 'raw' ? ['xterm'] : ['noVNC', 'xterm'],
      singleUseToken: true, credentialIsolation: 'server-side', emergencyLock: true,
    })
    : unsupported(capabilities.provider === 'xo'
      ? 'Xen Orchestra console access requires a scoped authentication token'
      : 'Console access is unavailable for this Xen provider');

  for (const action of ['list', 'create', 'revert', 'delete']) {
    features[`vm.snapshot.${action}`] = capabilities.snapshots
      ? conditional('Snapshot support is checked per VM and storage backend', {
        perResource: true,
        ...(action === 'create' ? { durableTask: true, consistency: capabilities.snapshotQuiesce ? ['crash', 'quiesced'] : ['crash'] } : {}),
        ...(['revert', 'delete'].includes(action) ? { durableTask: true, confirmation: true } : {}),
      })
      : unsupported('Portable snapshots are unavailable for this Xen provider');
  }

  for (const key of [
    'vm.migrate', 'host.maintenance',
    'storage.mutate', 'network.mutate', 'task.cancel',
  ]) features[key] = adapterNotImplemented('Xen');
  const xoProvisioning = capabilities.provider === 'xo';
  features['vm.clone'] = capabilities.provisioning
    ? conditional(xoProvisioning
      ? 'Xen Orchestra template creation uses the discovered task-backed pool create endpoint'
      : 'XAPI template clone/copy is followed by durable VM.provision reconciliation',
    { fromTemplate: true, modes: xoProvisioning ? ['full'] : ['full', 'linked'], durableTask: true, confirmation: true })
    : unsupported('Template provisioning is unavailable for this Xen management provider');
  features['vm.create'] = capabilities.provisioning
    ? conditional(xoProvisioning
      ? 'Create-from-template requires the discovered Xen Orchestra pool task workflow'
      : 'Create-from-template requires a managed XAPI task workflow',
    { fromTemplate: true, durableTask: true, confirmation: true })
    : unsupported('Template provisioning is unavailable for this Xen management provider');
  features['vm.guestCustomize'] = capabilities.guestCustomization
    ? conditional('Xen Orchestra creates a NoCloud/ConfigDrive payload through its task-backed pool create endpoint', {
      duringProvisioning: true, osFamilies: ['linux'], methods: ['cloud-init'],
      fields: ['hostname', 'domain', 'timezone', 'user', 'sshAuthorizedKeys', 'ipv4', 'dns', 'searchDomains'],
    })
    : unsupported(capabilities.provider === 'xapi'
      ? 'Direct XAPI has no portable config-drive upload method; use a compatible Xen Orchestra endpoint'
      : 'Guest customization is unavailable for this Xen management provider');
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

async function listResources(kind, host) {
  const client = xen.clientForHost(host);
  if (kind === 'virtualMachine') return client.listVMs();
  if (kind === 'host') return client.listHosts();
  if (kind === 'cluster') return client.listPools();
  if (kind === 'storage') return client.listStorages();
  if (kind === 'network') return client.listNetworks();
  if (kind === 'task') return client.listTasks();
  throw new Error(`Xen resource kind is unavailable: ${kind}`);
}

async function listArtifacts(host) {
  const client = xen.clientForHost(host);
  return client.listTemplates();
}

module.exports = { type: 'xen', declared, probe, listResources, listArtifacts, _internals: { _fromCapabilities } };
