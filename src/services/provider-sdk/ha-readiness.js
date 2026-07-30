'use strict';

const config = require('../../config');
const { getDb } = require('../../db');
const { encrypt, decrypt, sha256 } = require('../../utils/crypto');
const log = require('../../utils/logger')('provider-ha-readiness');
const registrySingleton = require('./registry');
const identityStore = require('./identity-store');
const { fromHostRow: proxmoxFromHost } = require('../proxmox');
const { fromHostRow: vsphereFromHost } = require('../vsphere');
const xen = require('../xen');

const SCHEMA_VERSION = '1.0';
const BUCKET_MS = 5 * 60 * 1000;
const MAX_SNAPSHOT_BYTES = 512 * 1024;
const MAX_HOSTS = 128;
const MAX_WORKLOADS = 1000;
const PRIORITIES = Object.freeze(['highest', 'high', 'medium', 'low', 'lowest', 'disabled', 'unknown']);
const SIGNAL_STATES = new Set(['pass', 'warning', 'fail', 'unknown', 'not_applicable']);
const ESSENTIAL = new Set(['ha.enabled', 'coordination', 'heartbeat', 'fencing', 'storage.shared', 'capacity.failover']);
const WEIGHTS = Object.freeze({
  'ha.enabled': 15, coordination: 15, heartbeat: 10, fencing: 10,
  'storage.shared': 10, 'admission.control': 15, 'capacity.failover': 20,
  'workload.coverage': 5,
});
const inFlight = new Map();

class HaReadinessError extends Error {
  constructor(message, code = 'HA_READINESS_ERROR', status = 400) {
    super(message); this.name = 'HaReadinessError'; this.code = code; this.status = status;
  }
}

function _text(value, max = 240) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

function _number(value, options = {}) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || (options.min !== undefined && number < options.min)) return null;
  return options.integer ? Math.trunc(number) : number;
}

function _boolean(value) {
  if (value === true || value === false) return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return null;
}

function _priority(value, alwaysRun = null) {
  const normalized = String(value || '').trim().toLowerCase().replaceAll('_', '');
  if (['restart', 'best-effort', 'besteffort'].includes(normalized)) return 'medium';
  if (['highest', 'high', 'medium', 'low', 'lowest', 'disabled'].includes(normalized)) return normalized;
  if (alwaysRun === true) return 'medium';
  if (alwaysRun === false) return 'disabled';
  return 'unknown';
}

function _signal(key, state, reason, source = 'provider', confidence = 'high') {
  const safeState = SIGNAL_STATES.has(state) ? state : 'unknown';
  return { key, state: safeState, reason: _text(reason, 240), source, confidence };
}

function _optional(promise) {
  return Promise.resolve(promise).then(value => ({ available: true, value }))
    .catch(() => ({ available: false, value: null }));
}

function _retrySqliteBusy(write, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { return write(); }
    catch (err) {
      lastError = err;
      if (!/^SQLITE_BUSY(?:_|$)/.test(String(err?.code || '')) || attempt === attempts) throw err;
    }
  }
  throw lastError;
}

async function _collectProxmox(host) {
  const client = proxmoxFromHost(host);
  try {
    const [clusterStatus, nodes, vms, storages, haStatus, haResources] = await Promise.all([
      client.getClusterStatus(), client.listNodes(), client.listVMs(), client.listStorages(),
      _optional(client.getHaStatus()), _optional(client.getHaResources()),
    ]);
    const cluster = clusterStatus.find(row => row?.type === 'cluster') || {};
    const quorumRow = clusterStatus.find(row => row?.type === 'quorum') || {};
    const managers = (haStatus.value || []).filter(row => ['master', 'lrm'].includes(String(row?.type || '').toLowerCase()));
    const healthyManagers = managers.filter(row => /^(active|idle)$/i.test(String(row?.status || '')));
    const resources = haResources.value || [];
    const protectedIds = new Set(resources.map(row => String(row.sid || row.id || '')).filter(Boolean));
    const clusterName = cluster.name || cluster.id || `Proxmox endpoint ${host.id}`;
    const workloads = vms.filter(row => Number(row?.template) !== 1).slice(0, MAX_WORKLOADS).map(row => {
      const type = String(row.type || 'qemu') === 'lxc' ? 'ct' : 'vm';
      const resource = resources.find(item => String(item.sid || item.id) === `${type}:${row.vmid}`);
      return {
        nativeRef: `${row.type === 'lxc' ? 'lxc' : 'qemu'}/${row.vmid}`, uuid: row.uuid || null,
        name: row.name || `${type.toUpperCase()} ${row.vmid}`, hostRef: row.node || null,
        poweredOn: String(row.status || '').toLowerCase() === 'running', memoryBytes: _number(row.maxmem, { min: 0 }),
        protected: haResources.available ? protectedIds.has(`${type}:${row.vmid}`) : null,
        // Proxmox HA resources do not publish a portable restart-order field.
        priority: haResources.available ? (resource ? 'unknown' : 'disabled') : 'unknown',
      };
    });
    const sharedStorageIds = new Set(storages.filter(row => _boolean(row.shared) === true && row.status !== 'unavailable')
      .map(row => String(row.storage || row.id || '')).filter(Boolean));
    const quorate = _boolean(cluster.quorate ?? quorumRow.quorate);
    return {
      provider: { type: 'proxmox', variant: 'pve' }, limitations: [
        'The Proxmox API evidence does not expose a native guaranteed host-failure plan depth',
        'Fencing/watchdog configuration is not proven by the selected read-only endpoints',
      ], domains: [{
        nativeRef: `cluster:${clusterName}`, name: clusterName,
        configured: haStatus.available ? managers.length > 0 : null,
        quorum: quorate, heartbeat: managers.length ? healthyManagers.length === managers.length : null,
        fencing: null, admissionControl: null, sharedStorageCount: sharedStorageIds.size,
        configuredFailureTolerance: null, nativePlanDepth: null, overcommitted: null,
        hosts: nodes.slice(0, MAX_HOSTS).map(row => ({
          nativeRef: row.node || row.id, uuid: row.uuid || null, name: row.node || row.name,
          online: String(row.status || '').toLowerCase() === 'online', maintenance: false,
          memoryBytes: _number(row.maxmem, { min: 0 }),
          memoryFreeBytes: row.maxmem !== undefined && row.mem !== undefined
            ? Math.max(0, Number(row.maxmem) - Number(row.mem)) : null,
        })),
        workloads,
        warnings: [
          ...(!haStatus.available ? ['Proxmox HA manager status is unavailable to this endpoint credential'] : []),
          ...(!haResources.available ? ['Proxmox HA resource configuration is unavailable to this endpoint credential'] : []),
          ...(vms.length > MAX_WORKLOADS ? [`Workload evidence was capped at ${MAX_WORKLOADS} rows`] : []),
        ],
      }],
    };
  } finally { client._agent?.destroy?.(); }
}

