'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const migration124 = require('../db/migrations/124_governance_foundation');
const migration145 = require('../db/migrations/145_hardware_device_accelerators');
const { HardwareDeviceService } = require('../services/hardware-devices');

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
  migration124.up(db); migration145.up(db); return db;
}

function snapshot(hostId = 1, overrides = {}) {
  return { hostId, observedAt: '2026-07-30T03:00:00.000Z',
    memoryTiers: [
      { kind: 'dram', capacityBytes: 256 * GiB, usedBytes: 128 * GiB, hitRatePercent: 99.5, workloadImpact: 'primary' },
      { kind: 'nvme-cache', capacityBytes: 1024 * GiB, usedBytes: 256 * GiB, hitRatePercent: 87.2, workloadImpact: 'cold pages' },
    ],
    pciDevices: [
      { id: 'pf-0', address: '0000:18:00.0', vendor: 'Intel', model: 'E810 PF', classCode: '0200', iommuGroup: 18, numaNode: 0, resetSupported: true, acsIsolated: true, kind: 'pf', driver: 'ice', health: 'healthy' },
      { id: 'vf-0', address: '0000:18:00.1', vendor: 'Intel', model: 'E810 VF', classCode: '0200', iommuGroup: 19, numaNode: 0, resetSupported: true, acsIsolated: true, kind: 'vf', parentRef: 'pf-0', driver: 'vfio-pci', health: 'healthy' },
      { id: 'vf-1', address: '0000:18:00.2', vendor: 'Intel', model: 'E810 VF', classCode: '0200', iommuGroup: 20, numaNode: 0, resetSupported: true, acsIsolated: true, kind: 'vf', parentRef: 'pf-0', driver: 'vfio-pci', health: 'healthy' },
      { id: 'pci-ready', address: '0000:30:00.0', vendor: 'Broadcom', model: 'HBA', classCode: '0107', iommuGroup: 30, numaNode: 1, resetSupported: true, acsIsolated: true, kind: 'pci', driver: 'vfio-pci', health: 'healthy' },
      { id: 'pci-gpu-0', address: '0000:65:00.0', vendor: 'NVIDIA', model: 'L40S', classCode: '0302', iommuGroup: 42, numaNode: 0, resetSupported: true, acsIsolated: true, kind: 'gpu', driver: 'vfio-pci', health: 'healthy' },
      { id: 'pci-bad', address: '0000:66:00.0', vendor: 'Legacy', model: 'Unsafe card', classCode: 'ff00', iommuGroup: 43, numaNode: 1, resetSupported: false, acsIsolated: false, kind: 'pci', driver: 'native', health: 'degraded' },
    ],
    gpus: [{ id: 'gpu-0', pciRef: 'pci-gpu-0', vendor: 'NVIDIA', model: 'L40S', memoryBytes: 48 * GiB,
      driverVersion: '550.90', health: 'healthy', migCapable: true,
      profiles: [{ name: '1g.12gb', total: 4, available: 2, memoryBytes: 12 * GiB, licenseState: 'licensed' }] }],
    usbDevices: [
      { id: 'usb-1', vendorId: '046d', productId: 'c534', vendor: 'Logitech', model: 'Receiver', busPath: '1-2', mobility: 'host-bound', mappedTo: 'ddr_vm_legacy' },
      { id: 'usb-2', vendorId: '1050', productId: '0407', vendor: 'Yubico', model: 'YubiKey', busPath: '1-3', owner: 'security', mobility: 'remappable' },
    ], ...overrides };
}

