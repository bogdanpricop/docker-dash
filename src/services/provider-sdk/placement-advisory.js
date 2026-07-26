'use strict';

const config = require('../../config');
const { getDb } = require('../../db');
const { sha256 } = require('../../utils/crypto');
const registrySingleton = require('./registry');
const identityStore = require('./identity-store');
const migrationSingleton = require('./vm-migration-preflight');

const SCHEMA_VERSION = '1.0';
const MAX_HOSTS = 64;
const MAX_VMS = 500;
const MAX_RULES = 500;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const SAFE_VM_ID = /^ddr_vm_[a-f0-9]{26}$/;
const RULE_KINDS = new Set([
  'vm_vm_affinity', 'vm_vm_anti_affinity', 'vm_host_affinity',
  'vm_host_anti_affinity', 'home_host_preference',
]);
const WEIGHTS = Object.freeze({ memory: 30, cpu: 20, affinity: 20, compatibility: 15, ha: 10, balance: 5 });
const TOTAL_WEIGHT = Object.values(WEIGHTS).reduce((sum, value) => sum + value, 0);
const affinityCache = new Map();
const affinityInFlight = new Map();

class PlacementAdvisoryError extends Error {
  constructor(message, code = 'PLACEMENT_ADVISORY_ERROR', status = 400) {
    super(message); this.name = 'PlacementAdvisoryError'; this.code = code; this.status = status;
  }
}

function _enabled(options) {
  if (options.enabled === true) return true;
  if (!config.features.providerPlacementAdvisory) {
    throw new PlacementAdvisoryError('Placement advisory is disabled by release policy', 'PLACEMENT_ADVISORY_DISABLED', 404);
  }
  return true;
}

function _text(value, max = 240) {
  if (value === null || value === undefined || value === '') return null;
  return String(value)
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b(token|apiKey|secret|password)\s*[:=]\s*[^\s;,]+/gi, '$1=[redacted]')
    .replace(/(bearer\s+)[a-z0-9._~+\/-]+/gi, '$1[redacted]')
    .replace(/https?:\/\/[^\s]+/gi, '[redacted-url]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted-address]')
    .replace(/\bOpaqueRef:[A-Za-z0-9._:-]+\b/g, '[redacted-ref]')
    .replace(/\b(?:vm|host|domain|group|datastore)-\d+\b/gi, '[redacted-ref]')
    .replace(/[\r\n\t]+/g, ' ').slice(0, max);
}

function _clone(value) { return JSON.parse(JSON.stringify(value)); }
function _percent(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 100 ? Math.round(number * 100) / 100 : null;
}
function _bytes(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}
function _freshness(observedAt, now = Date.now(), freshMs = config.providerPlacementAdvisory.freshnessMs) {
  const time = Date.parse(observedAt || '');
  if (!Number.isFinite(time)) return { state: 'unknown', ageMs: null };
  const ageMs = Math.max(0, now - time);
  return { state: ageMs <= freshMs ? 'fresh' : (ageMs <= 5 * 60_000 ? 'stale' : 'expired'), ageMs };
}
function _assertSize(output) {
  if (Buffer.byteLength(JSON.stringify(output)) > MAX_RESPONSE_BYTES) {
    throw new PlacementAdvisoryError('Placement advisory exceeds the response size limit', 'PLACEMENT_RESPONSE_TOO_LARGE', 502);
  }
  return output;
}
function _capability(capabilities, key) {
  const evidence = capabilities?.features?.[key] || { state: 'unknown', reason: 'No provider evidence' };
  return { key, state: evidence.state || 'unknown', reason: _text(evidence.reason) };
}

function _aliases(resource, nativeIdentity) {
  const values = new Set([resource.id, resource.identity?.uuid, resource.displayName, nativeIdentity?.nativeRef]);
  for (const value of [...values]) {
    if (!value) continue;
    const text = String(value);
    const tail = /^(?:qemu|lxc)\/(\d+)$/.exec(text)?.[1];
    if (tail) values.add(tail);
    values.add(text.replace(/^(?:vm|ct|qemu|lxc|node):/, '').split(':')[0]);
  }
  return [...values].filter(Boolean).map(String);
}