function _vsphereVariant(info) {
  const product = `${info?.productFullName || ''} ${info?.name || ''}`.toLowerCase();
  return product.includes('vcenter') ? 'vcenter' : (product.includes('esxi') || product.includes('esx') ? 'esxi' : 'unknown');
}

async function _collectVSphere(host) {
  const client = vsphereFromHost(host);
  try {
    await client.login();
    const info = await client.retrieveServiceContent();
    const variant = _vsphereVariant(info);
    if (variant === 'esxi') return {
      provider: { type: 'vsphere', variant }, unsupported: true, domains: [],
      limitations: ['Standalone ESXi has no ClusterComputeResource HA management plane'],
    };
    const [clusters, hosts, vms, datastores] = await Promise.all([
      client.listClusters(), client.listHosts(), client.listVMs(), client.listDatastores(),
    ]);
    return {
      provider: { type: 'vsphere', variant },
      limitations: ['Memory simulation does not prove CPU, datastore, network or device compatibility'],
      domains: clusters.map(cluster => {
        const hostRefs = new Set(cluster.hostRefs || []);
        const datastoreRefs = new Set(cluster.datastoreRefs || []);
        const clusterHosts = hosts.filter(item => hostRefs.has(item.moref));
        const clusterVms = vms.filter(item => hostRefs.has(item.hostRef));
        const clusterStores = datastores.filter(item => datastoreRefs.has(item.moref));
        return {
          nativeRef: cluster.moref, name: cluster.name, configured: cluster.haEnabled,
          quorum: null, coordinationApplicable: false,
          heartbeat: cluster.hostMonitoring
            ? String(cluster.hostMonitoring).toLowerCase() === 'enabled' : null,
          fencing: cluster.isolationResponse ? String(cluster.isolationResponse).toLowerCase() !== 'none' : null,
          admissionControl: cluster.admissionControlEnabled,
          sharedStorageCount: clusterStores.filter(item => item.accessible !== false && item.maintenanceMode !== 'inMaintenance').length,
          configuredFailureTolerance: cluster.configuredFailoverLevel,
          nativePlanDepth: cluster.currentFailoverLevel,
          overcommitted: cluster.currentFailoverLevel !== null && cluster.configuredFailoverLevel !== null
            ? cluster.currentFailoverLevel < cluster.configuredFailoverLevel : null,
          nativeHealth: cluster.overallStatus,
          hosts: clusterHosts.slice(0, MAX_HOSTS).map(item => ({
            nativeRef: item.moref, uuid: item.hostUuid || null, name: item.name,
            online: String(item.connectionState || '').toLowerCase() === 'connected',
            maintenance: item.maintenanceMode === true, memoryBytes: item.memoryBytes,
            memoryFreeBytes: item.memoryFreeBytes,
          })),
          workloads: clusterVms.slice(0, MAX_WORKLOADS).map(item => {
            const override = cluster.vmPriorities?.[item.moref] || {};
            const priority = _priority(override.restartPriority || cluster.defaultRestartPriority);
            return {
              nativeRef: item.moref, uuid: item.uuid || null, name: item.name,
              hostRef: item.hostRef, poweredOn: String(item.powerState).toLowerCase() === 'poweredon',
              memoryBytes: item.memoryMB ? Number(item.memoryMB) * 1024 * 1024 : null,
              protected: cluster.haEnabled === true ? priority !== 'disabled' : false, priority,
            };
          }),
          warnings: clusterVms.length > MAX_WORKLOADS ? [`Workload evidence was capped at ${MAX_WORKLOADS} rows`] : [],
        };
      }),
    };
  } finally {
    try { await client.logout?.(); } catch { /* best effort */ }
    client._agent?.destroy?.();
  }
}

