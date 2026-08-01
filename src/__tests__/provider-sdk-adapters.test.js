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
    expect(features['backup.run']).toEqual(expect.objectContaining({ state: 'conditional' }));
    expect(features['backup.run'].constraints).toEqual(expect.objectContaining({
      durableTask: true, retentionMutation: false,
    }));
    expect(features['backup.restore.vm']).toEqual(expect.objectContaining({ state: 'conditional' }));
    expect(features['backup.restore.vm'].constraints).toEqual(expect.objectContaining({
      createOnly: true, overwrite: false, startAfterRestore: false,
    }));
    expect(features['backup.restore.file'].state).toBe('unsupported');
    expect(features['inventory.image'].state).toBe('supported');
    expect(features['vm.power.start']).toEqual(expect.objectContaining({ state: 'conditional' }));
    expect(features['vm.power.force'].constraints).toEqual(expect.objectContaining({
      perResource: true, confirmation: true, durableTask: true,
    }));
    expect(features['vm.snapshot.create']).toEqual(expect.objectContaining({ state: 'conditional' }));
    expect(features['vm.snapshot.create'].constraints).toEqual(expect.objectContaining({
      durableTask: true, consistency: ['crash'],
    }));
    expect(features['vm.migration.preflight']).toEqual(expect.objectContaining({
      state: 'conditional', constraints: expect.objectContaining({ readOnly: true }),
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

  it('version-gates Proxmox affinity and refuses cluster placement on standalone ESXi', async () => {
    proxmoxService.fromHostRow.mockReturnValue({
      version: jest.fn(async () => ({ version: '8.4.1' })), _agent: { destroy: jest.fn() },
    });
    await expect(proxmox.probe({})).resolves.toEqual(expect.objectContaining({
      features: expect.objectContaining({ 'placement.affinity.read': expect.objectContaining({ state: 'unsupported' }) }),
    }));
    proxmoxService.fromHostRow.mockReturnValue({
      version: jest.fn(async () => ({ version: '9.0.0' })), _agent: { destroy: jest.fn() },
    });
    await expect(proxmox.probe({})).resolves.toEqual(expect.objectContaining({
      features: expect.objectContaining({ 'placement.affinity.read': expect.objectContaining({ state: 'conditional' }) }),
    }));
    vsphereService.fromHostRow.mockReturnValue({
      login: jest.fn(), retrieveServiceContent: jest.fn(async () => ({ productFullName: 'VMware ESXi 9.0' })),
      _agent: { destroy: jest.fn() },
    });
    const result = await vsphere.probe({});
    expect(result.features['placement.affinity.read'].state).toBe('unsupported');
    expect(result.features['placement.recommend'].state).toBe('unsupported');
    expect(result.features['placement.rebalance.plan'].state).toBe('unsupported');
  });

  it('maps XAPI features with per-resource constraints', () => {
    const features = xen._internals._fromCapabilities({
      vms: true, hosts: true, pools: true, storages: true, networks: true,
      tasks: true, snapshots: true, snapshotQuiesce: true, taskCleanup: true,
      templates: true, migrationPreflight: true, migrationLive: true,
      migrationCold: true, migrationStorage: true,
      vmActions: ['start', 'shutdown', 'forceShutdown', 'reboot'],
    });
    expect(features['inventory.cluster'].state).toBe('supported');
    expect(features['inventory.image'].state).toBe('supported');
    expect(features['vm.power.start']).toEqual(expect.objectContaining({ state: 'conditional' }));
    expect(features['vm.snapshot.create'].constraints.perResource).toBe(true);
    expect(features['vm.snapshot.create'].constraints.consistency).toEqual(['crash', 'quiesced']);
    expect(features['task.cleanup'].state).toBe('supported');
    expect(features['vm.migration.preflight'].state).toBe('conditional');
  });

  it('advertises Xen Orchestra backup reads without advertising backup execution', () => {
    const features = xen._internals._fromCapabilities({ backups: true });
    expect(features['backup.read']).toEqual(expect.objectContaining({ state: 'conditional' }));
    expect(features['backup.read'].constraints).toEqual(expect.objectContaining({ readOnly: true, provider: 'xo' }));
    expect(features['backup.run'].state).toBe('unsupported');
    expect(features['backup.restore.vm'].state).toBe('unsupported');
    expect(features['backup.restore.file'].state).toBe('unsupported');
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

  it('dispatches recovery-point inventory and rejects raw Xen', async () => {
    const destroy = jest.fn();
    const readPve = jest.fn().mockResolvedValue({ repositories: [], points: [] });
    proxmoxService.fromHostRow.mockReturnValue({ listRecoveryPoints: readPve, _agent: { destroy } });
    await expect(proxmox.listRecoveryPoints({})).resolves.toEqual({ repositories: [], points: [] });
    expect(destroy).toHaveBeenCalled();

    const readXo = jest.fn().mockResolvedValue({ repositories: [], points: [] });
    xenService.clientForHost.mockReturnValue({ provider: 'xo', listRecoveryPoints: readXo });
    await expect(xen.listRecoveryPoints({})).resolves.toEqual({ repositories: [], points: [] });
    xenService.clientForHost.mockReturnValue({ provider: 'raw' });
    await expect(xen.listRecoveryPoints({})).rejects.toMatchObject({
      code: 'PROVIDER_BACKUP_INVENTORY_UNAVAILABLE', status: 400,
    });
  });

  it('normalizes provider placement policy through read-only inventory methods', async () => {
    const destroy = jest.fn();
    proxmoxService.fromHostRow.mockReturnValue({
      getHaRules: jest.fn(async () => [{ rule: 'spread', type: 'resource-anti-affinity', resources: 'vm:101,ct:102', strict: 1 }]),
      _agent: { destroy },
    });
    await expect(proxmox.placementInventory({})).resolves.toEqual(expect.objectContaining({
      rules: [expect.objectContaining({ kind: 'vm-anti-affinity', mandatory: true, vmRefs: ['101', '102'] })],
    }));
    expect(destroy).toHaveBeenCalled();

    const logout = jest.fn();
    vsphereService.fromHostRow.mockReturnValue({
      login: jest.fn(), logout, listClusters: jest.fn(async options => {
        expect(options).toEqual({ placement: true });
        return [{ moref: 'domain-c1', rules: [{ nativeId: '1', kind: 'vm-affinity' }], drsRecommendations: [] }];
      }), _agent: { destroy: jest.fn() },
    });
    await expect(vsphere.placementInventory({})).resolves.toEqual(expect.objectContaining({
      rules: [expect.objectContaining({ scopeRef: 'domain-c1' })],
    }));
    expect(logout).toHaveBeenCalled();

    xenService.clientForHost.mockReturnValue({
      provider: 'xapi', listVMs: jest.fn(async () => [{ id: 'vm-1', name: 'db', ref: 'OpaqueRef:vm', affinityRef: 'OpaqueRef:host' }]),
      listVmGroups: jest.fn(async () => [{ id: 'group-1', name: 'spread', placement: 'anti_affinity', vmRefs: ['OpaqueRef:vm'] }]),
    });
    await expect(xen.placementInventory({})).resolves.toEqual(expect.objectContaining({
      rules: expect.arrayContaining([
        expect.objectContaining({ kind: 'home-host-preference', mandatory: false }),
        expect.objectContaining({ kind: 'vm-anti-affinity', mandatory: false }),
      ]),
    }));
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

  it('normalizes vSphere standard-switch evidence for passive MTU and Bond/LAG capture', async () => {
    const logout = jest.fn();
    const destroy = jest.fn();
    vsphereService.fromHostRow.mockReturnValue({
      login: jest.fn(), logout, _agent: { destroy },
      listHostNetworkEvidence: jest.fn(async () => ({
        observedAt: '2026-08-01T10:00:00.000Z',
        coverage: { complete: true, reason: 'all hosts read' }, limitations: ['no counters'],
        hosts: [{ hostRef: 'host-7', hostName: 'esx-a', switches: [{
          key: 'vSwitch0', name: 'vSwitch0', mtu: 9000, mode: 'active_backup',
          members: [
            { device: 'vmnic0', adminState: 'up', linkState: 'up', role: 'active',
              speedMbps: 10000, duplex: 'full' },
            { device: 'vmnic1', adminState: 'up', linkState: 'up', role: 'standby',
              speedMbps: 10000, duplex: 'full' },
          ],
        }] }],
      })),
    });
    const result = await vsphere.networkEvidence({});
    expect(result.switches).toEqual([expect.objectContaining({
      switchKey: 'vsphere:host-7:vSwitch0', hostKey: 'vsphere:host-7', mtu: 9000,
    })]);
    expect(result.bonds).toEqual([expect.objectContaining({
      bondKey: 'vsphere:host-7:vSwitch0', mode: 'active_backup',
      members: expect.arrayContaining([expect.objectContaining({ memberKey: 'vsphere:host-7:vmnic0',
        rxBytesDelta: 0, flapCount: 0 })]),
    })]);
    expect(logout).toHaveBeenCalled();
    expect(destroy).toHaveBeenCalled();
  });

  it('uses Proxmox read-only migration preconditions and target fabric evidence', async () => {
    const destroy = jest.fn();
    proxmoxService.fromHostRow.mockReturnValue({
      getVmConfig: jest.fn().mockResolvedValue({
        scsi0: 'shared:vm-101-disk-0,size=20G', net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0',
      }),
      getVmMigrationPreconditions: jest.fn().mockResolvedValue({ local_resources: [] }),
      getNodeMigrationInventory: jest.fn().mockResolvedValue({
        storages: [{ storage: 'shared', active: 1, enabled: 1 }],
        networks: [{ iface: 'vmbr0', type: 'bridge' }],
      }),
      _agent: { destroy },
    });
    const source = { kind: 'virtualMachine', displayName: 'app', status: { powerState: 'running' }, extensions: { node: 'pve-a' } };
    const targets = ['pve-a', 'pve-b'].map((node, index) => ({
      identity: { nativeRef: node }, resource: { id: `ddr_host_${String(index + 1).repeat(26)}`, displayName: node },
    }));
    const result = await proxmox.migrationCompatibility({}, {
      identity: { nativeRef: 'qemu/101' }, resource: source, targets,
    });
    expect(result.candidates[1]).toEqual(expect.objectContaining({
      current: false, modes: expect.objectContaining({ live: 'conditional', cold: 'conditional' }),
    }));
    expect(result.candidates[1].checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'storage.mapping', state: 'pass' }),
      expect.objectContaining({ key: 'network.mapping', state: 'pass' }),
    ]));
    expect(destroy).toHaveBeenCalled();
  });

  it('preserves the Proxmox LXC guest type when the canonical identity is numeric', async () => {
    const getVmConfig = jest.fn().mockResolvedValue({ rootfs: 'shared:subvol-202-disk-0,size=8G' });
    const getVmMigrationPreconditions = jest.fn().mockResolvedValue({ local_resources: [] });
    proxmoxService.fromHostRow.mockReturnValue({
      getVmConfig, getVmMigrationPreconditions,
      getNodeMigrationInventory: jest.fn().mockResolvedValue({ storages: [{ storage: 'shared', active: 1, enabled: 1 }], networks: [] }),
      _agent: { destroy: jest.fn() },
    });
    await proxmox.migrationCompatibility({}, {
      identity: { nativeRef: '202' },
      resource: { status: { powerState: 'stopped' }, extensions: { node: 'pve-a', guestType: 'lxc' } },
      targets: [{ identity: { nativeRef: 'pve-b' }, resource: { id: `ddr_host_${'8'.repeat(26)}`, displayName: 'pve-b' } }],
    });
    expect(getVmConfig).toHaveBeenCalledWith('pve-a', 'lxc', 202);
    expect(getVmMigrationPreconditions).toHaveBeenCalledWith('pve-a', 'lxc', 202);
  });

  it('maps vCenter VMotion evidence onto canonical candidate IDs', async () => {
    const logout = jest.fn();
    vsphereService.fromHostRow.mockReturnValue({
      login: jest.fn(), logout, _agent: { destroy: jest.fn() },
      getVmMigrationCompatibility: jest.fn().mockResolvedValue({
        sourceRef: 'host-1', candidates: [{ hostRef: 'host-2', compatibility: ['cpu', 'software'] }],
      }),
    });
    const targets = ['host-1', 'host-2'].map((ref, index) => ({
      identity: { nativeRef: ref }, resource: { id: `ddr_host_${String(index + 3).repeat(26)}`, displayName: ref },
    }));
    const result = await vsphere.migrationCompatibility({}, {
      identity: { nativeRef: 'vm-8' }, resource: { status: { powerState: 'running' } }, targets,
    });
    expect(result.sourceTargetId).toBe(targets[0].resource.id);
    expect(result.candidates[1].modes.live).toBe('conditional');
    expect(result.candidates[1].checks[0]).toEqual(expect.objectContaining({ state: 'pass', confidence: 'high' }));
    expect(logout).toHaveBeenCalled();
  });
});
