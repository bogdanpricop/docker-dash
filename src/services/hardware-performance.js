'use strict';

const crypto = require('crypto');
const { getDb } = require('../db');

const SAFE_TEXT = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@+ -]{0,299}$/;
const SAFE_FEATURE = /^[a-zA-Z0-9][a-zA-Z0-9_.:+-]{0,79}$/;
const SECRET_KEY = /password|secret|token|credential|private.?key|authorization|cookie/i;
const SOURCE_KINDS = new Set(['provider', 'api', 'ssh', 'import', 'manual']);
const POLICY_MODES = new Set(['host-passthrough', 'cluster-baseline', 'vendor-compatibility', 'custom']);

class HardwarePerformanceError extends Error {
  constructor(message, status = 400, code = 'HARDWARE_PERFORMANCE_ERROR', details) {
    super(message); this.name = 'HardwarePerformanceError'; this.status = status; this.code = code; this.details = details;
  }
}

const fail = (message, status, code, details) => new HardwarePerformanceError(message, status, code, details);
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stable = value => JSON.stringify(canonical(value));
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
const text = (value, field, max = 300) => {
  const result = String(value ?? '').trim();
  if (!result || result.length > max || !SAFE_TEXT.test(result)) throw fail(`${field} is invalid`);
  return result;
};
const optionalText = (value, field, max = 300) => value == null || value === '' ? null : text(value, field, max);
const integer = (value, field, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw fail(`${field} must be an integer between ${min} and ${max}`);
  return result;
};
const timestamp = (value, field) => {
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) throw fail(`${field} must be an ISO timestamp`);
  return result.toISOString();
};
const list = (value, field, max, mapper) => {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > max) throw fail(`${field} must contain at most ${max} items`);
  return value.map((item, index) => mapper(item, `${field}[${index}]`));
};
const featureList = (value, field, max = 512) => [...new Set(list(value, field, max, (item, key) => {
  const result = String(item ?? '').trim().toLowerCase();
  if (!result || !SAFE_FEATURE.test(result)) throw fail(`${key} is invalid`);
  return result;
}))].sort();
const intList = (value, field, max = 4096) => [...new Set(list(value, field, max,
  (item, key) => integer(item, key, 0, 1048575)))].sort((a, b) => a - b);
const boundedDocument = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('snapshot must be an object');
  const encoded = stable(value);
  if (Buffer.byteLength(encoded) > 512 * 1024) throw fail('snapshot exceeds 524288 bytes', 413, 'DOCUMENT_TOO_LARGE');
  const visit = (node, path) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if (SECRET_KEY.test(key)) throw fail(`${path}.${key} may not contain secret material`, 400, 'SECRET_FIELD');
      visit(child, `${path}.${key}`);
    }
  };
  visit(value, 'snapshot');
};
const bytes = (value, field) => integer(value ?? 0, field, 0, 1125899906842624);
const ratio = (numerator, denominator) => denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null;

function normalizeDevice(item, field, kind) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw fail(`${field} must be an object`);
  const result = {
    id: text(item.id, `${field}.id`, 160),
    model: text(item.model, `${field}.model`, 200),
    vendor: optionalText(item.vendor, `${field}.vendor`, 120),
    numaNode: item.numaNode == null ? null : integer(item.numaNode, `${field}.numaNode`, 0, 4095),
    features: featureList(item.features || [], `${field}.features`, 100),
  };
  if (kind === 'nic') result.speedMbps = integer(item.speedMbps ?? 0, `${field}.speedMbps`, 0, 10000000);
  if (kind === 'hba') result.ports = integer(item.ports ?? 0, `${field}.ports`, 0, 1024);
  if (kind === 'disk') {
    result.capacityBytes = bytes(item.capacityBytes, `${field}.capacityBytes`);
    result.media = optionalText(item.media, `${field}.media`, 40);
  }
  if (kind === 'gpu') {
    result.memoryBytes = bytes(item.memoryBytes, `${field}.memoryBytes`);
    result.driverVersion = optionalText(item.driverVersion, `${field}.driverVersion`, 80);
    result.health = ['healthy', 'degraded', 'failed', 'unknown'].includes(item.health) ? item.health : 'unknown';
  }
  return result;
}

