'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const migration124 = require('../db/migrations/124_governance_foundation');
const migration144 = require('../db/migrations/144_hardware_performance_foundation');
const { HardwarePerformanceService } = require('../services/hardware-performance');

const admin = { id: 1, username: 'admin', role: 'admin' };
const GiB = 1024 ** 3;

function database() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT,
      email TEXT UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer', is_active INTEGER NOT NULL DEFAULT 1,
      auth_source TEXT NOT NULL DEFAULT 'local', must_change_password INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE tenants (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, kind TEXT DEFAULT 'internal',
      usage_mode TEXT DEFAULT 'production', status TEXT DEFAULT 'active', is_default INTEGER DEFAULT 0, trial_expires_at TEXT,
      created_by TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE user_tenants (user_id INTEGER REFERENCES users(id), tenant_id INTEGER REFERENCES tenants(id), role TEXT DEFAULT 'viewer',
      is_owner INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), PRIMARY KEY(user_id,tenant_id));
    CREATE TABLE teams (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT, created_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE team_members (team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      is_leader INTEGER DEFAULT 0, added_by INTEGER, added_at TEXT DEFAULT (datetime('now')), PRIMARY KEY(team_id,user_id));
    CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, daemon_type TEXT NOT NULL, is_active INTEGER DEFAULT 1);
    INSERT INTO users (id,username,email,password_hash,role) VALUES (1,'admin','admin@example.test','x','admin');
    INSERT INTO tenants (id,slug,name) VALUES (1,'platform','Platform');
    INSERT INTO docker_hosts (id,name,daemon_type,is_active) VALUES (1,'pve-a','proxmox',1),(2,'pve-b','proxmox',1);
  `);
  migration124.up(db); migration144.up(db);
  return db;
}

function snapshot(hostId, overrides = {}) {
  const first = hostId === 1;
  return {
    hostId, providerType: 'proxmox', clusterRef: 'cluster-a', hostRef: `pve-${hostId}`,
    model: first ? 'Dell R760' : 'Dell R750', generation: first ? '16g' : '15g',
    observedAt: `2026-07-30T01:0${hostId}:00.000Z`, source: { kind: 'api', adapter: 'proxmox.nodes', version: '8.4', coverage: ['cpu', 'numa', 'memory'] },
    cpu: { vendor: 'Intel', model: first ? 'Xeon 8480+' : 'Xeon 8380', sockets: 2, cores: 8, threads: 16,
      features: first ? ['aes', 'avx', 'avx2', 'sse4.2'] : ['aes', 'avx', 'sse4.2'], isolatedCpuIds: first ? [0, 1, 2, 3] : [0, 1] },
    memory: { totalBytes: 128 * GiB, reservedBytes: 16 * GiB, activeBytes: first ? 116 * GiB : 40 * GiB,
      balloonBytes: first ? 2 * GiB : 0, swapUsedBytes: first ? GiB : 0 },
    numaNodes: [
      { id: 0, cpuIds: [0, 1, 2, 3], memoryBytes: 64 * GiB, freeMemoryBytes: 8 * GiB,
        hugepages: [{ sizeKb: 2048, total: 100, free: 5, reserved: 10 }, { sizeKb: 1048576, total: 8, free: 4, reserved: 1 }] },
      { id: 1, cpuIds: [4, 5, 6, 7], memoryBytes: 64 * GiB, freeMemoryBytes: 32 * GiB,
        hugepages: [{ sizeKb: 2048, total: 100, free: 80, reserved: 5 }] },
    ],
    nics: [{ id: `nic-${hostId}`, vendor: 'Intel', model: 'E810', speedMbps: 25000, numaNode: 0, features: ['sriov'] }],
    hbas: [{ id: `hba-${hostId}`, vendor: 'Broadcom', model: 'HBA9500', ports: 2, numaNode: 1 }],
    disks: [{ id: `disk-${hostId}`, vendor: 'Samsung', model: 'PM9A3', capacityBytes: 4 * 1000 ** 4, media: 'nvme', numaNode: 1 }],
    gpus: [{ id: `gpu-${hostId}`, vendor: 'NVIDIA', model: 'L40S', memoryBytes: 48 * GiB, driverVersion: '550.90', health: 'healthy', numaNode: 0 }],
    bmc: { vendor: 'Dell', model: 'iDRAC9', firmware: '7.10' }, compatibilityTags: [first ? 'rack:blue' : 'rack:green'],
    vms: first ? [
      { resourceKey: 'ddr_vm_rt', name: 'rt-vm', vcpus: 2, memoryBytes: 4 * GiB, activeMemoryBytes: 3 * GiB,
        numaNodes: [{ nodeId: 0, vcpus: 2, memoryBytes: 4 * GiB }], cpuPinning: [0, 1], dedicatedCpu: true,
        isolatedCpuRequired: true, hugepageSizeKb: 2048, latencySensitivity: 'realtime', deviceRefs: [{ id: 'gpu-1', kind: 'gpu', numaNode: 0 }] },
      { resourceKey: 'ddr_vm_bad', name: 'bad-vm', vcpus: 6, memoryBytes: 80 * GiB, activeMemoryBytes: 60 * GiB,
        balloonBytes: GiB, swapBytes: GiB, numaNodes: [{ nodeId: 0, vcpus: 6, memoryBytes: 80 * GiB }],
        cpuPinning: [0, 4], dedicatedCpu: false, deviceRefs: [{ id: 'hba-1', kind: 'hba', numaNode: 1 }] },
      { resourceKey: 'ddr_vm_conflict', name: 'conflict-vm', vcpus: 1, memoryBytes: 2 * GiB, activeMemoryBytes: GiB,
        numaNodes: [{ nodeId: 0, vcpus: 1, memoryBytes: 2 * GiB }], cpuPinning: [0], dedicatedCpu: true },
    ] : [],
    ...overrides,
  };
}

describe('v8.70 hardware and performance foundation (B376-B385)', () => {
  let db; let service;
  beforeEach(() => { db = database(); service = new HardwarePerformanceService(() => db); service.recordSnapshot(snapshot(1), admin); service.recordSnapshot(snapshot(2), admin); });
  afterEach(() => db.close());

  test('B376 normalizes host CPU/NUMA/RAM/NIC/HBA/disk/GPU/BMC evidence and rejects secrets', () => {
    const overview = service.overview(admin); const host = overview.snapshots.find(item => item.hostId === 1);
    expect(host.summary).toEqual({ numaNodes: 2, nics: 1, hbas: 1, disks: 1, gpus: 1, vms: 3 });
    expect(host.hardware.bmc).toEqual({ vendor: 'Dell', model: 'iDRAC9', firmware: '7.10' });
    expect(() => service.recordSnapshot(snapshot(1, { credential: 'forbidden' }), admin)).toThrow(expect.objectContaining({ code: 'SECRET_FIELD' }));
  });

  test('B377 builds common/extra/missing compatibility tags per cluster', () => {
    const matrix = service.compatibilityMatrix('cluster-a', admin);
    expect(matrix.common).toEqual(expect.arrayContaining(['provider:proxmox', 'cpu-vendor:intel']));
    expect(matrix.union).toEqual(expect.arrayContaining(['generation:16g', 'generation:15g']));
    expect(matrix.hosts.find(item => item.hostId === 2).missing).toContain('cpu:avx2');
  });

  test('B378 exposes common, extra and missing CPU feature baselines', () => {
    const baseline = service.cpuBaseline('cluster-a', admin);
    expect(baseline.common).toEqual(['aes', 'avx', 'sse4.2']);
    expect(baseline.hosts.find(item => item.hostId === 1).extra).toEqual(['avx2']);
    expect(baseline.hosts.find(item => item.hostId === 2).missing).toEqual(['avx2']);
  });

  test('B379 stores a provider-aware CPU policy plan without applying it', () => {
    const policy = service.saveCpuPolicy('cluster-a', { mode: 'custom', baselineFeatures: ['aes', 'avx2'] }, admin);
    expect(policy).toMatchObject({ adapterState: 'plan_ready', state: 'blocked', providerMutationsStarted: 0,
      changePlan: { adapter: 'proxmox.cpu-model', applyEndpoint: null, providerMutationsStarted: 0 } });
    expect(policy.blockers[0]).toMatchObject({ code: 'CPU_FEATURE_MISSING', hostRef: 'pve-2', features: ['avx2'] });
  });

  test('B380 renders NUMA nodes with local devices and workload placement', () => {
    const topology = service.numaTopology(1, admin);
    expect(topology.nodes[0].devices).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'gpu-1', kind: 'gpu' })]));
    expect(topology.nodes[0].workloads).toEqual(expect.arrayContaining(['ddr_vm_rt', 'ddr_vm_bad']));
  });

  test('B381 identifies oversized topology, cross-node pinning and remote devices', () => {
    const fit = service.analyzeNumaFit('ddr_vm_bad', 1, admin);
    expect(fit.state).toBe('blocked');
    expect(fit.blockers.map(item => item.code)).toEqual(expect.arrayContaining(['VCPU_EXCEEDS_NUMA_NODE', 'MEMORY_EXCEEDS_NUMA_NODE']));
    expect(fit.warnings.map(item => item.code)).toEqual(expect.arrayContaining(['PINNING_SPANS_NUMA_NODES', 'DEVICE_REMOTE_NUMA']));
  });

  test('B382 reports dedicated/shared pools, free isolated CPUs and conflicts', () => {
    const pinning = service.cpuPinning('cluster-a', admin); const host = pinning.hosts.find(item => item.hostId === 1);
    expect(pinning.conflictCount).toBe(1);
    expect(host.conflicts[0]).toEqual({ cpuId: 0, workloads: ['ddr_vm_rt', 'ddr_vm_bad', 'ddr_vm_conflict'] });
    expect(host.freeIsolatedCpuIds).toEqual([2, 3]);
  });

  test('B383 evaluates pinning, isolation, hugepages, latency and memory reclaim for real-time workloads', () => {
    const profile = service.realtimeProfile('ddr_vm_rt', 1, admin);
    expect(profile.state).toBe('pass');
    expect(profile.checks).toHaveLength(6);
    expect(profile.checks.every(item => item.state === 'pass')).toBe(true);
  });

  test('B384 aggregates hugepage capacity, allocation and node fragmentation', () => {
    const dashboard = service.hugepageDashboard(1, admin); const page2m = dashboard.sizes.find(item => item.sizeKb === 2048);
    expect(page2m).toMatchObject({ total: 200, free: 85, reserved: 15, allocated: 100, fragmentedNodes: [0] });
    expect(dashboard.workloads).toEqual([expect.objectContaining({ resourceKey: 'ddr_vm_rt', sizeKb: 2048 })]);
  });

  test('B385 surfaces overcommit, balloon and swap pressure without remediation', () => {
    const dashboard = service.memoryDashboard(1, admin);
    expect(dashboard.state).toBe('critical');
    expect(dashboard.signals.map(item => item.code)).toEqual(expect.arrayContaining(['HOST_MEMORY_PRESSURE', 'SWAP_ACTIVE', 'BALLOON_RECLAIM']));
    expect(dashboard).toMatchObject({ hostId: 1, evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  test('API and operator UI expose all analyses but no hardware apply endpoint', () => {
    const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'hardware-performance.js'), 'utf8');
    const ui = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'pages', 'governance-controls.js'), 'utf8');
    expect(route).toContain("router.get('/hosts/:hostId/numa'");
    expect(route).toContain("router.get('/vms/:resourceKey/realtime-profile'");
    expect(route).not.toMatch(/router\.(?:post|put)\([^\n]*(?:apply|execute|attach|detach)/i);
    expect(ui).toMatch(/Hardware &amp; performance|Hardware & performance/);
    expect(ui).toContain('No provider apply endpoint exists');
  });
});
