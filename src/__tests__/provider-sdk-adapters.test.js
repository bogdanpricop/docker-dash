'use strict';

jest.mock('../services/proxmox', () => ({ fromHostRow: jest.fn() }));
jest.mock('../services/vsphere', () => ({ fromHostRow: jest.fn() }));
jest.mock('../services/xen', () => ({ clientForHost: jest.fn() }));

const proxmoxService = require('../services/proxmox');
const vsphereService = require('../services/vsphere');
const xenService = require('../services/xen');
const proxmox = require('../services/provider-sdk/adapters/proxmox');
const vsphere = require('../services/provider-sdk/adapters/vsphere');
const xen = require('../services/provider-sdk/adapters/xen');

describe('Provider SDK adapters', () => {
  it('declares only implemented Proxmox adapter functions', () => {
    const features = proxmox.declared();
    expect(features['inventory.vm'].state).toBe('supported');
    expect(features['backup.read'].state).toBe('supported');
    expect(features['inventory.image'].state).toBe('supported');
    expect(features['vm.power.start']).toEqual(expect.objectContaining({ state: 'conditional' }));
    expect(features['vm.power.force'].constraints).toEqual(expect.objectContaining({
      perResource: true, confirmation: true, durableTask: true,
    }));
    expect(features['vm.snapshot.create']).toEqual(expect.objectContaining({ state: 'conditional' }));
    expect(features['vm.snapshot.create'].constraints).toEqual(expect.objectContaining({
      durableTask: true, consistency: ['crash'],
    }));
  });

  it('derives provider-native power actions from current guest state', () => {
    expect(proxmox._internals._allowedVmActions({ status: 'stopped', type: 'qemu' })).toEqual(['start']);
    expect(proxmox._internals._allowedVmActions({ status: 'running', type: 'lxc' }))
      .toEqual(['shutdown', 'reboot', 'forceShutdown']);
    expect(vsphere._internals._allowedVmActions({ powerState: 'poweredOn', toolsStatus: 'toolsOk' }))
      .toEqual(expect.arrayContaining(['shutdown', 'reboot', 'forceShutdown', 'forceReboot']));
    expect(vsphere._internals._allowedVmActions({ powerState: 'poweredOn', toolsStatus: 'toolsNotRunning' }))
      .toEqual(['forceShutdown', 'forceReboot']);
    expect(proxmox._internals._allowedSnapshotActions({ status: 'running' })).toEqual(['snapshot']);
    expect(proxmox._internals._allowedSnapshotActions({ status: 'running', lock: 'backup' })).toEqual([]);
    expect(vsphere._internals._allowedSnapshotActions({
      snapshotOperationsSupported: true, powerState: 'poweredOn', toolsStatus: 'toolsOk',
    })).toEqual(['snapshot', 'snapshotQuiesced']);
    expect(vsphere._internals._allowedSnapshotActions({ snapshotOperationsSupported: false })).toEqual([]);
  });

  it('distinguishes vCenter, ESXi and unknown products', () => {
    expect(vsphere._internals._variant({ productFullName: 'VMware vCenter Server 9.0' })).toBe('vcenter');
    expect(vsphere._internals._variant({ productFullName: 'VMware ESXi 8.0' })).toBe('esxi');
    expect(vsphere._internals._variant({ productFullName: 'VMware platform' })).toBe('unknown');
  });

  it('maps XAPI features with per-resource constraints', () => {
    const features = xen._internals._fromCapabilities({
      vms: true, hosts: true, pools: true, storages: true, networks: true,
      tasks: true, snapshots: true, snapshotQuiesce: true, taskCleanup: true,
      templates: true,
      vmActions: ['start', 'shutdown', 'forceShutdown', 'reboot'],
    });
    expect(features['inventory.cluster'].state).toBe('supported');
    expect(features['inventory.image'].state).toBe('supported');
    expect(features['vm.power.start']).toEqual(expect.objectContaining({ state: 'conditional' }));
    expect(features['vm.snapshot.create'].constraints.perResource).toBe(true);
    expect(features['vm.snapshot.create'].constraints.consistency).toEqual(['crash', 'quiesced']);
    expect(features['task.cleanup'].state).toBe('supported');
  });

  it('keeps raw Xen deliberately constrained', () => {
    const features = xen._internals._fromCapabilities({
      vms: true, hosts: true, pools: false, storages: false, networks: false,
      tasks: false, snapshots: false, taskCleanup: false,
      templates: false,
      vmActions: ['shutdown', 'forceShutdown', 'reboot'],
    });
    expect(features['inventory.cluster'].state).toBe('unsupported');
    expect(features['inventory.image'].state).toBe('unsupported');
    expect(features['vm.snapshot.create'].state).toBe('unsupported');
    expect(features['vm.create'].state).toBe('unsupported');
  });

  it('dispatches artifact inventory through provider-native read methods', async () => {
    const pveDestroy = jest.fn();
    const pveArtifacts = jest.fn().mockResolvedValue([{ kind: 'iso', id: 'local:iso/a.iso' }]);
    proxmoxService.fromHostRow.mockReturnValue({ listArtifacts: pveArtifacts, _agent: { destroy: pveDestroy } });
    await expect(proxmox.listArtifacts({})).resolves.toHaveLength(1);
    expect(pveDestroy).toHaveBeenCalled();

    const logout = jest.fn();
    const templates = jest.fn().mockResolvedValue([{ kind: 'vmTemplate', id: 'vm-9' }]);
    vsphereService.fromHostRow.mockReturnValue({ login: jest.fn(), logout, listTemplates: templates, listIsoImages: jest.fn().mockResolvedValue([]), _agent: { destroy: jest.fn() } });
    await expect(vsphere.listArtifacts({})).resolves.toHaveLength(1);
    expect(logout).toHaveBeenCalled();

    xenService.clientForHost.mockReturnValue({ listTemplates: templates });
    await expect(xen.listArtifacts({})).resolves.toHaveLength(1);
  });

  it('dispatches resource inventory to provider-native read methods and cleans up one-shot clients', async () => {
    const pveDestroy = jest.fn();
    const pveList = jest.fn().mockResolvedValue([{ id: 1 }]);
    proxmoxService.fromHostRow.mockReturnValue({ listVMs: pveList, _agent: { destroy: pveDestroy } });
    await expect(proxmox.listResources('virtualMachine', {})).resolves.toEqual([
      { id: 1, allowedActions: [] },
    ]);
    expect(pveDestroy).toHaveBeenCalled();

    const logout = jest.fn().mockResolvedValue(undefined);
    const esxDestroy = jest.fn();
    const listNetworks = jest.fn().mockResolvedValue([{ moref: 'network-1' }]);
    vsphereService.fromHostRow.mockReturnValue({
      login: jest.fn().mockResolvedValue({}), logout, listNetworks, _agent: { destroy: esxDestroy },
    });
    await expect(vsphere.listResources('network', {})).resolves.toHaveLength(1);
    expect(logout).toHaveBeenCalled();
    expect(esxDestroy).toHaveBeenCalled();

    const listTasks = jest.fn().mockResolvedValue([{ id: 'task-1' }]);
    xenService.clientForHost.mockReturnValue({ listTasks });
    await expect(xen.listResources('task', {})).resolves.toHaveLength(1);
    expect(listTasks).toHaveBeenCalled();
  });
});