function _resourceMap(resources, kind, host, database) {
  const output = new Map();
  for (const resource of resources) {
    const identity = identityStore.resolveCanonical(resource.id, { hostId: Number(host.id), kind }, database);
    for (const alias of _aliases(resource, identity)) if (!output.has(alias)) output.set(alias, resource.id);
  }
  return output;
}

function _mapRefs(refs, map, max = 500) {
  const ids = [];
  let unmapped = 0;
  for (const ref of (Array.isArray(refs) ? refs : []).slice(0, max)) {
    const text = String(ref || '');
    const id = map.get(text) || map.get(text.replace(/^(?:vm|ct|qemu|lxc|node):/, '').split(':')[0]);
    if (id) ids.push(id); else if (text) unmapped++;
  }
  return { ids: [...new Set(ids)].sort(), unmapped };
}

function _ruleKind(value) {
  const raw = String(value || '').toLowerCase().replace(/-/g, '_');
  if (RULE_KINDS.has(raw)) return raw;
  if (raw === 'vm_affinity') return 'vm_vm_affinity';
  if (raw === 'vm_anti_affinity') return 'vm_vm_anti_affinity';
  if (raw === 'vm_host_affinity') return 'vm_host_affinity';
  if (raw === 'home_host_preference') return 'home_host_preference';
  if (raw === 'vm_host_anti_affinity') return 'vm_host_anti_affinity';
  return null;
}

function _ruleCompliance(rule, vmById) {
  if (!rule.enabled) return { state: 'disabled', reason: 'Rule is disabled' };
  if (rule.unmappedMembers > 0 || !rule.virtualMachineIds.length) {
    return { state: 'unknown', reason: 'One or more native rule members could not be mapped' };
  }
  const placements = rule.virtualMachineIds.map(id => vmById.get(id)?.relationships?.host || null);
  if (placements.some(value => !value)) return { state: 'unknown', reason: 'Current placement is unavailable for one or more VM members' };
  if (['vm_host_affinity', 'home_host_preference'].includes(rule.kind)) {
    if (!rule.hostIds.length) return { state: 'unknown', reason: 'The allowed host set could not be mapped' };
    return placements.every(hostId => rule.hostIds.includes(hostId))
      ? { state: 'compliant', reason: 'All mapped VM members are on preferred hosts' }
      : { state: 'violated', reason: 'At least one mapped VM member is outside the preferred host set' };
  }
  if (rule.kind === 'vm_host_anti_affinity') {
    if (!rule.hostIds.length) return { state: 'unknown', reason: 'The denied host set could not be mapped' };
    return placements.every(hostId => !rule.hostIds.includes(hostId))
      ? { state: 'compliant', reason: 'No mapped VM member is on a denied host' }
      : { state: 'violated', reason: 'At least one mapped VM member is on a denied host' };
  }
  const distinct = new Set(placements);
  if (rule.kind === 'vm_vm_affinity') return distinct.size <= 1
    ? { state: 'compliant', reason: 'Mapped VM members are colocated' }
    : { state: 'violated', reason: 'Mapped VM members are separated' };
  return distinct.size === placements.length
    ? { state: 'compliant', reason: 'Mapped VM members are separated' }
    : { state: 'violated', reason: 'At least two mapped VM members are colocated' };
}