async function _collectXen(host) {
  const client = xen.clientForHost(host);
  const capabilities = client.capabilities();
  if (!capabilities.pools || client.provider === 'raw') return {
    provider: { type: 'xen', variant: client.provider || 'raw' }, unsupported: true, domains: [],
    limitations: ['Raw Xen exposes no managed pool HA contract'],
  };
  try {
    const [pools, hosts, vms, storages] = await Promise.all([
      client.listPools(), client.listHosts(), client.listVMs(), client.listStorages(),
    ]);
    return {
      provider: { type: 'xen', variant: client.provider || capabilities.provider || 'unknown' },
      limitations: ['Conservative simulation cannot prove all XAPI device and network placement constraints'],
      domains: pools.map(pool => {
        const clusterHosts = client.provider === 'xo'
          ? hosts.filter(item => !item.poolId || item.poolId === pool.id) : hosts;
        const clusterVms = client.provider === 'xo'
          ? vms.filter(item => !item.poolId || item.poolId === pool.id) : vms;
        const clusterStores = client.provider === 'xo'
          ? storages.filter(item => !item.poolId || item.poolId === pool.id) : storages;
        return {
          nativeRef: pool.ref || pool.id, uuid: pool.uuid || null, name: pool.name,
          configured: pool.haEnabled, quorum: clusterHosts.length >= 2
            ? clusterHosts.filter(item => String(item.powerState || '').toLowerCase() !== 'offline').length >= Math.floor(clusterHosts.length / 2) + 1 : null,
          heartbeat: pool.haEnabled === true ? (_number(pool.haStatefileCount, { min: 0 }) > 0 || pool.haClusterStack ? true : null) : null,
          fencing: pool.haEnabled === true && pool.haClusterStack ? true : null,
          fencingConfidence: pool.haEnabled === true && pool.haClusterStack ? 'medium' : 'low',
          admissionControl: pool.haAllowOvercommit === null || pool.haAllowOvercommit === undefined
            ? null : !pool.haAllowOvercommit,
          sharedStorageCount: clusterStores.filter(item => item.shared === true && item.attached !== false).length,
          configuredFailureTolerance: _number(pool.haHostFailuresToTolerate, { min: 0, integer: true }),
          nativePlanDepth: _number(pool.haPlanExistsFor, { min: 0, integer: true }),
          overcommitted: _boolean(pool.haOvercommitted), statefileCount: _number(pool.haStatefileCount, { min: 0, integer: true }),
          hosts: clusterHosts.slice(0, MAX_HOSTS).map(item => ({
            nativeRef: item.ref || item.id, uuid: item.uuid || null, name: item.name,
            online: !['offline', 'unknown'].includes(String(item.powerState || '').toLowerCase()),
            maintenance: item.enabled === false, memoryBytes: item.memoryBytes,
            memoryFreeBytes: item.memoryFreeBytes,
          })),
          workloads: clusterVms.slice(0, MAX_WORKLOADS).map(item => {
            const priority = item.haRestartPriority === ''
              ? 'disabled' : _priority(item.haRestartPriority, item.haAlwaysRun);
            return {
              nativeRef: item.ref || item.id, uuid: item.uuid || null, name: item.name,
              hostRef: item.hostRef || item.hostId || null,
              poweredOn: String(item.powerState || '').toLowerCase() === 'running',
              memoryBytes: item.memoryBytes, protected: pool.haEnabled === true ? priority !== 'disabled' : false, priority,
              startOrder: item.startOrder, startDelaySeconds: item.startDelaySeconds,
            };
          }),
          warnings: [
            ...(client.provider === 'xo' && pool.haPlanExistsFor === null ? ['Xen Orchestra did not expose native HA plan depth'] : []),
            ...(clusterVms.length > MAX_WORKLOADS ? [`Workload evidence was capped at ${MAX_WORKLOADS} rows`] : []),
          ],
        };
      }),
    };
  } finally { try { await client.close?.(); } catch { /* best effort */ } }
}

async function collectProvider(host) {
  if (host.daemon_type === 'proxmox') return _collectProxmox(host);
  if (host.daemon_type === 'vsphere') return _collectVSphere(host);
  if (host.daemon_type === 'xen') return _collectXen(host);
  throw new HaReadinessError('HA readiness is unavailable for this provider', 'HA_READINESS_UNSUPPORTED', 400);
}

function _canonical(database, host, kind, raw) {
  return identityStore.remember({
    hostId: Number(host.id), providerType: host.daemon_type, kind,
    nativeRef: String(raw.nativeRef), uuid: raw.uuid || null,
    stability: raw.uuid ? 'stable' : 'derived',
  }, database).id;
}

function _combinations(values, size, start = 0, prefix = [], output = []) {
  if (prefix.length === size) { output.push(prefix); return output; }
  for (let index = start; index <= values.length - (size - prefix.length); index++) {
    _combinations(values, size, index + 1, [...prefix, values[index]], output);
  }
  return output;
}

