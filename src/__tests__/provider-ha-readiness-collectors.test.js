'use strict';

const mockPve = {};
const mockVSphere = {};
let mockXenClient;

jest.mock('../config', () => ({
  app: { env: 'test' }, security: { encryptionKey: 'collector-test-encryption-key-32-chars' },
  features: { providerHaReadiness: true },
  providerHaReadiness: { freshnessMs: 60_000, historyLimit: 96, endpointConcurrency: 2 },
}));
jest.mock('../db', () => ({ getDb: jest.fn() }));
jest.mock('../services/proxmox', () => ({ fromHostRow: () => mockPve }));
jest.mock('../services/vsphere', () => ({ fromHostRow: () => mockVSphere }));
jest.mock('../services/xen', () => ({ clientForHost: () => mockXenClient }));

const readiness = require('../services/provider-sdk/ha-readiness');

describe('provider HA evidence collectors', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    Object.assign(mockPve, {
      getClusterStatus: jest.fn(async () => [{ type: 'cluster', name: 'prod', quorate: 1 }]),
      listNodes: jest.fn(async () => [
        { node: 'pve-a', status: 'online', maxmem: 16_000, mem: 8_000 },
        { node: 'pve-b', status: 'online', maxmem: 16_000, mem: 6_000 },
      ]),
      listVMs: jest.fn(async () => [{ type: 'qemu', vmid: 101, node: 'pve-a', name: 'db', status: 'running', maxmem: 4_000 }]),
      listStorages: jest.fn(async () => [{ storage: 'shared', shared: 1, status: 'available' }]),
      getHaStatus: jest.fn(async () => [{ type: 'master', node: 'pve-a', status: 'active' }]),
      getHaResources: jest.fn(async () => [{ sid: 'vm:101', state: 'started' }]),
      _agent: { destroy: jest.fn() },
    });
    Object.assign(mockVSphere, {
      login: jest.fn(async () => ({})), logout: jest.fn(async () => ({})),
      retrieveServiceContent: jest.fn(async () => ({ productFullName: 'VMware vCenter Server 9.0' })),
      listClusters: jest.fn(async () => [{
        moref: 'domain-c1', name: 'Prod', haEnabled: true, hostMonitoring: 'enabled',
        isolationResponse: 'shutdown', admissionControlEnabled: true, configuredFailoverLevel: 1,
        currentFailoverLevel: 1, overallStatus: 'green', hostRefs: ['host-1', 'host-2'],
        datastoreRefs: ['store-1'], defaultRestartPriority: 'medium', vmPriorities: { 'vm-1': { restartPriority: 'highest' } },
      }]),
      listHosts: jest.fn(async () => [
        { moref: 'host-1', name: 'esx-a', connectionState: 'connected', memoryBytes: 16_000, memoryFreeBytes: 8_000 },
        { moref: 'host-2', name: 'esx-b', connectionState: 'connected', memoryBytes: 16_000, memoryFreeBytes: 8_000 },
      ]),
      listVMs: jest.fn(async () => [{ moref: 'vm-1', uuid: 'vm-u1', name: 'db', hostRef: 'host-1', powerState: 'poweredOn', memoryMB: 2 }]),
      listDatastores: jest.fn(async () => [{ moref: 'store-1', accessible: true, maintenanceMode: 'normal' }]),
      _agent: { destroy: jest.fn() },
    });
    mockXenClient = {
      provider: 'xapi', capabilities: jest.fn(() => ({ pools: true })), close: jest.fn(async () => ({})),
      listPools: jest.fn(async () => [{ id: 'pool-1', uuid: 'pool-u1', name: 'Prod', haEnabled: true,
        haHostFailuresToTolerate: 1, haPlanExistsFor: 1, haOvercommitted: false,
        haAllowOvercommit: false, haStatefileCount: 1, haClusterStack: 'xhad' }]),
      listHosts: jest.fn(async () => [
        { id: 'host-1', ref: 'OpaqueRef:host-1', name: 'xcp-a', powerState: 'Running', memoryBytes: 16_000, memoryFreeBytes: 8_000 },
        { id: 'host-2', ref: 'OpaqueRef:host-2', name: 'xcp-b', powerState: 'Running', memoryBytes: 16_000, memoryFreeBytes: 8_000 },
      ]),
      listVMs: jest.fn(async () => [{ id: 'vm-1', ref: 'OpaqueRef:vm-1', name: 'db', hostRef: 'OpaqueRef:host-1', powerState: 'Running', memoryBytes: 2_000, haRestartPriority: '' }]),
      listStorages: jest.fn(async () => [{ id: 'sr-1', shared: true, attached: true }]),
    };
  });

  it('normalizes Proxmox quorum and protected resources without native mutation calls', async () => {
    const evidence = await readiness.collectProvider({ id: 7, daemon_type: 'proxmox' });
    expect(evidence.domains[0]).toEqual(expect.objectContaining({
      configured: true, quorum: true, heartbeat: true, sharedStorageCount: 1,
    }));
    expect(evidence.domains[0].workloads[0]).toEqual(expect.objectContaining({ protected: true, priority: 'unknown' }));
    expect(mockPve._agent.destroy).toHaveBeenCalled();
  });

  it('keeps optional Proxmox HA endpoint loss unknown instead of reporting guests unprotected', async () => {
    mockPve.getHaStatus.mockRejectedValueOnce(new Error('403'));
    mockPve.getHaResources.mockRejectedValueOnce(new Error('403'));
    const domain = (await readiness.collectProvider({ id: 7, daemon_type: 'proxmox' })).domains[0];
    expect(domain).toEqual(expect.objectContaining({ configured: null, heartbeat: null }));
    expect(domain.workloads[0]).toEqual(expect.objectContaining({ protected: null, priority: 'unknown' }));
    expect(domain.warnings).toHaveLength(2);
  });

  it('maps vCenter DAS configuration, native plan depth and per-VM priorities', async () => {
    const domain = (await readiness.collectProvider({ id: 8, daemon_type: 'vsphere' })).domains[0];
    expect(domain).toEqual(expect.objectContaining({
      configured: true, coordinationApplicable: false, heartbeat: true, fencing: true,
      admissionControl: true, nativePlanDepth: 1, sharedStorageCount: 1,
    }));
    expect(domain.workloads[0]).toEqual(expect.objectContaining({ protected: true, priority: 'highest' }));
    expect(mockVSphere.logout).toHaveBeenCalled();
  });

  it('maps XAPI plan evidence and treats an empty restart priority as disabled', async () => {
    const domain = (await readiness.collectProvider({ id: 9, daemon_type: 'xen' })).domains[0];
    expect(domain).toEqual(expect.objectContaining({
      configured: true, heartbeat: true, fencing: true, admissionControl: true,
      configuredFailureTolerance: 1, nativePlanDepth: 1,
    }));
    expect(domain.workloads[0]).toEqual(expect.objectContaining({ protected: false, priority: 'disabled' }));
    expect(mockXenClient.close).toHaveBeenCalled();
  });

  it('refuses to invent pool HA for raw Xen', async () => {
    mockXenClient = { provider: 'raw', capabilities: () => ({ pools: false }) };
    await expect(readiness.collectProvider({ id: 10, daemon_type: 'xen' })).resolves.toEqual(expect.objectContaining({
      unsupported: true, domains: [],
    }));
  });
});