function normalizeSnapshot(body) {
  boundedDocument(body);
  const numaNodes = list(body.numaNodes, 'numaNodes', 256, (node, field) => ({
    id: integer(node?.id, `${field}.id`, 0, 4095),
    cpuIds: intList(node?.cpuIds || [], `${field}.cpuIds`),
    memoryBytes: bytes(node?.memoryBytes, `${field}.memoryBytes`),
    freeMemoryBytes: bytes(node?.freeMemoryBytes, `${field}.freeMemoryBytes`),
    hugepages: list(node?.hugepages, `${field}.hugepages`, 16, (page, pageField) => ({
      sizeKb: integer(page?.sizeKb, `${pageField}.sizeKb`, 4, 1073741824),
      total: integer(page?.total ?? 0, `${pageField}.total`, 0),
      free: integer(page?.free ?? 0, `${pageField}.free`, 0),
      reserved: integer(page?.reserved ?? 0, `${pageField}.reserved`, 0),
    })),
  })).sort((a, b) => a.id - b.id);
  const cpu = body.cpu || {};
  const vms = list(body.vms, 'vms', 10000, (vm, field) => ({
    resourceKey: text(vm?.resourceKey, `${field}.resourceKey`, 180),
    name: text(vm?.name || vm?.resourceKey, `${field}.name`, 180),
    vcpus: integer(vm?.vcpus ?? 0, `${field}.vcpus`, 0, 1048576),
    memoryBytes: bytes(vm?.memoryBytes, `${field}.memoryBytes`),
    activeMemoryBytes: bytes(vm?.activeMemoryBytes, `${field}.activeMemoryBytes`),
    balloonBytes: bytes(vm?.balloonBytes, `${field}.balloonBytes`),
    swapBytes: bytes(vm?.swapBytes, `${field}.swapBytes`),
    numaNodes: list(vm?.numaNodes, `${field}.numaNodes`, 256, (node, nodeField) => ({
      nodeId: integer(node?.nodeId, `${nodeField}.nodeId`, 0, 4095),
      vcpus: integer(node?.vcpus ?? 0, `${nodeField}.vcpus`, 0, 1048576),
      memoryBytes: bytes(node?.memoryBytes, `${nodeField}.memoryBytes`),
    })),
    cpuPinning: intList(vm?.cpuPinning || [], `${field}.cpuPinning`),
    dedicatedCpu: Boolean(vm?.dedicatedCpu),
    isolatedCpuRequired: Boolean(vm?.isolatedCpuRequired),
    hugepageSizeKb: vm?.hugepageSizeKb == null ? null : integer(vm.hugepageSizeKb, `${field}.hugepageSizeKb`, 4, 1073741824),
    latencySensitivity: ['normal', 'high', 'realtime'].includes(vm?.latencySensitivity) ? vm.latencySensitivity : 'normal',
    deviceRefs: list(vm?.deviceRefs, `${field}.deviceRefs`, 128, (device, deviceField) => ({
      id: text(device?.id, `${deviceField}.id`, 160),
      kind: text(device?.kind, `${deviceField}.kind`, 40),
      numaNode: device?.numaNode == null ? null : integer(device.numaNode, `${deviceField}.numaNode`, 0, 4095),
    })),
  }));
  return {
    cpu: {
      vendor: text(cpu.vendor, 'cpu.vendor', 120), model: text(cpu.model, 'cpu.model', 200),
      sockets: integer(cpu.sockets, 'cpu.sockets', 1, 1024), cores: integer(cpu.cores, 'cpu.cores', 1, 1048576),
      threads: integer(cpu.threads, 'cpu.threads', 1, 2097152), features: featureList(cpu.features, 'cpu.features'),
      isolatedCpuIds: intList(cpu.isolatedCpuIds || [], 'cpu.isolatedCpuIds'),
    },
    memory: {
      totalBytes: bytes(body.memory?.totalBytes, 'memory.totalBytes'),
      reservedBytes: bytes(body.memory?.reservedBytes, 'memory.reservedBytes'),
      activeBytes: bytes(body.memory?.activeBytes, 'memory.activeBytes'),
      balloonBytes: bytes(body.memory?.balloonBytes, 'memory.balloonBytes'),
      swapUsedBytes: bytes(body.memory?.swapUsedBytes, 'memory.swapUsedBytes'),
    },
    numaNodes,
    nics: list(body.nics, 'nics', 2048, (item, field) => normalizeDevice(item, field, 'nic')),
    hbas: list(body.hbas, 'hbas', 2048, (item, field) => normalizeDevice(item, field, 'hba')),
    disks: list(body.disks, 'disks', 4096, (item, field) => normalizeDevice(item, field, 'disk')),
    gpus: list(body.gpus, 'gpus', 1024, (item, field) => normalizeDevice(item, field, 'gpu')),
    bmc: body.bmc ? { vendor: text(body.bmc.vendor, 'bmc.vendor', 120), model: text(body.bmc.model, 'bmc.model', 160),
      firmware: optionalText(body.bmc.firmware, 'bmc.firmware', 80) } : null,
    vms,
  };
}