function _simulate(domain, hosts, workloads) {
  const online = hosts.filter(item => item.online && !item.maintenance);
  const maxLoss = Math.min(3, Math.max(0, online.length - 1));
  const scenarios = [];
  for (let failures = 1; failures <= maxLoss; failures++) {
    if (Number.isInteger(domain.nativePlanDepth)) {
      scenarios.push({ failures, state: domain.nativePlanDepth >= failures ? 'pass' : 'fail', source: 'provider_native',
        reason: domain.nativePlanDepth >= failures ? 'Provider reports a native failover plan at this depth' : 'Provider reports no native failover plan at this depth' });
      continue;
    }
    const completeHosts = online.every(item => Number.isFinite(item.memoryFreeBytes));
    const protectedRunning = workloads.filter(item => item.protected === true && item.poweredOn === true);
    const completeWorkloads = protectedRunning.every(item => item.hostId && Number.isFinite(item.memoryBytes));
    if (!completeHosts || !completeWorkloads || online.length > 32) {
      scenarios.push({ failures, state: 'unknown', source: 'estimated', reason: 'Placement or memory evidence is incomplete for a conservative simulation' });
      continue;
    }
    const combinations = _combinations(online, failures);
    let worst = null;
    for (const lost of combinations) {
      const lostIds = new Set(lost.map(item => item.id));
      const free = online.filter(item => !lostIds.has(item.id)).reduce((sum, item) => sum + item.memoryFreeBytes, 0);
      const demand = protectedRunning.filter(item => lostIds.has(item.hostId))
        .reduce((sum, item) => sum + item.memoryBytes, 0);
      const required = Math.ceil(demand * 1.1);
      const margin = free - required;
      if (!worst || margin < worst.margin) worst = { free, demand, required, margin };
    }
    scenarios.push({ failures, state: worst && worst.margin >= 0 ? 'pass' : 'fail', source: 'estimated',
      reason: worst && worst.margin >= 0 ? 'Every evaluated host-loss combination retains the estimated memory reserve'
        : 'At least one host-loss combination exceeds the estimated remaining memory reserve',
      remainingFreeMemoryBytes: worst?.free ?? null, requiredMemoryBytes: worst?.required ?? null,
      reservePercent: 10 });
  }
  return scenarios;
}

function _signals(domain, hosts, workloads, scenarios) {
  const configured = _boolean(domain.configured);
  const poweredOn = workloads.filter(item => item.poweredOn).length;
  const knownProtection = workloads.filter(item => item.poweredOn && item.protected !== null).length;
  const protectedCount = workloads.filter(item => item.poweredOn && item.protected === true).length;
  const coverage = poweredOn ? Math.round((protectedCount / poweredOn) * 100) : 100;
  const firstScenario = scenarios[0];
  return [
    _signal('ha.enabled', configured === true ? 'pass' : (configured === false ? 'fail' : 'unknown'), configured === true
      ? 'Provider reports HA enabled' : (configured === false ? 'Provider reports HA disabled' : 'HA enablement could not be proven')),
    _signal('coordination', domain.coordinationApplicable === false ? 'not_applicable'
      : (domain.quorum === true ? 'pass' : (domain.quorum === false ? 'fail' : 'unknown')),
    domain.coordinationApplicable === false ? 'This provider does not expose a portable quorum signal for the HA domain'
      : (domain.quorum === true ? 'Provider coordination/quorum is healthy'
        : (domain.quorum === false ? 'Provider coordination/quorum is not healthy' : 'Coordination evidence is unavailable'))),
    _signal('heartbeat', domain.heartbeat === true ? 'pass' : (domain.heartbeat === false ? 'fail' : 'unknown'), domain.heartbeat === true
      ? 'Host monitoring or heartbeat evidence is healthy' : (domain.heartbeat === false ? 'Host monitoring or heartbeat evidence is unhealthy' : 'Heartbeat evidence is unavailable')),
    _signal('fencing', domain.fencing === true ? 'pass' : (domain.fencing === false ? 'fail' : 'unknown'), domain.fencing === true
      ? 'Provider reports fencing or isolation protection' : (domain.fencing === false ? 'Fencing or isolation protection is disabled' : 'Fencing evidence is unavailable'),
    'provider', domain.fencingConfidence || (domain.fencing === null ? 'low' : 'high')),
    _signal('storage.shared', Number.isInteger(domain.sharedStorageCount)
      ? (domain.sharedStorageCount > 0 ? 'pass' : 'warning') : 'unknown', domain.sharedStorageCount > 0
      ? `${domain.sharedStorageCount} accessible shared/cluster datastore(s) observed` : 'No accessible shared/cluster storage evidence was observed'),
    _signal('admission.control', domain.admissionControl === true ? 'pass'
      : (domain.admissionControl === false ? 'warning' : 'not_applicable'), domain.admissionControl === true
      ? 'Admission control blocks changes that violate failover policy' : (domain.admissionControl === false
        ? 'Admission control does not guarantee restart capacity' : 'No portable admission-control switch is exposed'), 'provider', domain.admissionControl === null ? 'low' : 'high'),
    _signal('capacity.failover', firstScenario?.state || 'unknown', firstScenario?.reason || 'No host-loss scenario is available', firstScenario?.source || 'estimated', firstScenario?.source === 'provider_native' ? 'high' : 'medium'),
    _signal('workload.coverage', poweredOn === 0 ? 'pass' : (knownProtection < poweredOn ? 'unknown'
      : (coverage === 100 ? 'pass' : (coverage > 0 ? 'warning' : 'fail'))), poweredOn === 0
      ? 'No powered-on workloads require HA protection' : `${protectedCount} of ${poweredOn} powered-on workloads are reported protected`),
  ];
}

