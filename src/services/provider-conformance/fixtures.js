'use strict';

const { FEATURE_KEY_SET } = require('../provider-sdk/catalog');
const { resourceKind } = require('../provider-sdk/resource-catalog');

const REQUIRED_FAULTS = Object.freeze(['timeout', 'auth_expiry', 'partial_response', 'redirect', 'task_loss']);

const CORPUS = Object.freeze([
  Object.freeze({
    id: 'proxmox-pve-json', providerType: 'proxmox', variant: 'pve', apiFamily: 'pve-api2-json',
    supportedCapabilities: Object.freeze(['inventory.vm', 'inventory.host', 'inventory.storage', 'inventory.image', 'vm.read', 'backup.read']),
    resources: Object.freeze({
      virtualMachine: Object.freeze([{ vmid: 101, id: 'qemu/101', name: 'fixture-pve-vm', status: 'running', maxcpu: 2, maxmem: 2147483648 }]),
      host: Object.freeze([{ node: 'pve-fixture', name: 'pve-fixture', status: 'online', cpuThreads: 8, memoryTotal: 17179869184 }]),
      storage: Object.freeze([{ storage: 'local-lvm', name: 'local-lvm', type: 'lvmthin', totalBytes: 107374182400, usedBytes: 21474836480 }]),
    }),
  }),
  Object.freeze({
    id: 'vsphere-vcenter-soap', providerType: 'vsphere', variant: 'vcenter', apiFamily: 'vSphere SOAP',
    supportedCapabilities: Object.freeze(['inventory.vm', 'inventory.host', 'inventory.storage', 'inventory.network', 'inventory.image']),
    resources: Object.freeze({
      virtualMachine: Object.freeze([{ moref: 'vm-101', uuid: '42000000-0000-4000-8000-000000000101', name: 'fixture-vsphere-vm', powerState: 'poweredOn', numCPU: 4, memoryMB: 4096 }]),
      host: Object.freeze([{ moref: 'host-21', uuid: '42000000-0000-4000-8000-000000000021', name: 'esx-fixture', connectionState: 'connected' }]),
      storage: Object.freeze([{ moref: 'datastore-31', uuid: '42000000-0000-4000-8000-000000000031', name: 'fixture-ds', capacityBytes: 1099511627776, freeSpaceBytes: 549755813888 }]),
      network: Object.freeze([{ moref: 'network-41', uuid: '42000000-0000-4000-8000-000000000041', name: 'fixture-vlan', vlanId: 41, mtu: 1500 }]),
    }),
  }),
  Object.freeze({
    id: 'xen-xo-rest', providerType: 'xen', variant: 'xo', apiFamily: 'Xen Orchestra REST',
    supportedCapabilities: Object.freeze(['inventory.vm', 'inventory.host', 'inventory.cluster', 'inventory.storage', 'inventory.network', 'inventory.task', 'inventory.image', 'vm.read']),
    resources: Object.freeze({
      virtualMachine: Object.freeze([{ uuid: '10000000-0000-4000-8000-000000000001', name: 'fixture-xo-vm', powerState: 'Running', cpus: 2, memoryBytes: 2147483648 }]),
      task: Object.freeze([{ id: 'task-fixture-1', name: 'fixture-task', status: 'success', progress: 1 }]),
    }),
  }),
  Object.freeze({
    id: 'xen-xapi-rpc', providerType: 'xen', variant: 'xapi', apiFamily: 'XAPI JSON-RPC',
    supportedCapabilities: Object.freeze(['inventory.vm', 'inventory.host', 'inventory.cluster', 'inventory.storage', 'inventory.network', 'inventory.task', 'inventory.image', 'vm.read']),
    resources: Object.freeze({
      virtualMachine: Object.freeze([{ ref: 'OpaqueRef:fixture-vm', uuid: '20000000-0000-4000-8000-000000000002', name_label: 'fixture-xapi-vm', power_state: 'Halted' }]),
      cluster: Object.freeze([{ ref: 'OpaqueRef:fixture-pool', uuid: '20000000-0000-4000-8000-000000000003', name_label: 'fixture-pool' }]),
    }),
  }),
  Object.freeze({
    id: 'xen-raw-cli', providerType: 'xen', variant: 'raw', apiFamily: 'SSH xl',
    supportedCapabilities: Object.freeze(['inventory.vm', 'inventory.host', 'vm.read']),
    resources: Object.freeze({
      virtualMachine: Object.freeze([{ id: 'domain-fixture-7', name: 'fixture-raw-vm', domid: 7, status: 'running', transient: true }]),
      host: Object.freeze([{ id: 'raw-host-fixture', name: 'raw-xen-fixture', status: 'online', transient: true }]),
    }),
  }),
]);

function _hasSecret(value) {
  const text = JSON.stringify(value);
  return /bearer\s+|authorization|cookie|pass(word)?|secret|api[_-]?key|token/i.test(text);
}

function validateCorpus(corpus = CORPUS) {
  const errors = [];
  const ids = new Set();
  for (const fixture of corpus) {
    if (!/^[a-z][a-z0-9_-]{2,79}$/.test(fixture?.id || '') || ids.has(fixture.id)) errors.push('fixture id is invalid or duplicated');
    else ids.add(fixture.id);
    if (!/^[a-z][a-z0-9_-]{1,39}$/.test(fixture?.providerType || '')) errors.push(`${fixture?.id || 'fixture'} providerType is invalid`);
    if (!fixture?.variant || !fixture?.apiFamily) errors.push(`${fixture?.id || 'fixture'} variant/apiFamily are required`);
    if (!Array.isArray(fixture?.supportedCapabilities) || fixture.supportedCapabilities.some(key => !FEATURE_KEY_SET.has(key))) errors.push(`${fixture?.id || 'fixture'} capabilities are invalid`);
    for (const [kind, rows] of Object.entries(fixture?.resources || {})) {
      if (!resourceKind(kind) || !Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) errors.push(`${fixture?.id || 'fixture'} resource corpus is invalid`);
    }
    if (_hasSecret(fixture)) errors.push(`${fixture?.id || 'fixture'} contains secret-like data`);
  }
  if (errors.length) throw new Error(`Invalid provider fixture corpus: ${errors.join('; ')}`);
  return true;
}

function fixturesFor(providerType) {
  return CORPUS.filter(fixture => fixture.providerType === providerType);
}

function createFakeAdapter(scenario, options = {}) {
  if (!REQUIRED_FAULTS.includes(scenario)) throw new Error(`Unknown provider fault scenario: ${scenario}`);
  const declared = () => options.features || {};
  const probe = async () => {
    if (scenario === 'timeout') return new Promise(() => {});
    if (scenario === 'auth_expiry') throw Object.assign(new Error('Provider session expired'), { code: 'AUTH_EXPIRED' });
    if (scenario === 'partial_response') return { provider: { type: 'fake_provider' }, features: { 'invalid.feature': { state: 'supported', source: 'live' } } };
    if (scenario === 'redirect') return { provider: { type: 'fake_provider', variant: 'master-redirect' }, redirect: { followed: true }, features: declared() };
    return { provider: { type: 'fake_provider' }, task: { state: 'unknown', reason: 'native task disappeared' }, features: declared() };
  };
  return Object.freeze({ type: 'fake_provider', declared, probe, listResources: async () => [] });
}

validateCorpus();

module.exports = { CORPUS, REQUIRED_FAULTS, fixturesFor, validateCorpus, createFakeAdapter, _internals: { _hasSecret } };