async function _collectAffinity(host, options) {
  const registry = options.registry || registrySingleton;
  const database = options.database || getDb();
  const capabilities = await registry.capabilitiesForHost(host);
  const evidence = _capability(capabilities, 'placement.affinity.read');
  let raw = { rules: [], nativeRecommendations: [], limitations: [] };
  let vms = [];
  let hosts = [];
  if (['supported', 'conditional'].includes(evidence.state)) {
    const [vmInventory, hostInventory, providerPolicy] = await Promise.all([
      registry.resourcesForHost(host, 'virtual-machines', { limit: MAX_VMS, database }),
      registry.resourcesForHost(host, 'hosts', { limit: MAX_HOSTS, database }),
      registry.placementInventoryForHost(host, { capabilities, database }),
    ]);
    vms = vmInventory.items; hosts = hostInventory.items; raw = providerPolicy;
  } else {
    raw.limitations = [evidence.reason || 'Affinity inventory is unavailable'];
  }
  const vmMap = _resourceMap(vms, 'virtualMachine', host, database);
  const hostMap = _resourceMap(hosts, 'host', host, database);
  const vmById = new Map(vms.map(vm => [vm.id, vm]));
  const rules = [];
  const unsupportedKinds = new Set();
  for (const [index, item] of raw.rules.slice(0, MAX_RULES).entries()) {
    const mandatory = item.mandatory === true;
    const kind = _ruleKind(item.kind);
    if (!kind) { unsupportedKinds.add(_text(item.kind, 80) || 'unknown'); continue; }
    const mappedVms = _mapRefs(item.vmRefs, vmMap);
    const mappedHosts = _mapRefs(item.hostRefs, hostMap);
    const rule = {
      id: `ddp_rule_${sha256(`${host.id}|${item.nativeId || index}|${kind}`).slice(0, 26)}`,
      name: _text(item.name, 160) || `Placement rule ${index + 1}`,
      kind, enabled: item.enabled !== false, mandatory,
      virtualMachineIds: mappedVms.ids, hostIds: mappedHosts.ids,
      unmappedMembers: mappedVms.unmapped + mappedHosts.unmapped,
      source: _text(item.source, 80) || 'provider_native',
    };
    rule.currentPlacements = Object.fromEntries(rule.virtualMachineIds.map(id => [id, vmById.get(id)?.relationships?.host || null]));
    rule.runningVirtualMachineIds = rule.virtualMachineIds
      .filter(id => vmById.get(id)?.status?.powerState === 'running');
    rule.compliance = _ruleCompliance(rule, vmById);
    rules.push(rule);
  }
  const recommendations = (raw.nativeRecommendations || []).slice(0, 500).map((item, index) => {
    const mappedVms = _mapRefs(item.vmRefs, vmMap);
    const mappedHosts = _mapRefs(item.hostRefs, hostMap);
    return {
      id: `ddp_native_${sha256(`${host.id}|${item.nativeId || index}`).slice(0, 26)}`,
      reason: _text(item.reason, 240) || 'Provider-native placement recommendation',
      rating: Number.isFinite(Number(item.rating)) ? Number(item.rating) : null,
      createdAt: Number.isNaN(Date.parse(item.createdAt || '')) ? null : new Date(item.createdAt).toISOString(),
      virtualMachineIds: mappedVms.ids, hostIds: mappedHosts.ids,
      evidenceState: mappedVms.unmapped + mappedHosts.unmapped ? 'partial' : 'mapped',
      source: _text(item.source, 80) || 'provider_native',
    };
  });
  const observedAt = new Date().toISOString();
  return _assertSize({
    schemaVersion: SCHEMA_VERSION, observedAt, freshness: _freshness(observedAt),
    provider: { type: String(host.daemon_type), endpointId: Number(host.id), endpointName: _text(host.name, 160) },
    capability: evidence,
    scope: { maxRules: MAX_RULES, maxVirtualMachines: MAX_VMS, maxHosts: MAX_HOSTS, readOnly: true },
    rules, nativeRecommendations: recommendations,
    limitations: [...new Set([...(raw.limitations || []).map(item => _text(item, 240)).filter(Boolean),
      ...[...unsupportedKinds].map(kind => `Unsupported provider rule kind was ignored: ${kind}`)])].slice(0, 64),
  });
}

async function affinityForHost(host, options = {}) {
  _enabled(options);
  if (!host || !Number.isInteger(Number(host.id))) throw new PlacementAdvisoryError('Provider endpoint was not found', 'PROVIDER_NOT_FOUND', 404);
  const hostId = Number(host.id);
  const now = Date.now();
  const cached = affinityCache.get(hostId);
  if (!options.refresh && cached?.expiresAt > now) return _clone(cached.value);
  if (!options.refresh && affinityInFlight.has(hostId)) return _clone(await affinityInFlight.get(hostId));
  const promise = _collectAffinity(host, options);
  affinityInFlight.set(hostId, promise);
  try {
    const value = await promise;
    affinityCache.set(hostId, { value, expiresAt: now + (options.freshnessMs || config.providerPlacementAdvisory.freshnessMs) });
    return _clone(value);
  } finally { affinityInFlight.delete(hostId); }
}