function _score(signals) {
  let earned = 0; let possible = 0;
  for (const signal of signals) {
    const weight = WEIGHTS[signal.key] || 0;
    if (!weight || signal.state === 'not_applicable') continue;
    possible += weight;
    if (signal.state === 'pass') earned += weight;
    else if (signal.state === 'warning') earned += weight / 2;
  }
  return possible ? Math.round((earned / possible) * 100) : null;
}

function _state(domain, signals, score, unsupported = false) {
  if (unsupported) return 'unsupported';
  if (domain.configured === false) return 'not_configured';
  if (signals.some(item => ESSENTIAL.has(item.key) && item.state === 'fail')) return 'blocked';
  if (domain.overcommitted === true || signals.some(item => item.state === 'fail' || item.state === 'warning')) return 'degraded';
  if (signals.some(item => ESSENTIAL.has(item.key) && item.state === 'unknown')) return 'unknown';
  return score !== null && score >= 80 ? 'ready' : 'degraded';
}

function _recoveryPlan(workloads) {
  const recoverable = workloads.filter(item => item.poweredOn && item.protected === true && item.priority !== 'disabled');
  if (!recoverable.length) return {
    state: 'not_applicable', mode: 'none', confidence: 'low', nodes: [], edges: [], waves: [],
    blockers: [], excludedWorkloadCount: workloads.length,
    estimatedCompletionSeconds: null, hasCompleteTimingEvidence: false,
  };
  const ids = new Set(recoverable.map(item => item.id));
  const blockers = [];
  const edges = [];
  for (const item of recoverable) {
    for (const dependencyId of item.dependencyIds || []) {
      if (!ids.has(dependencyId)) blockers.push(`Dependency evidence for ${item.displayName} points outside the recoverable workload set`);
      else if (dependencyId === item.id) blockers.push(`Recovery dependency for ${item.displayName} points to itself`);
      else edges.push({ from: dependencyId, to: item.id, kind: 'depends_on' });
    }
  }
  const uniqueBlockers = [...new Set(blockers)].slice(0, 32);
  const explicit = edges.length > 0;
  const hasStartOrder = recoverable.some(item => Number.isInteger(item.startOrder));
  let mode = explicit ? 'explicit_dependencies' : (hasStartOrder ? 'provider_start_order' : 'provider_priority_groups');
  let confidence = explicit ? 'high' : (hasStartOrder ? 'medium' : 'low');
  let waveItems = [];

  if (explicit) {
    const remaining = new Map(recoverable.map(item => [item.id,
      new Set(edges.filter(edge => edge.to === item.id).map(edge => edge.from))]));
    const emitted = new Set();
    while (emitted.size < recoverable.length) {
      const ready = recoverable.filter(item => !emitted.has(item.id)
        && [...(remaining.get(item.id) || [])].every(id => emitted.has(id)));
      if (!ready.length) {
        uniqueBlockers.push('Recovery dependency graph contains a cycle');
        break;
      }
      waveItems.push(ready);
      ready.forEach(item => emitted.add(item.id));
    }
  } else {
    const groups = new Map();
    for (const item of recoverable) {
      const key = hasStartOrder
        ? (Number.isInteger(item.startOrder) ? item.startOrder : Number.MAX_SAFE_INTEGER)
        : PRIORITIES.indexOf(item.priority);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    waveItems = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, items]) => items);
  }

  let nextStart = 0;
  let timingComplete = true;
  const waves = waveItems.map((items, index) => {
    const startOffsetSeconds = timingComplete ? nextStart : null;
    const readyDurations = items.map(item => item.estimatedReadySeconds);
    const readyKnown = readyDurations.every(Number.isFinite);
    const estimatedReadyAtSeconds = startOffsetSeconds !== null && readyKnown
      ? startOffsetSeconds + Math.max(...readyDurations, 0) : null;
    const delays = items.map(item => item.startDelaySeconds);
    const delayKnown = delays.every(Number.isFinite);
    if (explicit) {
      if (estimatedReadyAtSeconds !== null) nextStart = estimatedReadyAtSeconds;
      else timingComplete = false;
    } else if (timingComplete && delayKnown) nextStart += Math.max(...delays, 0);
    else timingComplete = false;
    return {
      id: `wave-${index + 1}`, index: index + 1,
      startOffsetSeconds, estimatedReadyAtSeconds,
      dependsOnWaveIds: index ? [`wave-${index}`] : [],
      items: items.map(item => item.id),
    };
  });
  const nodes = recoverable.map(item => ({
    id: item.id, displayName: item.displayName, priority: item.priority,
    startOrder: item.startOrder, startDelaySeconds: item.startDelaySeconds,
    estimatedReadySeconds: item.estimatedReadySeconds,
    dependencyIds: (item.dependencyIds || []).filter(id => ids.has(id)),
  }));
  const hasCompleteTimingEvidence = waves.length > 0 && waves.every(wave => wave.estimatedReadyAtSeconds !== null);
  const estimatedCompletionSeconds = hasCompleteTimingEvidence
    ? Math.max(...waves.map(wave => wave.estimatedReadyAtSeconds)) : null;
  if (!explicit && !hasStartOrder) uniqueBlockers.push('Only provider restart-priority groups are available; application dependencies are not proven');
  if (!hasCompleteTimingEvidence) uniqueBlockers.push('Complete workload readiness-duration evidence is unavailable');
  if (uniqueBlockers.some(item => item.includes('cycle') || item.includes('outside') || item.includes('itself'))) {
    mode = explicit ? mode : 'incomplete'; confidence = 'low';
  }
  return {
    state: uniqueBlockers.some(item => item.includes('cycle') || item.includes('outside') || item.includes('itself')) ? 'blocked' : 'advisory',
    mode, confidence, nodes, edges, waves, blockers: [...new Set(uniqueBlockers)].slice(0, 32),
    excludedWorkloadCount: workloads.length - recoverable.length,
    estimatedCompletionSeconds, hasCompleteTimingEvidence,
  };
}