function tag(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9_.:+-]+/g, '-').replace(/^-|-$/g, '').slice(0, 80); }

class HardwarePerformanceService {
  constructor(dbProvider = getDb) { this._dbProvider = dbProvider; }
  _db() { return this._dbProvider(); }
  _admin(actor) {
    if (!actor?.id) throw fail('Authenticated user is required', 401, 'AUTH_REQUIRED');
    if (actor.role !== 'admin') throw fail('Administrator permission is required', 403, 'HARDWARE_FORBIDDEN');
  }
  _row(row) {
    if (!row) return null;
    return { id: row.id, hostId: row.host_id, providerType: row.provider_type, clusterRef: row.cluster_ref,
      hostRef: row.host_ref, model: row.model, generation: row.generation, observedAt: row.observed_at,
      source: parse(row.source_json, {}), hardware: parse(row.hardware_json, {}),
      compatibilityTags: parse(row.compatibility_tags_json, []), evidenceHash: row.evidence_hash,
      createdAt: row.created_at };
  }
  _policyRow(row) {
    if (!row) return null;
    return { id: row.id, clusterRef: row.cluster_ref, providerType: row.provider_type, mode: row.mode,
      baselineFeatures: parse(row.baseline_features_json, []), adapterState: row.adapter_state,
      state: row.policy_state, blockers: parse(row.blockers_json, []), changePlan: parse(row.change_plan_json, {}),
      planHash: row.plan_hash, providerMutationsStarted: 0, updatedAt: row.updated_at };
  }
  _latest(clusterRef = null) {
    const where = clusterRef ? 'AND s.cluster_ref=?' : '';
    return this._db().prepare(`SELECT s.* FROM hardware_host_snapshots s WHERE NOT EXISTS (
      SELECT 1 FROM hardware_host_snapshots newer WHERE newer.host_id=s.host_id
        AND (datetime(newer.observed_at)>datetime(s.observed_at) OR (newer.observed_at=s.observed_at AND newer.id>s.id))) ${where}
      ORDER BY s.cluster_ref,s.host_ref`).all(...(clusterRef ? [clusterRef] : [])).map(row => this._row(row));
  }
  _snapshot(hostId) {
    const row = this._db().prepare(`SELECT * FROM hardware_host_snapshots WHERE host_id=?
      ORDER BY datetime(observed_at) DESC,id DESC LIMIT 1`).get(integer(hostId, 'hostId', 1));
    if (!row) throw fail('Hardware snapshot not found', 404, 'HARDWARE_SNAPSHOT_NOT_FOUND');
    return this._row(row);
  }
  recordSnapshot(body = {}, actor) {
    this._admin(actor);
    const hostId = integer(body.hostId, 'hostId', 1);
    if (!this._db().prepare('SELECT 1 FROM docker_hosts WHERE id=?').get(hostId)) throw fail('Registered host not found', 404, 'HOST_NOT_FOUND');
    const providerType = text(body.providerType, 'providerType', 80).toLowerCase();
    const clusterRef = text(body.clusterRef, 'clusterRef', 160); const hostRef = text(body.hostRef, 'hostRef', 160);
    const model = text(body.model, 'model', 200); const generation = optionalText(body.generation, 'generation', 120);
    const observedAt = timestamp(body.observedAt || new Date().toISOString(), 'observedAt');
    const source = { kind: String(body.source?.kind || 'manual').toLowerCase(),
      adapter: text(body.source?.adapter || `${providerType}.hardware`, 'source.adapter', 120),
      version: optionalText(body.source?.version, 'source.version', 80),
      coverage: featureList(body.source?.coverage || [], 'source.coverage', 32) };
    if (!SOURCE_KINDS.has(source.kind)) throw fail('source.kind is invalid');
    const hardware = normalizeSnapshot(body);
    const generated = [`provider:${tag(providerType)}`, `model:${tag(model)}`, `cpu-vendor:${tag(hardware.cpu.vendor)}`];
    if (generation) generated.push(`generation:${tag(generation)}`);
    for (const feature of hardware.cpu.features.slice(0, 32)) generated.push(`cpu:${tag(feature)}`);
    const compatibilityTags = [...new Set([...generated, ...featureList(body.compatibilityTags || [], 'compatibilityTags', 128)])].sort();
    const evidenceHash = digest({ hostId, providerType, clusterRef, hostRef, model, generation, observedAt, source, hardware, compatibilityTags });
    const existing = this._db().prepare('SELECT * FROM hardware_host_snapshots WHERE evidence_hash=?').get(evidenceHash);
    if (existing) return { ...this._row(existing), duplicate: true };
    const result = this._db().prepare(`INSERT INTO hardware_host_snapshots
      (host_id,provider_type,cluster_ref,host_ref,model,generation,observed_at,source_json,hardware_json,compatibility_tags_json,evidence_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(hostId, providerType, clusterRef, hostRef, model, generation, observedAt,
      stable(source), stable(hardware), stable(compatibilityTags), evidenceHash, actor.id);
    return { ...this._row(this._db().prepare('SELECT * FROM hardware_host_snapshots WHERE id=?').get(result.lastInsertRowid)), duplicate: false };
  }
  compatibilityMatrix(clusterRef, actor) {
    this._admin(actor); const hosts = this._latest(text(clusterRef, 'clusterRef', 160));
    if (!hosts.length) throw fail('Cluster hardware evidence not found', 404, 'CLUSTER_NOT_FOUND');
    const sets = hosts.map(host => new Set(host.compatibilityTags));
    const common = [...sets[0]].filter(value => sets.every(set => set.has(value))).sort();
    const union = [...new Set(hosts.flatMap(host => host.compatibilityTags))].sort();
    return { clusterRef, common, union, hosts: hosts.map(host => ({ hostId: host.hostId, hostRef: host.hostRef,
      model: host.model, generation: host.generation, compatibleWithBaseline: common.every(value => host.compatibilityTags.includes(value)),
      extra: host.compatibilityTags.filter(value => !common.includes(value)), missing: union.filter(value => !host.compatibilityTags.includes(value)) })) };
  }
  cpuBaseline(clusterRef, actor) {
    this._admin(actor); const hosts = this._latest(text(clusterRef, 'clusterRef', 160));
    if (!hosts.length) throw fail('Cluster hardware evidence not found', 404, 'CLUSTER_NOT_FOUND');
    const features = hosts.map(host => new Set(host.hardware.cpu.features));
    const common = [...features[0]].filter(value => features.every(set => set.has(value))).sort();
    const union = [...new Set(hosts.flatMap(host => host.hardware.cpu.features))].sort();
    const vendors = [...new Set(hosts.map(host => host.hardware.cpu.vendor.toLowerCase()))];
    return { clusterRef, common, union, vendors, migrationBaselineSafe: vendors.length === 1 && common.length > 0,
      hosts: hosts.map(host => ({ hostId: host.hostId, hostRef: host.hostRef, cpu: host.hardware.cpu,
        extra: host.hardware.cpu.features.filter(value => !common.includes(value)), missing: union.filter(value => !host.hardware.cpu.features.includes(value)) })) };
  }
  saveCpuPolicy(clusterRef, body = {}, actor) {
    this._admin(actor); clusterRef = text(clusterRef, 'clusterRef', 160);
    const baseline = this.cpuBaseline(clusterRef, actor); const mode = String(body.mode || 'cluster-baseline');
    if (!POLICY_MODES.has(mode)) throw fail('mode is invalid');
    const providerType = text(body.providerType || this._latest(clusterRef)[0].providerType, 'providerType', 80).toLowerCase();
    const baselineFeatures = featureList(body.baselineFeatures || (mode === 'cluster-baseline' ? baseline.common : []), 'baselineFeatures');
    const blockers = baseline.hosts.filter(host => baselineFeatures.some(feature => !host.cpu.features.includes(feature)))
      .map(host => ({ code: 'CPU_FEATURE_MISSING', hostRef: host.hostRef,
        features: baselineFeatures.filter(feature => !host.cpu.features.includes(feature)) }));
    if (mode === 'host-passthrough' && baseline.hosts.length > 1) blockers.push({ code: 'HOST_PASSTHROUGH_MIGRATION_UNSAFE',
      hosts: baseline.hosts.map(host => host.hostRef) });
    const adapter = providerType === 'vsphere' ? { key: 'vsphere.evc', state: 'plan_ready' }
      : providerType === 'proxmox' ? { key: 'proxmox.cpu-model', state: 'plan_ready' }
        : providerType === 'xen' ? { key: 'xen.pool-cpu-features', state: 'inventory_only' }
          : { key: `${providerType}.cpu-compatibility`, state: 'unsupported' };
    const plan = { schemaVersion: 1, clusterRef, providerType, adapter: adapter.key, mode, baselineFeatures,
      preconditions: ['refresh all host CPU feature evidence', 'confirm powered-on VM compatibility', 'use a maintenance window'],
      affectedHosts: baseline.hosts.map(host => host.hostRef), blockers, applyEndpoint: null,
      providerMutationsStarted: 0, note: 'Desired policy only; no provider apply adapter is exposed by this API.' };
    const planHash = digest(plan); const state = blockers.length ? 'blocked' : 'ready';
    this._db().prepare(`INSERT INTO hardware_cpu_compatibility_policies
      (cluster_ref,provider_type,mode,baseline_features_json,adapter_state,policy_state,blockers_json,change_plan_json,plan_hash,updated_by,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now')) ON CONFLICT(cluster_ref) DO UPDATE SET provider_type=excluded.provider_type,
      mode=excluded.mode,baseline_features_json=excluded.baseline_features_json,adapter_state=excluded.adapter_state,
      policy_state=excluded.policy_state,blockers_json=excluded.blockers_json,change_plan_json=excluded.change_plan_json,
      plan_hash=excluded.plan_hash,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
      .run(clusterRef, providerType, mode, stable(baselineFeatures), adapter.state, state, stable(blockers), stable(plan), planHash, actor.id);
    return this._policyRow(this._db().prepare('SELECT * FROM hardware_cpu_compatibility_policies WHERE cluster_ref=?').get(clusterRef));
  }
  numaTopology(hostId, actor) {
    this._admin(actor); const snapshot = this._snapshot(hostId);
    return { hostId: snapshot.hostId, hostRef: snapshot.hostRef, clusterRef: snapshot.clusterRef,
      nodes: snapshot.hardware.numaNodes.map(node => ({ ...node,
        devices: [...snapshot.hardware.nics.map(item => ({ ...item, kind: 'nic' })), ...snapshot.hardware.hbas.map(item => ({ ...item, kind: 'hba' })),
          ...snapshot.hardware.disks.map(item => ({ ...item, kind: 'disk' })), ...snapshot.hardware.gpus.map(item => ({ ...item, kind: 'gpu' }))]
          .filter(item => item.numaNode === node.id),
        workloads: snapshot.hardware.vms.filter(vm => vm.numaNodes.some(item => item.nodeId === node.id)
          || vm.cpuPinning.some(cpuId => node.cpuIds.includes(cpuId))).map(vm => vm.resourceKey) })),
      unassignedDevices: [...snapshot.hardware.nics, ...snapshot.hardware.hbas, ...snapshot.hardware.disks, ...snapshot.hardware.gpus]
        .filter(item => item.numaNode == null).map(item => item.id), evidenceHash: snapshot.evidenceHash };
  }
  _vm(resourceKey, hostId = null) {
    resourceKey = text(resourceKey, 'resourceKey', 180); const snapshots = hostId ? [this._snapshot(hostId)] : this._latest();
    for (const snapshot of snapshots) {
      const vm = snapshot.hardware.vms.find(item => item.resourceKey === resourceKey);
      if (vm) return { snapshot, vm };
    }
    throw fail('VM placement evidence not found', 404, 'VM_PLACEMENT_NOT_FOUND');
  }
  analyzeNumaFit(resourceKey, hostId, actor) {
    this._admin(actor); const { snapshot, vm } = this._vm(resourceKey, hostId); const nodes = snapshot.hardware.numaNodes;
    const maxCpus = Math.max(0, ...nodes.map(node => node.cpuIds.length)); const maxMemory = Math.max(0, ...nodes.map(node => node.memoryBytes));
    const pinNodes = nodes.filter(node => vm.cpuPinning.some(cpu => node.cpuIds.includes(cpu))).map(node => node.id);
    const blockers = []; const warnings = [];
    if (vm.numaNodes.length <= 1 && vm.vcpus > maxCpus) blockers.push({ code: 'VCPU_EXCEEDS_NUMA_NODE', vcpus: vm.vcpus, maxNodeCpus: maxCpus });
    if (vm.numaNodes.length <= 1 && vm.memoryBytes > maxMemory) blockers.push({ code: 'MEMORY_EXCEEDS_NUMA_NODE', memoryBytes: vm.memoryBytes, maxNodeMemoryBytes: maxMemory });
    if (new Set(pinNodes).size > 1 && vm.numaNodes.length <= 1) warnings.push({ code: 'PINNING_SPANS_NUMA_NODES', nodeIds: pinNodes });
    for (const device of vm.deviceRefs.filter(item => item.numaNode != null)) if (vm.numaNodes.length && !vm.numaNodes.some(node => node.nodeId === device.numaNode)) {
      warnings.push({ code: 'DEVICE_REMOTE_NUMA', deviceId: device.id, deviceNode: device.numaNode });
    }
    const result = { resourceKey, hostId: snapshot.hostId, hostRef: snapshot.hostRef, state: blockers.length ? 'blocked' : warnings.length ? 'warning' : 'fit',
      blockers, warnings, topology: { vm, maxNodeCpus: maxCpus, maxNodeMemoryBytes: maxMemory }, providerMutationsStarted: 0 };
    return { ...result, evidenceHash: digest({ snapshot: snapshot.evidenceHash, result }) };
  }
  cpuPinning(clusterRef, actor) {
    this._admin(actor); const hosts = this._latest(text(clusterRef, 'clusterRef', 160));
    if (!hosts.length) throw fail('Cluster hardware evidence not found', 404, 'CLUSTER_NOT_FOUND');
    const rows = hosts.map(snapshot => {
      const allocations = new Map();
      for (const vm of snapshot.hardware.vms) for (const cpu of vm.cpuPinning) {
        const entries = allocations.get(cpu) || []; entries.push({ resourceKey: vm.resourceKey, dedicated: vm.dedicatedCpu }); allocations.set(cpu, entries);
      }
      const conflicts = [...allocations.entries()].filter(([, entries]) => entries.length > 1 && entries.some(item => item.dedicated))
        .map(([cpuId, entries]) => ({ cpuId, workloads: entries.map(item => item.resourceKey) }));
      const isolated = snapshot.hardware.cpu.isolatedCpuIds;
      const dedicatedCpuIds = [...allocations.entries()].filter(([, entries]) => entries.some(item => item.dedicated)).map(([cpu]) => cpu);
      const sharedCpuIds = [...allocations.entries()].filter(([, entries]) => entries.every(item => !item.dedicated)).map(([cpu]) => cpu);
      return { hostId: snapshot.hostId, hostRef: snapshot.hostRef, dedicatedCpuIds,
        sharedCpuIds, freeIsolatedCpuIds: isolated.filter(cpu => !allocations.has(cpu)),
        unpinnedWorkloads: snapshot.hardware.vms.filter(vm => !vm.cpuPinning.length).map(vm => vm.resourceKey), conflicts };
    });
    return { clusterRef, hosts: rows, conflictCount: rows.reduce((sum, host) => sum + host.conflicts.length, 0), providerMutationsStarted: 0 };
  }
  realtimeProfile(resourceKey, hostId, actor) {
    this._admin(actor); const { snapshot, vm } = this._vm(resourceKey, hostId); const isolated = new Set(snapshot.hardware.cpu.isolatedCpuIds);
    const checks = [
      { key: 'dedicated_cpu', state: vm.dedicatedCpu ? 'pass' : 'fail', evidence: { dedicatedCpu: vm.dedicatedCpu } },
      { key: 'complete_pinning', state: vm.cpuPinning.length >= vm.vcpus && vm.vcpus > 0 ? 'pass' : 'fail', evidence: { vcpus: vm.vcpus, pinned: vm.cpuPinning.length } },
      { key: 'isolated_cpu_pool', state: vm.cpuPinning.length && vm.cpuPinning.every(cpu => isolated.has(cpu)) ? 'pass' : 'fail', evidence: { isolated: [...isolated], pinned: vm.cpuPinning } },
      { key: 'hugepages', state: vm.hugepageSizeKb ? 'pass' : 'warn', evidence: { sizeKb: vm.hugepageSizeKb } },
      { key: 'latency_sensitivity', state: ['high', 'realtime'].includes(vm.latencySensitivity) ? 'pass' : 'warn', evidence: { value: vm.latencySensitivity } },
      { key: 'memory_reclaim', state: vm.balloonBytes === 0 && vm.swapBytes === 0 ? 'pass' : 'fail', evidence: { balloonBytes: vm.balloonBytes, swapBytes: vm.swapBytes } },
    ];
    const state = checks.some(item => item.state === 'fail') ? 'fail' : checks.some(item => item.state === 'warn') ? 'warn' : 'pass';
    return { resourceKey, hostId: snapshot.hostId, state, checks, providerMutationsStarted: 0,
      evidenceHash: digest({ snapshot: snapshot.evidenceHash, resourceKey, checks }) };
  }
  hugepageDashboard(hostId, actor) {
    this._admin(actor); const snapshot = this._snapshot(hostId); const rows = snapshot.hardware.numaNodes.flatMap(node => node.hugepages.map(page => {
      const allocated = Math.max(0, page.total - page.free - page.reserved); const freeBytes = page.free * page.sizeKb * 1024;
      return { nodeId: node.id, ...page, allocated, freeBytes, utilizationRatio: ratio(allocated + page.reserved, page.total),
        fragmentationRisk: page.total > 0 && page.free / page.total < 0.1 && page.free > 0 };
    }));
    const sizes = [...new Set(rows.map(row => row.sizeKb))].map(sizeKb => {
      const matching = rows.filter(row => row.sizeKb === sizeKb);
      return { sizeKb, total: matching.reduce((sum, row) => sum + row.total, 0), free: matching.reduce((sum, row) => sum + row.free, 0),
        reserved: matching.reduce((sum, row) => sum + row.reserved, 0), allocated: matching.reduce((sum, row) => sum + row.allocated, 0),
        fragmentedNodes: matching.filter(row => row.fragmentationRisk).map(row => row.nodeId) };
    });
    return { hostId: snapshot.hostId, hostRef: snapshot.hostRef, rows, sizes,
      workloads: snapshot.hardware.vms.filter(vm => vm.hugepageSizeKb).map(vm => ({ resourceKey: vm.resourceKey, sizeKb: vm.hugepageSizeKb, memoryBytes: vm.memoryBytes })),
      evidenceHash: snapshot.evidenceHash };
  }
  memoryDashboard(hostId, actor) {
    this._admin(actor); const snapshot = this._snapshot(hostId); const memory = snapshot.hardware.memory;
    const configuredBytes = snapshot.hardware.vms.reduce((sum, vm) => sum + vm.memoryBytes, 0);
    const activeVmBytes = snapshot.hardware.vms.reduce((sum, vm) => sum + vm.activeMemoryBytes, 0);
    const balloonVmBytes = snapshot.hardware.vms.reduce((sum, vm) => sum + vm.balloonBytes, 0);
    const swapVmBytes = snapshot.hardware.vms.reduce((sum, vm) => sum + vm.swapBytes, 0);
    const overcommitRatio = ratio(configuredBytes, Math.max(1, memory.totalBytes - memory.reservedBytes));
    const pressureRatio = ratio(memory.activeBytes + memory.reservedBytes, memory.totalBytes);
    const signals = [];
    if (overcommitRatio != null && overcommitRatio > 1.5) signals.push({ code: 'HIGH_OVERCOMMIT', severity: 'warning', ratio: overcommitRatio });
    if (pressureRatio != null && pressureRatio > 0.9) signals.push({ code: 'HOST_MEMORY_PRESSURE', severity: 'critical', ratio: pressureRatio });
    if (memory.swapUsedBytes > 0 || swapVmBytes > 0) signals.push({ code: 'SWAP_ACTIVE', severity: 'critical', bytes: memory.swapUsedBytes + swapVmBytes });
    if (memory.balloonBytes > 0 || balloonVmBytes > 0) signals.push({ code: 'BALLOON_RECLAIM', severity: 'warning', bytes: memory.balloonBytes + balloonVmBytes });
    return { hostId: snapshot.hostId, hostRef: snapshot.hostRef, memory, configuredBytes, activeVmBytes, balloonVmBytes,
      swapVmBytes, overcommitRatio, pressureRatio, state: signals.some(item => item.severity === 'critical') ? 'critical' : signals.length ? 'warning' : 'healthy',
      signals, workloads: snapshot.hardware.vms.map(vm => ({ resourceKey: vm.resourceKey, configuredBytes: vm.memoryBytes,
        activeBytes: vm.activeMemoryBytes, balloonBytes: vm.balloonBytes, swapBytes: vm.swapBytes })), evidenceHash: snapshot.evidenceHash };
  }
  overview(actor) {
    this._admin(actor); const snapshots = this._latest(); const policies = this._db().prepare('SELECT * FROM hardware_cpu_compatibility_policies ORDER BY cluster_ref').all().map(row => this._policyRow(row));
    return { capabilities: { hostHardwareInventory: true, hardwareCompatibilityTags: true, cpuFeatureBaseline: true,
      cpuCompatibilityPolicyEditor: true, numaTopology: true, vmNumaFit: true, cpuPinningInventory: true,
      realtimeWorkloadProfile: true, hugepageCapacity: true, memoryOvercommit: true },
    safety: { providerMutationsStarted: 0, applyEndpoint: false, rawBmcEndpointsStored: false, credentialsStored: false },
    snapshots: snapshots.map(item => ({ ...item, summary: { numaNodes: item.hardware.numaNodes.length, nics: item.hardware.nics.length,
      hbas: item.hardware.hbas.length, disks: item.hardware.disks.length, gpus: item.hardware.gpus.length, vms: item.hardware.vms.length } })), policies };
  }
}

const service = new HardwarePerformanceService();
module.exports = service;
module.exports.HardwarePerformanceService = HardwarePerformanceService;
module.exports.HardwarePerformanceError = HardwarePerformanceError;
module.exports._normalizeSnapshot = normalizeSnapshot;