function _policyForTarget(vmId, targetId, rules) {
  const blockers = [];
  const warnings = [];
  const findings = [];
  for (const rule of rules.filter(item => item.enabled && item.virtualMachineIds.includes(vmId))) {
    const peerIds = Array.isArray(rule.runningVirtualMachineIds)
      ? rule.runningVirtualMachineIds : rule.virtualMachineIds;
    const otherPlacements = peerIds.filter(id => id !== vmId)
      .map(id => rule.currentPlacements?.[id]).filter(Boolean);
    let state = 'compliant';
    let reason = 'Target satisfies the placement rule';
    if (rule.unmappedMembers > 0) { state = 'unknown'; reason = 'Rule membership is only partially mapped'; }
    else if (['vm_host_affinity', 'home_host_preference'].includes(rule.kind) && !rule.hostIds.includes(targetId)) {
      state = 'violated'; reason = 'Target is outside the preferred host set';
    } else if (rule.kind === 'vm_host_anti_affinity' && rule.hostIds.includes(targetId)) {
      state = 'violated'; reason = 'Target is inside the denied host set';
    } else if (rule.kind === 'vm_vm_affinity' && otherPlacements.length
      && otherPlacements.some(hostId => hostId !== targetId)) {
      state = 'violated'; reason = 'Target would separate affinity-group members';
    } else if (rule.kind === 'vm_vm_anti_affinity' && otherPlacements.includes(targetId)) {
      state = 'violated'; reason = 'Target would colocate anti-affinity-group members';
    } else if (['vm_vm_affinity', 'vm_vm_anti_affinity'].includes(rule.kind)
      && peerIds.filter(id => id !== vmId).length > 0
      && otherPlacements.length < peerIds.filter(id => id !== vmId).length) {
      state = 'unknown'; reason = 'Placement of one or more peer VMs is unknown';
    }
    findings.push({ ruleId: rule.id, kind: rule.kind, mandatory: rule.mandatory, state, reason });
    if (state !== 'compliant') {
      const finding = { type: state === 'unknown' ? 'PLACEMENT_POLICY_UNKNOWN' : 'PLACEMENT_POLICY_VIOLATION', reason, source: 'affinity', ruleId: rule.id };
      if (rule.mandatory) blockers.push(finding); else warnings.push(finding);
    }
  }
  const applicable = findings.length > 0;
  const penalty = findings.reduce((sum, item) => sum + (item.state === 'violated' ? 35 : item.state === 'unknown' ? 15 : 0), 0);
  return { applicable, score: applicable ? Math.max(0, 100 - penalty) : null, blockers, warnings, findings };
}