function _applyRecoveryEvidence(database, workloads) {
  const byId = new Map(workloads.map(item => [item.id, {
    ...item, dependencyIds: [...new Set(item.dependencyIds || [])],
  }]));
  const hasTable = name => Boolean(database.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', name));
  if (hasTable('resource_relationship_graphs')) {
    const row = database.prepare('SELECT edges_json FROM resource_relationship_graphs ORDER BY observed_at DESC, id DESC LIMIT 1').get();
    if (row) {
      let edges = [];
      try { edges = JSON.parse(row.edges_json); } catch { edges = []; }
      for (const edge of Array.isArray(edges) ? edges.slice(0, 30000) : []) {
        const relationship = String(edge?.relationship || '').toLowerCase();
        let workloadId; let dependencyId;
        if (['depends_on', 'requires', 'starts_after'].includes(relationship)) {
          workloadId = String(edge.source || ''); dependencyId = String(edge.target || '');
        } else if (relationship === 'required_by') {
          workloadId = String(edge.target || ''); dependencyId = String(edge.source || '');
        } else continue;
        if (byId.has(workloadId) && byId.has(dependencyId)) byId.get(workloadId).dependencyIds.push(dependencyId);
      }
    }
  }
  if (hasTable('custom_metadata_values')) {
    const rows = database.prepare(`SELECT resource_key, schema_key, value_json FROM custom_metadata_values
      WHERE schema_key IN ('recovery.ready_seconds','recovery.start_order','recovery.start_delay_seconds')`).all();
    for (const row of rows) {
      const item = byId.get(String(row.resource_key));
      if (!item) continue;
      let value;
      try { value = JSON.parse(row.value_json); } catch { continue; }
      const number = _number(value, { min: 0, integer: true });
      if (number === null) continue;
      if (row.schema_key === 'recovery.ready_seconds') item.estimatedReadySeconds = number;
      else if (row.schema_key === 'recovery.start_order') item.startOrder = number;
      else item.startDelaySeconds = number;
    }
  }
  return workloads.map(item => ({ ...byId.get(item.id), dependencyIds: [...new Set(byId.get(item.id).dependencyIds)] }));
}

function _normalizeDomain(database, host, raw, unsupported = false) {
  const domainId = _canonical(database, host, 'cluster', raw);
  const hostIdByNative = new Map();
  const hosts = (raw.hosts || []).slice(0, MAX_HOSTS).map(item => {
    const id = _canonical(database, host, 'host', item);
    hostIdByNative.set(String(item.nativeRef), id);
    return { id, displayName: _text(item.name, 160) || id, online: item.online === true,
      maintenance: item.maintenance === true, memoryBytes: _number(item.memoryBytes, { min: 0 }),
      memoryFreeBytes: _number(item.memoryFreeBytes, { min: 0 }) };
  });
  const rawWorkloads = (raw.workloads || []).slice(0, MAX_WORKLOADS);
  const workloadIdByNative = new Map(rawWorkloads.map(item => [String(item.nativeRef),
    _canonical(database, host, 'virtualMachine', item)]));
  let workloads = rawWorkloads.map(item => ({
    id: workloadIdByNative.get(String(item.nativeRef)), displayName: _text(item.name, 160) || 'VM',
    hostId: item.hostRef ? hostIdByNative.get(String(item.hostRef)) || null : null,
    poweredOn: item.poweredOn === true, protected: item.protected === true ? true : (item.protected === false ? false : null),
    priority: _priority(item.priority), memoryBytes: _number(item.memoryBytes, { min: 0 }),
    startOrder: _number(item.startOrder, { min: 0, integer: true }),
    startDelaySeconds: _number(item.startDelaySeconds, { min: 0, integer: true }),
    estimatedReadySeconds: _number(item.estimatedReadySeconds, { min: 0, integer: true }),
    dependencyIds: (Array.isArray(item.dependencyRefs) ? item.dependencyRefs : []).slice(0, 64)
      .map(ref => workloadIdByNative.get(String(ref)) || `missing:${sha256(String(ref)).slice(0, 16)}`),
  })).sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority)
    || a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id));
  workloads = _applyRecoveryEvidence(database, workloads);
  const scenarios = unsupported ? [] : _simulate(raw, hosts, workloads);
  const signals = unsupported ? [] : _signals(raw, hosts, workloads, scenarios);
  const score = unsupported ? null : _score(signals);
  const state = _state(raw, signals, score, unsupported);
  const recoveryPlan = unsupported ? _recoveryPlan([]) : _recoveryPlan(workloads);
  const recoveryGroups = PRIORITIES.map(priority => ({
    priority, items: workloads.filter(item => item.priority === priority).map(item => ({
      id: item.id, displayName: item.displayName, poweredOn: item.poweredOn, protected: item.protected,
    })),
  })).filter(group => group.items.length);
  const poweredOnCount = workloads.filter(item => item.poweredOn).length;
  const protectedVmCount = workloads.filter(item => item.poweredOn && item.protected === true).length;
  return {
    id: domainId, displayName: _text(raw.name, 160) || domainId, state, score,
    configured: raw.configured === true ? true : (raw.configured === false ? false : null),
    hostCount: hosts.length, onlineHostCount: hosts.filter(item => item.online && !item.maintenance).length,
    poweredOnVmCount: poweredOnCount, protectedVmCount,
    protectionCoveragePercent: poweredOnCount ? Math.round((protectedVmCount / poweredOnCount) * 100) : 100,
    configuredFailureTolerance: _number(raw.configuredFailureTolerance, { min: 0, integer: true }),
    observedFailureTolerance: _number(raw.nativePlanDepth, { min: 0, integer: true }),
    overcommitted: raw.overcommitted === true ? true : (raw.overcommitted === false ? false : null),
    signals, scenarios, recoveryGroups, recoveryPlan,
    hosts, warnings: (raw.warnings || []).slice(0, 32).map(value => _text(value, 240)).filter(Boolean),
  };
}

