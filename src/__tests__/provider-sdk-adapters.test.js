'use strict';

jest.mock('../services/proxmox', () => ({ fromHostRow: jest.fn() }));
jest.mock('../services/vsphere', () => ({ fromHostRow: jest.fn() }));
jest.mock('../services/xen', () => ({ clientForHost: jest.fn() }));

const proxmox = require('../services/provider-sdk/adapters/proxmox');
const vsphere = require('../services/provider-sdk/adapters/vsphere');
const xen = require('../services/provider-sdk/adapters/xen');

describe('Provider SDK adapters', () => {
  it('declares only implemented Proxmox adapter functions', () => {
    const features = proxmox.declared();
    expect(features['inventory.vm'].state).toBe('supported');
    expect(features['backup.read'].state).toBe('supported');
    expect(features['vm.power.start'].state).toBe('unsupported');
    expect(features['vm.power.start'].reason).toMatch(/adapter does not implement/);
  });

  it('distinguishes vCenter, ESXi and unknown products', () => {
    expect(vsphere._internals._variant({ productFullName: 'VMware vCenter Server 9.0' })).toBe('vcenter');
    expect(vsphere._internals._variant({ productFullName: 'VMware ESXi 8.0' })).toBe('esxi');
    expect(vsphere._internals._variant({ productFullName: 'VMware platform' })).toBe('unknown');
  });

  it('maps XAPI features with per-resource constraints', () => {
    const features = xen._internals._fromCapabilities({
      vms: true, hosts: true, pools: true, storages: true, networks: true,
      tasks: true, snapshots: true, taskCleanup: true,
      vmActions: ['start', 'shutdown', 'forceShutdown', 'reboot'],
    });
    expect(features['inventory.cluster'].state).toBe('supported');
    expect(features['vm.power.start']).toEqual(expect.objectContaining({ state: 'conditional' }));
    expect(features['vm.snapshot.create'].constraints.perResource).toBe(true);
    expect(features['task.cleanup'].state).toBe('supported');
  });

  it('keeps raw Xen deliberately constrained', () => {
    const features = xen._internals._fromCapabilities({
      vms: true, hosts: true, pools: false, storages: false, networks: false,
      tasks: false, snapshots: false, taskCleanup: false,
      vmActions: ['shutdown', 'forceShutdown', 'reboot'],
    });
    expect(features['inventory.cluster'].state).toBe('unsupported');
    expect(features['vm.snapshot.create'].state).toBe('unsupported');
    expect(features['vm.create'].state).toBe('unsupported');
  });
});