function _compatibilityScore(candidate) {
  const checks = Array.isArray(candidate.checks) ? candidate.checks : [];
  if (!checks.length && !(candidate.readyModes || []).length && !(candidate.unknownModes || []).length) return null;
  const values = checks.map(check => ({ pass: 100, warning: 60, unknown: 40, fail: 0 }[check.state] ?? 40));
  if ((candidate.readyModes || []).length) values.push(100);
  else if ((candidate.unknownModes || []).length) values.push(40);
  else values.push(0);
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function _telemetry(raw, now = Date.now()) {
  return {
    observedAt: raw?.observedAt || null,
    freshness: _freshness(raw?.observedAt, now),
    cpu: { value: _percent(raw?.cpuUtilizationPercent), unit: 'percent', provenance: 'provider_inventory' },
    memory: {
      totalBytes: _bytes(raw?.memoryBytes), freeBytes: _bytes(raw?.memoryFreeBytes),
      utilizationPercent: _percent(raw?.memoryUtilizationPercent), unit: 'bytes', provenance: 'provider_inventory',
    },
  };
}

function _scoreCandidate(candidate, preflight, affinity, haSnapshot, now) {
  const policy = _policyForTarget(preflight.vm.id, candidate.target.id, affinity.rules);
  const modeBlockers = (candidate.readyModes || []).length ? []
    : Object.values(candidate.modes || {}).flatMap(mode => mode.blockers || []);
  const blockers = [...modeBlockers, ...policy.blockers]
    .filter((item, index, all) => all.findIndex(other => `${other.type}|${other.reason}` === `${item.type}|${item.reason}`) === index).slice(0, 64);
  const warnings = [
    ...Object.values(candidate.modes || {}).flatMap(mode => mode.warnings || []), ...policy.warnings,
  ].filter((item, index, all) => all.findIndex(other => `${other.type}|${other.reason}` === `${item.type}|${item.reason}`) === index).slice(0, 64);
  const telemetry = _telemetry(candidate.target.telemetry, now);
  const vmMemory = _bytes(preflight.vm.memoryBytes);
  const total = telemetry.memory.totalBytes;
  const free = telemetry.memory.freeBytes;
  const reserve = vmMemory === null ? null : Math.ceil(vmMemory * 1.1);
  const projectedMemory = total && free !== null && reserve !== null
    ? _percent((total - free + reserve) / total * 100) : null;
  const memoryScore = projectedMemory === null ? null : Math.max(0, Math.round(100 - projectedMemory));
  const cpuScore = telemetry.cpu.value === null ? null : Math.max(0, Math.round(100 - telemetry.cpu.value));
  const compatibilityScore = _compatibilityScore(candidate);
  const haScore = Number.isFinite(Number(haSnapshot?.score)) ? Math.max(0, Math.min(100, Number(haSnapshot.score))) : null;
  const source = preflight.candidates.find(item => item.target.id === preflight.sourceTargetId);
  const sourceTelemetry = _telemetry(source?.target?.telemetry, now);
  const sourcePressure = Math.max(...[sourceTelemetry.cpu.value, sourceTelemetry.memory.utilizationPercent].filter(Number.isFinite), -1);
  const targetPressure = Math.max(...[telemetry.cpu.value, projectedMemory].filter(Number.isFinite), -1);
  const balanceScore = sourcePressure >= 0 && targetPressure >= 0
    ? Math.max(0, Math.min(100, Math.round(50 + (sourcePressure - targetPressure) / 2))) : null;
  const dimensions = {
    memory: { score: memoryScore, weight: WEIGHTS.memory, projectedUtilizationPercent: projectedMemory, reserveBytes: reserve },
    cpu: { score: cpuScore, weight: WEIGHTS.cpu, projection: 'current-target-utilization-only' },
    affinity: { score: policy.applicable ? policy.score : (affinity.capability.state === 'supported' || affinity.capability.state === 'conditional' ? 100 : null), weight: WEIGHTS.affinity, findings: policy.findings },
    compatibility: { score: compatibilityScore, weight: WEIGHTS.compatibility },
    ha: { score: haScore, weight: WEIGHTS.ha, scope: 'endpoint' },
    balance: { score: balanceScore, weight: WEIGHTS.balance, sourcePressurePercent: sourcePressure >= 0 ? sourcePressure : null, targetPressurePercent: targetPressure >= 0 ? targetPressure : null },
  };
  let applicableWeight = 0;
  let weighted = 0;
  for (const dimension of Object.values(dimensions)) if (dimension.score !== null) {
    applicableWeight += dimension.weight; weighted += dimension.score * dimension.weight;
  }
  const coverage = Math.round(applicableWeight / TOTAL_WEIGHT * 100);
  const uncapped = applicableWeight ? Math.round(weighted / applicableWeight) : 0;
  const cap = 50 + coverage / 2;
  const eligible = candidate.eligible === true && blockers.length === 0;
  const nativeEvidence = affinity.nativeRecommendations.filter(item =>
    item.virtualMachineIds.includes(preflight.vm.id) && item.hostIds.includes(candidate.target.id));
  return {
    target: { ...candidate.target, telemetry },
    eligible, score: eligible ? Math.round(Math.min(uncapped, cap)) : 0,
    evidenceCoveragePercent: coverage,
    confidence: coverage >= 80 ? 'high' : coverage >= 50 ? 'medium' : 'low',
    readyModes: candidate.readyModes || [], unknownModes: candidate.unknownModes || [], modes: candidate.modes || {},
    dimensions, blockers, warnings, checks: candidate.checks || [], nativeEvidence,
  };
}

async function recommendForVm(host, vmId, options = {}) {
  _enabled(options);
  if (!host || !Number.isInteger(Number(host.id)) || !SAFE_VM_ID.test(String(vmId || ''))) {
    throw new PlacementAdvisoryError('Virtual machine was not found', 'PROVIDER_VM_NOT_FOUND', 404);
  }
  const migration = options.migration || migrationSingleton;
  const affinityPromise = options.affinity ? Promise.resolve(options.affinity) : affinityForHost(host, options);
  const [preflight, affinity] = await Promise.all([
    migration.preflightForHost(host, vmId, options), affinityPromise,
  ]);
  let haSnapshot = options.haSnapshot || null;
  if (!haSnapshot && (config.features.providerHaReadiness || options.readHa === true)) {
    try { haSnapshot = await (options.haReadiness || require('./ha-readiness')).getForHost(host); }
    catch { haSnapshot = null; }
  }
  const now = Date.now();
  const candidates = preflight.candidates.map(candidate => _scoreCandidate(candidate, preflight, affinity, haSnapshot, now))
    .sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score
      || String(a.target.displayName).localeCompare(String(b.target.displayName)) || a.target.id.localeCompare(b.target.id));
  const semantic = {
    vmId: preflight.vm.id, sourceHostId: preflight.sourceTargetId,
    candidates: candidates.map(item => ({ targetId: item.target.id, eligible: item.eligible, score: item.score,
      readyModes: item.readyModes, blockers: item.blockers.map(blocker => [blocker.type, blocker.ruleId || null]) })),
  };
  const output = {
    schemaVersion: SCHEMA_VERSION, generatedAt: new Date(now).toISOString(),
    provider: preflight.provider,
    vm: { ...preflight.vm, sourceHostId: preflight.sourceTargetId },
    scope: { sameEndpointOnly: true, readOnly: true, executionEnabled: false, maxTargets: MAX_HOSTS },
    capability: _capability(await (options.registry || registrySingleton).capabilitiesForHost(host), 'placement.recommend'),
    candidates, assumptions: [
      'Configured VM memory plus a 10% reserve is used as a conservative target estimate',
      'CPU demand is not projected; only current target CPU utilization is scored',
      'A recommendation is evidence, not authorization to migrate',
    ],
    limitations: affinity.limitations,
  };
  output.planHash = sha256(JSON.stringify(semantic));
  return _assertSize(output);
}