describe('v8.71 hardware devices and accelerators (B386-B395)', () => {
  let db; let service;
  beforeEach(() => { db = database(); service = new HardwareDeviceService(() => db); service.record(snapshot(), admin); });
  afterEach(() => db.close());

  test('B386 reports memory tier capacity, use, hit rate and workload impact', () => {
    const result = service.memoryTiers(1, admin);
    expect(result.tiers).toEqual([expect.objectContaining({ kind: 'dram', utilizationRatio: 0.5, hitRatePercent: 99.5 }), expect.objectContaining({ kind: 'nvme-cache', utilizationRatio: 0.25, workloadImpact: 'cold pages' })]);
    expect(() => service.record(snapshot(2, { memoryTiers: [{ kind: 'dram', capacityBytes: 1, usedBytes: 2 }] }), admin)).toThrow('usedBytes cannot exceed capacityBytes');
  });

  test('B387 normalizes PCI/IOMMU inventory and explains passthrough readiness', () => {
    const result = service.pci(1, admin); const unsafe = result.devices.find(item => item.id === 'pci-bad');
    expect(result.iommuGroups.find(item => item.group === 42)).toMatchObject({ deviceRefs: ['pci-gpu-0'], isolated: true });
    expect(unsafe).toMatchObject({ passthroughReady: false, blockers: ['health', 'reset', 'iommu_isolation'] });
  });

  test('B388 creates and releases PCI passthrough plans without provider mutation', () => {
    const allocation = service.planAllocation({ hostId: 1, kind: 'pci', deviceRef: 'pci-ready', targetResourceKey: 'ddr_vm_db' }, admin);
    expect(allocation).toMatchObject({ state: 'planned', plan: { applyEndpoint: null, providerMutationsStarted: 0 }, blockers: [] });
    expect(service.releaseAllocation(allocation.id, admin)).toEqual({ released: true, infrastructureMutated: false });
  });

  test('B389 auto-selects distinct eligible SR-IOV virtual functions', () => {
    const first = service.planAllocation({ hostId: 1, kind: 'sriov_vf', parentRef: 'pf-0', targetResourceKey: 'ddr_vm_a' }, admin);
    const second = service.planAllocation({ hostId: 1, kind: 'sriov_vf', parentRef: 'pf-0', targetResourceKey: 'ddr_vm_b' }, admin);
    expect([first.plan.deviceRef, second.plan.deviceRef]).toEqual(['vf-0', 'vf-1']);
  });

  test('B390 inventories GPU model, memory, driver, health and licensed profiles', () => {
    const result = service.gpus(1, admin);
    expect(result.devices[0]).toMatchObject({ id: 'gpu-0', model: 'L40S', memoryBytes: 48 * GiB, driverVersion: '550.90', health: 'healthy', migCapable: true });
    expect(result.devices[0].profiles[0]).toMatchObject({ name: '1g.12gb', available: 2, licenseState: 'licensed' });
  });

  test('B391 plans full GPU passthrough with NUMA, migration and HA constraints', () => {
    const result = service.planAllocation({ hostId: 1, kind: 'gpu', deviceRef: 'gpu-0', targetResourceKey: 'ddr_vm_ai', tenantId: 1 }, admin);
    expect(result.plan.constraints).toMatchObject({ numaNode: 0, migration: expect.stringContaining('equivalent target'), ha: expect.stringContaining('equivalent device'), blockers: [] });
    expect(result.providerMutationsStarted).toBe(0);
  });

  test('B392 allocates vGPU profile capacity and blocks overbooking/full-GPU conflict', () => {
    for (const target of ['ddr_vm_ai_1', 'ddr_vm_ai_2']) expect(service.planAllocation({ hostId: 1, kind: 'vgpu', deviceRef: 'gpu-0', profileName: '1g.12gb', targetResourceKey: target }, admin).state).toBe('planned');
    const third = service.planAllocation({ hostId: 1, kind: 'vgpu', deviceRef: 'gpu-0', profileName: '1g.12gb', targetResourceKey: 'ddr_vm_ai_3' }, admin);
    const full = service.planAllocation({ hostId: 1, kind: 'gpu', deviceRef: 'gpu-0', targetResourceKey: 'ddr_vm_full' }, admin);
    expect(third.blockers).toContain('vGPU profile capacity already planned'); expect(full.blockers).toContain('control-plane allocation already planned');
  });

  test('B393 stores bounded GPU utilization and health telemetry idempotently', () => {
    const body = { hostId: 1, deviceRef: 'gpu-0', resourceKey: 'ddr_vm_ai', observedAt: '2026-07-30T03:05:00Z', smPercent: 72, memoryPercent: 61, encoderPercent: 4, eccErrors: 0, throttleReasons: ['power'] };
    expect(service.recordMetrics(body, admin)).toMatchObject({ duplicate: false, metrics: { smPercent: 72, memoryPercent: 61, throttleReasons: ['power'] } });
    expect(service.recordMetrics(body, admin).duplicate).toBe(true);
    expect(() => service.recordMetrics({ ...body, deviceRef: 'missing' }, admin)).toThrow('GPU not found');
  });

  test('B394 schedules accelerator reservations and rejects overlapping full/profile windows', () => {
    const body = { hostId: 1, deviceRef: 'gpu-0', profileName: '1g.12gb', tenantId: 1, startsAt: '2030-01-01T10:00:00Z', endsAt: '2030-01-01T12:00:00Z', purpose: 'training' };
    const saved = service.reserve(body, admin); expect(saved).toMatchObject({ state: 'reserved', duplicate: false, providerMutationsStarted: 0 });
    expect(service.reserve(body, admin).duplicate).toBe(true);
    expect(() => service.reserve({ ...body, profileName: undefined, startsAt: '2030-01-01T11:00:00Z', endsAt: '2030-01-01T13:00:00Z', purpose: 'full gpu' }, admin)).toThrow(expect.objectContaining({ code: 'RESERVATION_CONFLICT' }));
  });

  test('B395 reports USB ownership, mapping and migration caveats through API/UI', () => {
    const result = service.usb(1, admin);
    expect(result.devices[0].caveats).toEqual(['migration requires remapping', 'already mapped', 'owner missing']);
    const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'hardware-performance.js'), 'utf8');
    const ui = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'pages', 'governance-controls.js'), 'utf8');
    expect(route).toContain("router.get('/devices/hosts/:hostId/usb'"); expect(route).not.toMatch(/devices\/(?:apply|attach|detach)/);
    expect(ui).toContain('Devices &amp; accelerators evidence boundary'); expect(ui).toContain('provider attach/detach is deliberately unavailable');
  });
});