function _overallState(domains, unsupported) {
  if (unsupported) return 'unsupported';
  if (!domains.length) return 'unknown';
  const order = ['blocked', 'degraded', 'unknown', 'not_configured', 'ready'];
  return order.find(state => domains.some(domain => domain.state === state)) || 'unknown';
}

function _snapshot(database, host, collected, capability) {
  const unsupported = collected.unsupported === true || capability?.state === 'unsupported';
  const domains = unsupported && !(collected.domains || []).length ? [{
    id: _canonical(database, host, 'cluster', { nativeRef: `endpoint:${host.id}:ha`, name: `${host.name} HA` }),
    displayName: `${_text(host.name, 140) || `Endpoint ${host.id}`} HA`, state: 'unsupported', score: null,
    configured: null, hostCount: 0, onlineHostCount: 0, poweredOnVmCount: 0, protectedVmCount: 0,
    protectionCoveragePercent: null, configuredFailureTolerance: null, observedFailureTolerance: null,
    overcommitted: null, signals: [], scenarios: [], recoveryGroups: [], recoveryPlan: _recoveryPlan([]), hosts: [], warnings: [],
  }] : (collected.domains || []).slice(0, 32).map(domain => _normalizeDomain(database, host, domain, false));
  const scores = domains.map(domain => domain.score).filter(Number.isFinite);
  const snapshot = {
    schemaVersion: SCHEMA_VERSION, observedAt: new Date().toISOString(),
    provider: { type: host.daemon_type, endpointId: Number(host.id), variant: _text(collected.provider?.variant, 80) },
    capability: {
      state: capability?.state || (unsupported ? 'unsupported' : 'unknown'),
      reason: _text(capability?.reason, 240), constraints: capability?.constraints || {},
    },
    state: _overallState(domains, unsupported), score: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
    domainCount: domains.length, domains,
    limitations: (collected.limitations || []).slice(0, 32).map(value => _text(value, 240)).filter(Boolean),
    methodology: { capacityReservePercent: 10, maxSimulatedHostFailures: 3, simulationsAreEstimatesUnlessSourceIsProviderNative: true },
  };
  snapshot.snapshotHash = sha256(JSON.stringify({ ...snapshot, observedAt: undefined, snapshotHash: undefined }));
  return snapshot;
}

function _persist(database, host, snapshot) {
  const json = JSON.stringify(snapshot);
  if (Buffer.byteLength(json) > MAX_SNAPSHOT_BYTES) {
    throw new HaReadinessError('HA readiness snapshot exceeds the safe size limit', 'HA_SNAPSHOT_TOO_LARGE', 502);
  }
  const bucket = new Date(Math.floor(Date.parse(snapshot.observedAt) / BUCKET_MS) * BUCKET_MS).toISOString();
  database.prepare(`INSERT INTO provider_ha_snapshots
    (host_id, provider_type, observed_at, observed_bucket, overall_state, score, snapshot_hash, snapshot_enc)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(host_id, observed_bucket) DO UPDATE SET
      provider_type=excluded.provider_type, observed_at=excluded.observed_at,
      overall_state=excluded.overall_state, score=excluded.score,
      snapshot_hash=excluded.snapshot_hash, snapshot_enc=excluded.snapshot_enc`)
    .run(Number(host.id), host.daemon_type, snapshot.observedAt, bucket, snapshot.state,
      snapshot.score, snapshot.snapshotHash, encrypt(json));
  const limit = config.providerHaReadiness.historyLimit;
  database.prepare(`DELETE FROM provider_ha_snapshots WHERE host_id = ? AND id NOT IN (
    SELECT id FROM provider_ha_snapshots WHERE host_id = ? ORDER BY observed_at DESC LIMIT ?
  )`).run(Number(host.id), Number(host.id), limit);
  return snapshot;
}

function _latestRow(database, hostId) {
  return database.prepare('SELECT * FROM provider_ha_snapshots WHERE host_id = ? ORDER BY observed_at DESC LIMIT 1').get(Number(hostId));
}

