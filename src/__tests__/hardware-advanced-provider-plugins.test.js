'use strict';

const crypto = require('crypto');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const migration124 = require('../db/migrations/124_governance_foundation');
const migration144 = require('../db/migrations/144_hardware_performance_foundation');
const migration145 = require('../db/migrations/145_hardware_device_accelerators');
const migration146 = require('../db/migrations/146_hardware_advanced_provider_plugins');
const { HardwarePerformanceService } = require('../services/hardware-performance');
const { HardwareDeviceService } = require('../services/hardware-devices');
const { HardwareAdvancedService } = require('../services/hardware-advanced');
const { ProviderPluginService, canonicalPayload } = require('../services/provider-plugins');

const admin = { id: 1, username: 'admin', role: 'admin' }; const GiB = 1024 ** 3;
function database() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY,username TEXT UNIQUE,email TEXT,password_hash TEXT,role TEXT,is_active INTEGER DEFAULT 1,display_name TEXT,auth_source TEXT DEFAULT 'local',must_change_password INTEGER DEFAULT 0,created_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE tenants (id INTEGER PRIMARY KEY,slug TEXT UNIQUE,name TEXT,kind TEXT DEFAULT 'internal',usage_mode TEXT DEFAULT 'production',status TEXT DEFAULT 'active',is_default INTEGER DEFAULT 0,trial_expires_at TEXT,created_by TEXT,created_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE user_tenants (user_id INTEGER,tenant_id INTEGER,role TEXT,is_owner INTEGER,created_at TEXT,PRIMARY KEY(user_id,tenant_id));
    CREATE TABLE teams (id INTEGER PRIMARY KEY,name TEXT UNIQUE,description TEXT,created_by INTEGER,created_at TEXT,updated_at TEXT);
    CREATE TABLE team_members (team_id INTEGER,user_id INTEGER,is_leader INTEGER,added_by INTEGER,added_at TEXT,PRIMARY KEY(team_id,user_id));
    CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY,name TEXT,daemon_type TEXT,is_active INTEGER DEFAULT 1);
    INSERT INTO users (id,username,email,password_hash,role) VALUES (1,'admin','admin@test','x','admin');
    INSERT INTO tenants (id,slug,name) VALUES (1,'platform','Platform');
    INSERT INTO docker_hosts (id,name,daemon_type) VALUES (1,'pve-a','proxmox'),(2,'pve-b','proxmox');
  `); migration124.up(db); migration144.up(db); migration145.up(db); migration146.up(db); return db;
}
function hardware(hostId) {
  return { hostId, providerType: 'proxmox', clusterRef: 'cluster-a', hostRef: `pve-${hostId}`, model: 'Dell R760', generation: '16g', observedAt: `2026-07-30T04:0${hostId}:00Z`, source: { kind: 'api', adapter: 'test', version: '8.2', coverage: ['cpu','memory','vms'] }, cpu: { vendor: 'Intel', model: 'Xeon', sockets: 1, cores: 8, threads: 16, features: ['aes','avx2'], isolatedCpuIds: [0,1] }, memory: { totalBytes: 128 * GiB, reservedBytes: 8 * GiB, activeBytes: 32 * GiB, balloonBytes: 0, swapUsedBytes: 0 }, numaNodes: [{ id: 0, cpuIds: [0,1,2,3,4,5,6,7], memoryBytes: 128 * GiB, freeMemoryBytes: 80 * GiB, hugepages: [] }], nics: [], hbas: [], disks: [], gpus: [], bmc: { vendor: 'Dell', model: 'iDRAC', firmware: '7.0' }, vms: hostId === 1 ? [{ resourceKey: 'ddr_vm_app', name: 'app', vcpus: 4, memoryBytes: 8 * GiB, activeMemoryBytes: 4 * GiB, numaNodes: [{ nodeId: 0, vcpus: 4, memoryBytes: 8 * GiB }], cpuPinning: [], dedicatedCpu: false, deviceRefs: [{ id: 'gpu-source', kind: 'gpu', numaNode: 0 }] }] : [] };
}
function devices(hostId) {
  return { hostId, observedAt: `2026-07-30T04:1${hostId}:00Z`, memoryTiers: [{ kind: 'dram', capacityBytes: 128 * GiB, usedBytes: 32 * GiB }], pciDevices: [{ id: `pci-gpu-${hostId}`, address: `0000:6${hostId}:00.0`, vendor: 'NVIDIA', model: 'L40S', classCode: '0302', iommuGroup: 40 + hostId, numaNode: 0, resetSupported: true, acsIsolated: true, kind: 'gpu', health: 'healthy' }], gpus: [{ id: `gpu-${hostId}`, pciRef: `pci-gpu-${hostId}`, vendor: 'NVIDIA', model: 'L40S', memoryBytes: 48 * GiB, health: 'healthy', migCapable: true, profiles: [] }], usbDevices: [] };
}
function signedPlugin(plugin, overrides = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519'); const manifest = { schemaVersion: '1.0', pluginKey: plugin, name: `${plugin} provider`, version: '1.0.0', apiVersion: '1.0', minCoreVersion: '8.0.0', maxCoreVersion: '9.0.0', permissions: ['inventory.read'], capabilities: ['inventory.vm'], entrypoint: { kind: 'declarative-rpc', protocol: 'json-stdio' }, ...overrides };
  return { manifest, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), signatureBase64: crypto.sign(null, canonicalPayload(manifest), privateKey).toString('base64') };
}

describe('v8.72 advanced performance and signed plugins (B396-B405)', () => {
  let db; let advanced; let plugins;
  beforeEach(() => { db = database(); const hp = new HardwarePerformanceService(() => db); const hd = new HardwareDeviceService(() => db); hp.recordSnapshot(hardware(1), admin); hp.recordSnapshot(hardware(2), admin); hd.record(devices(1), admin); hd.record(devices(2), admin); advanced = new HardwareAdvancedService(() => db); plugins = new ProviderPluginService(() => db); });
  afterEach(() => db.close());

  test('B396 scans VM CPU, memory, device and provider/version compatibility without mutation', () => {
    const pass = advanced.compatibilityScan({ resourceKey: 'ddr_vm_app', targetHostId: 2, targetProviderVersion: '8.2.1', minimumProviderVersion: '8.0.0', requiredCpuFeatures: ['aes','avx2'] }, admin);
    expect(pass).toMatchObject({ state: 'compatible', providerMutationsStarted: 0 }); expect(pass.checks.every(item => item.state === 'pass')).toBe(true);
    expect(advanced.compatibilityScan({ resourceKey: 'ddr_vm_app', targetHostId: 2, targetProviderVersion: '8.2.1', minimumProviderVersion: '9.0.0', requiredCpuFeatures: ['avx512'] }, admin).state).toBe('blocked');
  });
  test('B397 stores controlled benchmark baselines with hardware evidence', () => {
    const result = advanced.recordBenchmark({ hostId: 1, suite: 'fio', suiteVersion: '3.39', metric: 'random-read-iops', unit: 'iops', score: 125000, direction: 'higher', controlled: true, runConfig: { blockSize: '4k', queueDepth: 32 }, observedAt: '2026-07-30T05:00:00Z' }, admin);
    expect(result).toMatchObject({ controlled: true, hardware: { model: 'Dell R760', snapshotEvidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/) } }); expect(() => advanced.recordBenchmark({ ...result, controlled: false }, admin)).toThrow('controlled must be true');
  });
  test('B398 correlates target contention with colocated peer pressure and states the causation caveat', () => {
    advanced.recordSample({ hostId: 1, resourceKey: 'ddr_vm_app', observedAt: '2026-07-30T05:10:00Z', cpuUtilizationPercent: 40, cpuReadyPercent: 8, storageLatencyMs: 25, memoryPressurePercent: 50 }, admin);
    advanced.recordSample({ hostId: 1, resourceKey: 'ddr_vm_peer', observedAt: '2026-07-30T05:10:30Z', cpuUtilizationPercent: 95, cpuReadyPercent: 1, storageQueueDepth: 12, memoryPressurePercent: 40 }, admin);
    const result = advanced.noisyNeighbors('ddr_vm_app', { windowMinutes: 5 }, admin); expect(result).toMatchObject({ state: 'suspected', targetSignals: ['cpu_ready','storage_latency'], candidates: [expect.objectContaining({ resourceKey: 'ddr_vm_peer', signals: ['cpu_saturation','storage_queue'] })] }); expect(result.caveat).toContain('not proof');
  });
  test('B399 detects before/after benchmark regression in metric direction', () => {
    const base = advanced.recordBenchmark({ hostId: 1, suite: 'sysbench', suiteVersion: '1.0.20', metric: 'transactions', unit: 'tps', score: 1000, direction: 'higher', controlled: true, runConfig: {}, observedAt: '2026-07-30T05:00:00Z' }, admin); const candidate = advanced.recordBenchmark({ hostId: 2, suite: 'sysbench', suiteVersion: '1.0.20', metric: 'transactions', unit: 'tps', score: 880, direction: 'higher', controlled: true, runConfig: {}, observedAt: '2026-07-30T06:00:00Z' }, admin);
    expect(advanced.compareBenchmarks({ baselineBenchmarkId: base.id, candidateBenchmarkId: candidate.id, changeRef: 'migration:42', thresholdPercent: 5 }, admin)).toMatchObject({ deltaPercent: -12, regressionPercent: 12, state: 'regression', providerMutationsStarted: 0 });
  });
  test('B400 assigns and evaluates workload performance presets as desired policy only', () => {
    advanced.recordSample({ hostId: 1, resourceKey: 'ddr_vm_app', observedAt: '2026-07-30T05:10:00Z', cpuReadyPercent: 3, storageLatencyMs: 4, memoryPressurePercent: 70, networkLatencyMs: 3 }, admin); const profile = advanced.saveProfile('ddr_vm_app', { preset: 'latency' }, admin); expect(profile).toMatchObject({ applyEndpoint: null, providerMutationsStarted: 0, thresholds: { maxCpuReadyPercent: 2 } }); expect(advanced.evaluateProfile('ddr_vm_app', admin)).toMatchObject({ state: 'degraded', checks: expect.arrayContaining([expect.objectContaining({ metric: 'cpuReadyPercent', state: 'fail' })]) });
  });
  test('B401 verifies Ed25519 signatures over canonical provider plugin manifests', () => {
    const signed = signedPlugin('demo-provider'); expect(plugins.register(signed, admin)).toMatchObject({ pluginKey: 'demo-provider', signatureState: 'verified', enabled: false }); expect(() => plugins.register({ ...signed, signatureBase64: Buffer.alloc(64).toString('base64') }, admin)).toThrow(expect.objectContaining({ code: 'INVALID_SIGNATURE' }));
  });
  test('B402 runs fixed RPC in a separate process and returns no plugin payload', async () => {
    const registered = plugins.register(signedPlugin('sandbox-provider'), admin); plugins.consent('sandbox-provider', { manifestHash: registered.manifestHash, permissionKey: 'inventory.read', decision: 'granted', reason: 'Read-only inventory approved' }, admin); plugins.enable('sandbox-provider', { enabled: true }, admin); const result = await plugins.sandboxProbe('sandbox-provider', { method: 'health.check', payload: { probe: 'bounded' } }, admin); expect(result).toMatchObject({ status: 'passed', outOfProcess: true, payloadReturned: false, policy: { pluginCodeLoaded: false, environment: 'empty' } }); expect(result.response).not.toHaveProperty('payload');
  });
  test('B403 binds explicit risk-aware permission consent to the exact manifest hash', () => {
    const registered = plugins.register(signedPlugin('consent-provider', { permissions: ['inventory.read','network.egress'] }), admin); expect(plugins.consent('consent-provider', { manifestHash: registered.manifestHash, permissionKey: 'network.egress', decision: 'denied', reason: 'No external network approved' }, admin)).toMatchObject({ risk: 'network', decision: 'denied' }); expect(() => plugins.consent('consent-provider', { manifestHash: '0'.repeat(64), permissionKey: 'inventory.read', decision: 'granted', reason: 'stale' }, admin)).toThrow(expect.objectContaining({ code: 'STALE_MANIFEST' }));
  });
  test('B404 blocks enable until signature, versions, schema, capabilities and consents pass', () => {
    const registered = plugins.register(signedPlugin('compat-provider'), admin); expect(plugins.compatibility('compat-provider', admin).state).toBe('blocked'); expect(() => plugins.enable('compat-provider', { enabled: true }, admin)).toThrow(expect.objectContaining({ code: 'PLUGIN_NOT_READY' })); plugins.consent('compat-provider', { manifestHash: registered.manifestHash, permissionKey: 'inventory.read', decision: 'granted', reason: 'Approved for inventory' }, admin); expect(plugins.compatibility('compat-provider', admin).state).toBe('ready'); expect(plugins.enable('compat-provider', { enabled: true }, admin).state).toBe('enabled');
  });
  test('B405 stores aggregate crash/latency/rate/error health without payload fields', () => {
    plugins.register(signedPlugin('health-provider'), admin); const health = plugins.recordHealth('health-provider', { observedAt: '2026-07-30T06:00:00Z', latencyMs: 25, requestCount: 100, errorCount: 2, crashCount: 0 }, admin); expect(health).toMatchObject({ errorRate: 0.02, state: 'healthy', payloadFieldsStored: [] }); expect(() => plugins.recordHealth('health-provider', { latencyMs: 1, requestCount: 1, errorCount: 0, crashCount: 0, payloadSecret: 'forbidden' }, admin)).toThrow(expect.objectContaining({ code: 'SECRET_FIELD' }));
    expect(() => plugins.recordHealth('health-provider', { latencyMs: 1, requestCount: 1, errorCount: 0, crashCount: 0, rawPayload: 'forbidden' }, admin)).toThrow(expect.objectContaining({ code: 'UNEXPECTED_FIELD' }));
    const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'provider-plugins.js'), 'utf8'); const ui = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'pages', 'governance-controls.js'), 'utf8'); expect(routes).toContain("router.post('/:pluginKey/sandbox-probes'"); expect(routes).not.toMatch(/router\.(?:post|put)\([^\n]*(?:install|execute-code)/i); expect(ui).toContain('Provider plugin trust boundary'); expect(ui).toContain('never loads plugin code');
  });
});
