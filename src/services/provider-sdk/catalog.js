'use strict';

// Provider SDK v2 — stable, vendor-neutral capability identifiers.
// Published keys are additive: changing the meaning of an existing key would
// make cached evidence and frontend gates ambiguous, so semantic changes must
// receive a new key.

const FEATURE_CATALOG = Object.freeze({
  'inventory.vm': 'Virtual machine inventory',
  'inventory.host': 'Hypervisor host inventory',
  'inventory.cluster': 'Cluster or pool inventory',
  'inventory.storage': 'Datastore or storage repository inventory',
  'inventory.network': 'Virtual network inventory',
  'inventory.task': 'Native asynchronous task inventory',
  'inventory.image': 'Template and image artifact inventory',
  'vm.read': 'Virtual machine detail',
  'vm.power.start': 'Start virtual machine',
  'vm.power.shutdown': 'Graceful virtual machine shutdown',
  'vm.power.force': 'Forced virtual machine power operation',
  'vm.power.reboot': 'Virtual machine reboot',
  'vm.snapshot.list': 'Snapshot inventory',
  'vm.snapshot.create': 'Create snapshot',
  'vm.snapshot.revert': 'Revert snapshot',
  'vm.snapshot.delete': 'Delete snapshot',
  'vm.console': 'Interactive virtual machine console',
  'vm.clone': 'Clone virtual machine',
  'vm.create': 'Provision virtual machine',
  'vm.guestCustomize': 'Customize guest operating system during provisioning',
  'vm.migrate': 'Migrate virtual machine',
  'host.maintenance': 'Host maintenance orchestration',
  'cluster.ha.read': 'High-availability state and readiness',
  'storage.mutate': 'Storage or volume mutation',
  'network.mutate': 'Virtual network mutation',
  'task.read': 'Native task detail',
  'task.cancel': 'Cancel native task',
  'task.cleanup': 'Remove completed native task',
  'event.stream': 'Provider event stream',
  'backup.read': 'Backup and recovery-point inventory',
  'backup.run': 'Run workload backup',
});

const FEATURE_KEYS = Object.freeze(Object.keys(FEATURE_CATALOG));
const FEATURE_KEY_SET = new Set(FEATURE_KEYS);
const STATES = Object.freeze(['supported', 'conditional', 'unsupported', 'unknown']);
const SOURCES = Object.freeze(['live', 'adapter', 'version', 'configuration', 'fallback']);

module.exports = {
  FEATURE_CATALOG,
  FEATURE_KEYS,
  FEATURE_KEY_SET,
  STATES,
  SOURCES,
};