async function _mapLimit(items, limit, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const index = cursor++; output[index] = await worker(items[index], index); }
  }));
  return output;
}

function _knownPressure(host) {
  const memory = _percent(host.status?.memoryUtilizationPercent
    ?? (host.spec?.memoryBytes && host.status?.memoryFreeBytes !== null
      ? (host.spec.memoryBytes - host.status.memoryFreeBytes) / host.spec.memoryBytes * 100 : null));
  const cpu = _percent(host.status?.cpuUtilizationPercent);
  const values = [memory, cpu].filter(Number.isFinite);
  return { memory, cpu, pressure: values.length ? Math.max(...values) : null };
}

async function rebalancePlanForHost(host, input = {}, options = {}) {
  _enabled(options);
  const sourceThreshold = input.sourceThresholdPercent === undefined ? 85 : Number(input.sourceThresholdPercent);
  const targetThreshold = input.targetThresholdPercent === undefined ? 75 : Number(input.targetThresholdPercent);
  const maxMoves = input.maxMoves === undefined ? config.providerPlacementAdvisory.maxRebalanceVms : Number(input.maxMoves);
  if (!Number.isFinite(sourceThreshold) || sourceThreshold < 70 || sourceThreshold > 95
    || !Number.isFinite(targetThreshold) || targetThreshold < 50 || targetThreshold >= sourceThreshold
    || !Number.isInteger(maxMoves) || maxMoves < 1 || maxMoves > config.providerPlacementAdvisory.maxRebalanceVms) {
    throw new PlacementAdvisoryError('Rebalance thresholds or maximum moves are invalid', 'INVALID_REBALANCE_OPTIONS', 400);
  }
  const registry = options.registry || registrySingleton;
  const database = options.database || getDb();
  const [hostInventory, vmInventory, affinity] = await Promise.all([
    registry.resourcesForHost(host, 'hosts', { limit: MAX_HOSTS, database }),
    registry.resourcesForHost(host, 'virtual-machines', { limit: MAX_VMS, database }),
    options.affinity ? Promise.resolve(options.affinity) : affinityForHost(host, options),
  ]);
  const hosts = hostInventory.items;
  const hostById = new Map(hosts.map(item => [item.id, item]));
  const pressureByHost = new Map(hosts.map(item => [item.id, _knownPressure(item)]));
  const sources = hosts.filter(item => pressureByHost.get(item.id).pressure !== null
    && pressureByHost.get(item.id).pressure >= sourceThreshold);
  const candidates = vmInventory.items.filter(vm => vm.status?.powerState === 'running'
    && sources.some(source => source.id === vm.relationships?.host))
    .sort((a, b) => Number(b.spec?.memoryBytes || 0) - Number(a.spec?.memoryBytes || 0)
      || a.id.localeCompare(b.id)).slice(0, config.providerPlacementAdvisory.maxRebalanceVms);
  const recommendations = await _mapLimit(candidates, options.endpointConcurrency || config.providerPlacementAdvisory.endpointConcurrency,
    async vm => {
      try { return { vm, recommendation: await recommendForVm(host, vm.id, { ...options, affinity }) }; }
      catch (err) { return { vm, error: err }; }
    });
  const reservations = new Map();
  const sourceReleased = new Map();
  const moves = [];
  const skipped = [];
  for (const item of recommendations) {
    if (moves.length >= maxMoves) break;
    const vm = item.vm;
    const sourceId = vm.relationships?.host;
    const source = hostById.get(sourceId);
    const sourcePressure = pressureByHost.get(sourceId);
    if (!source || !sourcePressure) { skipped.push({ vmId: vm.id, reason: 'Source host placement is unknown' }); continue; }
    if (sourcePressure.memory === null && sourcePressure.cpu !== null) {
      skipped.push({ vmId: vm.id, reason: 'CPU-only pressure cannot be projected without per-VM demand evidence' }); continue;
    }
    const released = sourceReleased.get(sourceId) || 0;
    const total = _bytes(source.spec?.memoryBytes);
    const free = _bytes(source.status?.memoryFreeBytes);
    const projectedSource = total && free !== null ? (total - free - released) / total * 100 : sourcePressure.memory;
    if (projectedSource !== null && projectedSource < targetThreshold) {
      skipped.push({ vmId: vm.id, reason: 'Source host is already below the target pressure after planned moves' }); continue;
    }
    if (item.error) { skipped.push({ vmId: vm.id, reason: 'Placement recommendation could not be completed' }); continue; }
    const target = item.recommendation.candidates.find(candidate => {
      if (!candidate.eligible || candidate.target.id === sourceId) return false;
      const targetTotal = candidate.target.telemetry?.memory?.totalBytes;
      const targetFree = candidate.target.telemetry?.memory?.freeBytes;
      const reserve = candidate.dimensions?.memory?.reserveBytes;
      if (!targetTotal || targetFree === null || reserve === null) return false;
      const reserved = reservations.get(candidate.target.id) || 0;
      return (targetTotal - targetFree + reserve + reserved) / targetTotal * 100 < targetThreshold;
    });
    if (!target) { skipped.push({ vmId: vm.id, reason: 'No eligible target remains below the target pressure ceiling' }); continue; }
    const mode = target.readyModes.includes('live') ? 'live'
      : target.readyModes.includes('cold') ? 'cold' : target.readyModes[0];
    const reserve = target.dimensions.memory.reserveBytes;
    const alreadyReserved = reservations.get(target.target.id) || 0;
    reservations.set(target.target.id, alreadyReserved + reserve);
    sourceReleased.set(sourceId, released + Number(vm.spec?.memoryBytes || 0));
    moves.push({
      vm: { id: vm.id, displayName: vm.displayName, memoryBytes: vm.spec?.memoryBytes || null },
      sourceHostId: sourceId, targetHostId: target.target.id, mode,
      score: target.score, confidence: target.confidence,
      estimatedDuration: target.modes?.[mode]?.estimate?.durationSeconds || null,
      estimatedDowntime: target.modes?.[mode]?.estimate?.downtimeSeconds || null,
      projectedTargetMemoryUtilizationPercent: _percent((target.target.telemetry.memory.totalBytes
        - target.target.telemetry.memory.freeBytes + reserve + alreadyReserved)
        / target.target.telemetry.memory.totalBytes * 100),
      policyEvidence: target.dimensions.affinity.findings,
      recommendationPlanHash: item.recommendation.planHash,
    });
  }
  const generatedAt = new Date();
  const semantic = {
    endpointId: Number(host.id), sourceThreshold, targetThreshold,
    moves: moves.map(move => ({ vmId: move.vm.id, sourceHostId: move.sourceHostId, targetHostId: move.targetHostId,
      mode: move.mode, score: move.score, projectedTargetMemoryUtilizationPercent: move.projectedTargetMemoryUtilizationPercent,
      policyEvidence: move.policyEvidence })),
  };
  const output = {
    schemaVersion: SCHEMA_VERSION, generatedAt: generatedAt.toISOString(),
    expiresAt: new Date(generatedAt.getTime() + config.providerPlacementAdvisory.planTtlMs).toISOString(),
    provider: { type: String(host.daemon_type), endpointId: Number(host.id), endpointName: _text(host.name, 160) },
    capability: _capability(await registry.capabilitiesForHost(host), 'placement.rebalance.plan'),
    scope: { readOnly: true, executable: false, maxHosts: MAX_HOSTS, maxVirtualMachines: MAX_VMS, maxMoves },
    thresholds: { sourcePercent: sourceThreshold, targetPercent: targetThreshold },
    sources: sources.map(source => {
      const before = pressureByHost.get(source.id);
      const releasedMemoryBytes = sourceReleased.get(source.id) || 0;
      const total = _bytes(source.spec?.memoryBytes); const free = _bytes(source.status?.memoryFreeBytes);
      const memory = total && free !== null ? _percent((total - free - releasedMemoryBytes) / total * 100) : before.memory;
      const known = [memory, before.cpu].filter(Number.isFinite);
      return { hostId: source.id, before, releasedMemoryBytes,
        after: { memory, cpu: before.cpu, pressure: known.length ? Math.max(...known) : null } };
    }),
    moves, skipped: skipped.slice(0, MAX_VMS),
    assumptions: [
      'The plan reserves configured VM memory plus 10% on each selected target',
      'CPU demand is not projected, so CPU-only overload does not generate a move',
      'The plan is advisory and must be recomputed before any future apply workflow',
    ],
  };
  output.planHash = sha256(JSON.stringify(semantic));
  return _assertSize(output);
}

function clearCache() { affinityCache.clear(); affinityInFlight.clear(); }

module.exports = {
  SCHEMA_VERSION, MAX_HOSTS, MAX_VMS, MAX_RESPONSE_BYTES, PlacementAdvisoryError,
  affinityForHost, recommendForVm, rebalancePlanForHost,
  _internals: {
    affinityCache, affinityInFlight, clearCache, _text, _freshness, _aliases, _mapRefs,
    _ruleKind, _ruleCompliance, _policyForTarget, _compatibilityScore, _telemetry,
    _scoreCandidate, _knownPressure, _mapLimit,
  },
};