function _decode(row) {
  if (!row) return null;
  try { return JSON.parse(decrypt(row.snapshot_enc)); }
  catch { throw new HaReadinessError('Stored HA readiness evidence could not be read', 'HA_SNAPSHOT_UNREADABLE', 500); }
}

async function captureForHost(host, options = {}) {
  if (!host || !Number.isInteger(Number(host.id))) throw new HaReadinessError('Valid provider endpoint required', 'INVALID_OPERATION_HOST', 404);
  const enabled = options.enabled === undefined ? config.features.providerHaReadiness : options.enabled === true;
  if (!enabled) throw new HaReadinessError('HA readiness is disabled by release policy', 'HA_READINESS_DISABLED', 404);
  const database = options.database || getDb();
  const registry = options.registry || registrySingleton;
  const collector = options.collector || collectProvider;
  const key = Number(host.id);
  if (inFlight.has(key)) return inFlight.get(key);
  const promise = (async () => {
    let capabilities; let capability; let collected;
    try {
      capabilities = await registry.capabilitiesForHost(host);
      capability = capabilities.features?.['cluster.ha.read'] || { state: 'unknown', reason: 'No HA capability evidence' };
      collected = capability.state === 'unsupported'
        ? { provider: { type: host.daemon_type, variant: capabilities.provider?.variant }, unsupported: true, domains: [], limitations: [capability.reason] }
        : await collector(host);
    } catch (err) {
      if (err instanceof HaReadinessError) throw err;
      log.warn('Provider HA evidence read failed', {
        hostId: Number(host.id), provider: host.daemon_type,
        code: /^[A-Z][A-Z0-9_]{1,79}$/.test(String(err?.code || '')) ? err.code : 'HA_PROVIDER_READ_FAILED',
      });
      throw new HaReadinessError('Provider HA evidence could not be read', 'HA_PROVIDER_READ_FAILED', 502);
    }
    const write = database.transaction(() => _persist(database, host,
      _snapshot(database, host, collected, capability)));
    return _retrySqliteBusy(write);
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

async function getForHost(host, options = {}) {
  const enabled = options.enabled === undefined ? config.features.providerHaReadiness : options.enabled === true;
  if (!enabled) throw new HaReadinessError('HA readiness is disabled by release policy', 'HA_READINESS_DISABLED', 404);
  const database = options.database || getDb();
  const latest = _latestRow(database, host.id);
  const freshnessMs = options.freshnessMs ?? config.providerHaReadiness.freshnessMs;
  if (!options.refresh && latest && Date.now() - Date.parse(latest.observed_at) <= freshnessMs) {
    return { ..._decode(latest), cache: { hit: true, stale: false } };
  }
  try { return { ...(await captureForHost(host, options)), cache: { hit: false, stale: false } }; }
  catch (err) {
    if (!options.refresh && latest) return { ..._decode(latest), cache: { hit: true, stale: true, refreshError: 'Provider refresh failed' } };
    throw err;
  }
}

function historyForHost(hostId, options = {}) {
  const database = options.database || getDb();
  const limit = options.limit === undefined ? 48 : Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > config.providerHaReadiness.historyLimit) {
    throw new HaReadinessError(`History limit must be between 1 and ${config.providerHaReadiness.historyLimit}`, 'INVALID_HA_HISTORY_LIMIT');
  }
  return database.prepare(`SELECT id, observed_at, overall_state, score, snapshot_hash, snapshot_enc
    FROM provider_ha_snapshots WHERE host_id = ? ORDER BY observed_at DESC LIMIT ?`).all(Number(hostId), limit).map(row => {
    const snapshot = _decode(row);
    return {
      id: row.id, observedAt: row.observed_at, state: row.overall_state, score: row.score,
      snapshotHash: row.snapshot_hash, domainCount: snapshot.domainCount,
      domains: snapshot.domains.map(domain => ({
        id: domain.id, displayName: domain.displayName, state: domain.state, score: domain.score,
        hostCount: domain.hostCount, protectedVmCount: domain.protectedVmCount,
      })),
    };
  });
}

async function _mapLimit(values, limit, fn) {
  const output = new Array(values.length); let next = 0;
  async function worker() { while (next < values.length) { const index = next++; output[index] = await fn(values[index], index); } }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return output;
}

async function captureAll(options = {}) {
  if (!config.features.providerHaReadiness && options.enabled !== true) return { attempted: 0, captured: 0, failed: 0 };
  const database = options.database || getDb();
  const hosts = database.prepare(`SELECT * FROM docker_hosts
    WHERE is_active = 1 AND daemon_type IN ('proxmox','vsphere','xen') ORDER BY id`).all();
  const results = await _mapLimit(hosts, config.providerHaReadiness.endpointConcurrency, async host => {
    try { await captureForHost(host, { ...options, database }); return true; }
    catch (err) { log.warn('Scheduled HA readiness capture failed', { hostId: host.id, code: err.code || 'HA_CAPTURE_FAILED' }); return false; }
  });
  return { attempted: hosts.length, captured: results.filter(Boolean).length, failed: results.filter(value => !value).length };
}

module.exports = {
  SCHEMA_VERSION, HaReadinessError, collectProvider, captureForHost, getForHost, historyForHost, captureAll,
  _internals: { _text, _number, _boolean, _priority, _signal, _simulate, _signals, _score, _state, _recoveryPlan, _applyRecoveryEvidence, _snapshot, _persist, _combinations, _retrySqliteBusy },
};
