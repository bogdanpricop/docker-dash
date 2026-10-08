'use strict';

const { getDb } = require('../../db');
const { sha256 } = require('../../utils/crypto');
const config = require('../../config');
const registrySingleton = require('./registry');
const snapshotsSingleton = require('./resource-snapshots');

const SCHEMA_VERSION = '1.0';
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_TARGETS = 64;
const SAFE_VM_ID = /^ddr_vm_[a-f0-9]{26}$/;
const MODES = Object.freeze(['live', 'cold', 'storage']);

class MigrationPreflightError extends Error {
  constructor(message, code = 'VM_MIGRATION_PREFLIGHT_ERROR', status = 400) {
    super(message); this.name = 'MigrationPreflightError'; this.code = code; this.status = status;
  }
}

function _text(value, max = 240) {
  if (value === null || value === undefined || value === '') return null;
  return String(value)
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/[\r\n\t]+/g, ' ').slice(0, max);
}

function _finding(value, fallbackType, source = 'common') {
  return {
    type: _text(value?.type, 80) || fallbackType,
    reason: _text(value?.reason ?? value, 240) || 'Migration condition could not be verified',
    source: _text(value?.source, 40) || source,
    modes: (Array.isArray(value?.modes) ? value.modes : MODES).filter(mode => MODES.includes(mode)),
  };
}

function _check(key, state, reason, source = 'common', confidence = 'high') {
  return {
    key: _text(key, 80), state: ['pass', 'fail', 'unknown', 'warning'].includes(state) ? state : 'unknown',
    reason: _text(reason, 240), source: _text(source, 40) || 'common',
    confidence: ['high', 'medium', 'low'].includes(confidence) ? confidence : 'low',
  };
}

function _estimate(mode, vm, hardware) {
  const bytes = hardware?.summary?.totalDiskAllocatedBytes || hardware?.summary?.totalDiskCapacityBytes || 0;
  const transferFast = bytes ? Math.ceil(bytes / (125 * 1024 * 1024)) : 0;
  const transferSlow = bytes ? Math.ceil(bytes / (25 * 1024 * 1024)) : 0;
  if (mode === 'live') return {
    downtimeSeconds: { min: 5, max: 60 },
    durationSeconds: { min: Math.max(15, transferFast), max: Math.max(120, transferSlow) },
    confidence: 'low', methodology: 'memory convergence and final switchover; provider bandwidth is not reserved',
  };
  if (mode === 'storage') return {
    downtimeSeconds: vm.status?.powerState === 'running' ? { min: 5, max: 120 } : { min: 0, max: 0 },
    durationSeconds: { min: Math.max(30, transferFast), max: Math.max(180, transferSlow) },
    confidence: 'low', methodology: 'allocated disk bytes at an unreserved 25-125 MiB/s range',
  };
  return {
    downtimeSeconds: vm.status?.powerState === 'running'
      ? { min: 60 + transferFast, max: 180 + transferSlow } : { min: 0, max: 0 },
    durationSeconds: { min: 60 + transferFast, max: 180 + transferSlow },
    confidence: 'low', methodology: 'shutdown/start allowance plus allocated disk transfer range',
  };
}

function _mode(mode, capability, commonBlockers, provider, vm, hardware) {
  const blockers = commonBlockers.filter(item => item.modes.includes(mode));
  const warnings = (provider?.warnings || []).map(item => _finding(item, 'PROVIDER_WARNING', 'provider'))
    .filter(item => item.modes.includes(mode));
  const providerBlockers = (provider?.blockers || []).map(item => _finding(item, 'PROVIDER_BLOCKED', 'provider'))
    .filter(item => item.modes.includes(mode));
  blockers.push(...providerBlockers);
  if (!['supported', 'conditional'].includes(capability?.state)) blockers.push(_finding({
    type: capability?.state === 'unknown' ? 'CAPABILITY_UNKNOWN' : 'CAPABILITY_UNSUPPORTED',
    reason: capability?.reason || `${mode} migration is not supported by the provider adapter`, modes: [mode],
  }, 'CAPABILITY_UNSUPPORTED'));
  const providerState = provider?.modes?.[mode];
  if (providerState === 'unsupported') blockers.push(_finding({
    type: 'PROVIDER_MODE_UNSUPPORTED', reason: `The provider rejected ${mode} migration for this target`, modes: [mode],
  }, 'PROVIDER_MODE_UNSUPPORTED', 'provider'));
  if (mode === 'live' && vm.status?.powerState !== 'running') blockers.push(_finding({
    type: 'POWER_STATE_BLOCKED', reason: 'Live migration requires a running VM', modes: ['live'],
  }, 'POWER_STATE_BLOCKED'));
  if (mode === 'cold' && vm.status?.powerState !== 'stopped') blockers.push(_finding({
    type: 'POWER_STATE_BLOCKED', reason: 'Cold migration requires the VM to be stopped before submission', modes: ['cold'],
  }, 'POWER_STATE_BLOCKED'));
  const unknown = providerState === 'unknown' || providerState === undefined;
  return {
    state: blockers.length ? 'blocked' : (unknown ? 'unknown' : 'ready'),
    blockers: blockers.slice(0, 32), warnings: warnings.slice(0, 32),
    estimate: _estimate(mode, vm, hardware),
  };
}

function _commonTargetEvidence(target, vm) {
  const blockers = [];
  const checks = [];
  const state = target.status?.powerState || 'unknown';
  const available = state === 'running' && target.status?.enabled !== false;
  checks.push(_check('target.available', available ? 'pass' : (state === 'unknown' ? 'unknown' : 'fail'),
    available ? 'Target host is online and enabled' : `Target host state is ${state}`));
  if (!available && state !== 'unknown') blockers.push(_finding({
    type: 'TARGET_UNAVAILABLE', reason: `Target host is ${state}`, modes: MODES,
  }, 'TARGET_UNAVAILABLE'));
  const maintenance = String(target.status?.maintenanceMode || '').toLowerCase();
  const inMaintenance = maintenance && !['normal', 'none', 'false', 'unknown'].includes(maintenance);
  checks.push(_check('target.maintenance', inMaintenance ? 'fail' : (maintenance ? 'pass' : 'unknown'),
    inMaintenance ? 'Target host is in maintenance mode' : (maintenance ? 'Target host is not in maintenance mode' : 'Maintenance state was not reported')));
  if (inMaintenance) blockers.push(_finding({
    type: 'TARGET_MAINTENANCE', reason: 'Target host is in maintenance mode', modes: MODES,
  }, 'TARGET_MAINTENANCE'));
  const required = Number(vm.spec?.memoryBytes || 0);
  const free = Number(target.status?.memoryFreeBytes || 0);
  const reserve = Math.ceil(required * 1.1);
  if (required && free) {
    const enough = free >= reserve;
    checks.push(_check('capacity.memory', enough ? 'pass' : 'fail', enough
      ? 'Observed free memory includes the 10% migration reserve'
      : 'Observed free memory is below VM memory plus the 10% reserve'));
    if (!enough) blockers.push(_finding({
      type: 'INSUFFICIENT_MEMORY', reason: 'Target free memory is below VM memory plus the 10% reserve', modes: MODES,
    }, 'INSUFFICIENT_MEMORY'));
  } else checks.push(_check('capacity.memory', 'unknown', 'Provider did not report both VM memory and target free memory', 'common', 'low'));
  return { blockers, checks, capacity: { vmMemoryBytes: required || null, targetFreeMemoryBytes: free || null, reserveBytes: required ? reserve : null } };
}

function _maintenanceReservations(database) {
  try {
    return new Set(database.prepare(`SELECT source_host_id FROM provider_host_maintenance_runs
      WHERE state IN ('queued', 'preparing', 'draining', 'paused', 'entering',
        'drained', 'maintenance', 'exiting', 'unknown')`).all().map(row => row.source_host_id));
  } catch { return new Set(); }
}

async function preflightForHost(host, vmId, options = {}) {
  if (!host || !Number.isInteger(Number(host.id)) || !SAFE_VM_ID.test(String(vmId || ''))) {
    throw new MigrationPreflightError('Virtual machine was not found', 'PROVIDER_VM_NOT_FOUND', 404);
  }
  const database = options.database || getDb();
  const registry = options.registry || registrySingleton;
  const snapshots = options.snapshots || snapshotsSingleton;
  const capabilities = await registry.capabilitiesForHost(host);
  let vm = snapshots.get(vmId, Number(host.id), 'virtualMachine', database);
  try {
    const inventory = await registry.resourcesForHost(host, 'virtual-machines', { limit: 500, database });
    vm = inventory.items.find(item => item.id === vmId) || vm;
  } catch (err) { if (!vm) throw err; }
  if (!vm) throw new MigrationPreflightError('Virtual machine was not found', 'PROVIDER_VM_NOT_FOUND', 404);
  let targets = [];
  try { targets = (await registry.resourcesForHost(host, 'hosts', { limit: MAX_TARGETS, database })).items; }
  catch { /* capability matrix still explains why no targets are visible */ }
  let hardware = null;
  try { hardware = await registry.vmHardwareForHost(host, vm, { database, capabilities }); }
  catch { /* optional evidence */ }
  let provider = null;
  let providerWarning = null;
  try { provider = await registry.migrationCompatibilityForHost(host, vm, targets, { database, capabilities }); }
  catch (err) {
    providerWarning = err?.code === 'PROVIDER_MIGRATION_PREFLIGHT_UNAVAILABLE'
      ? null : 'Live provider compatibility checks could not be completed';
  }
  const byTarget = new Map((provider?.candidates || []).map(item => [item.targetId, item]));
  const maintenanceReservations = _maintenanceReservations(database);
  const capabilityMatrix = Object.fromEntries([
    ['live', 'vm.migration.live'], ['cold', 'vm.migration.cold'],
    ['storage', 'vm.migration.storage'], ['crossCluster', 'vm.migration.crossCluster'],
  ].map(([mode, key]) => [mode, { capability: key, ...(capabilities.features?.[key] || { state: 'unknown', reason: 'No evidence' }) }]));
  const candidates = targets.map(target => {
    const providerTarget = byTarget.get(target.id) || null;
    const common = _commonTargetEvidence(target, vm);
    if (maintenanceReservations.has(target.id)) {
      common.blockers.push(_finding({
        type: 'TARGET_MAINTENANCE_RESERVED',
        reason: 'Target host is reserved by an active Docker Dash maintenance run', modes: MODES,
      }, 'TARGET_MAINTENANCE_RESERVED'));
      common.checks.push(_check('target.maintenanceReservation', 'fail', 'Target is reserved by an active maintenance run'));
    }
    if (target.id === provider?.sourceTargetId || providerTarget?.current === true) {
      common.blockers.push(_finding({ type: 'CURRENT_HOST', reason: 'Target is the VM current host', modes: MODES }, 'CURRENT_HOST'));
      common.checks.push(_check('target.current', 'fail', 'Target is the current host'));
    }
    const providerChecks = (providerTarget?.checks || []).slice(0, 64).map(item => _check(
      item.key, item.state, item.reason, item.source || 'provider', item.confidence || 'medium'
    ));
    const modes = Object.fromEntries(MODES.map(mode => [mode, _mode(
      mode, capabilityMatrix[mode], common.blockers, providerTarget, vm, hardware
    )]));
    const ready = MODES.filter(mode => modes[mode].state === 'ready');
    const unknown = MODES.filter(mode => modes[mode].state === 'unknown');
    const warningCount = MODES.reduce((sum, mode) => sum + modes[mode].warnings.length, 0);
    return {
      target: {
        id: target.id, displayName: target.displayName, status: stateSummary(target), capacity: common.capacity,
        telemetry: telemetrySummary(target),
      },
      eligible: ready.length > 0, score: Math.max(0, Math.min(100, 100 - common.blockers.length * 40 - unknown.length * 10 - warningCount * 2)),
      readyModes: ready, unknownModes: unknown, modes,
      checks: [...common.checks, ...providerChecks].slice(0, 64),
    };
  }).sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score || a.target.displayName.localeCompare(b.target.displayName));
  const output = {
    schemaVersion: SCHEMA_VERSION, generatedAt: new Date().toISOString(),
    vm: { id: vm.id, displayName: vm.displayName, powerState: vm.status?.powerState || 'unknown', memoryBytes: vm.spec?.memoryBytes || null, cpuCount: vm.spec?.cpuCount || null },
    provider: { type: host.daemon_type, endpointId: Number(host.id), endpointName: _text(host.name, 160) },
    scope: {
      sameEndpointOnly: true, crossProvider: false,
      executionEnabled: options.executionEnabled === undefined
        ? config.features.providerVmMigration : options.executionEnabled === true,
      maxTargets: MAX_TARGETS,
    },
    capabilityMatrix, sourceTargetId: provider?.sourceTargetId || null,
    candidates, warnings: [providerWarning, ...(provider?.warnings || []).map(item => _text(item?.reason ?? item))].filter(Boolean).slice(0, 32),
    assumptions: [
      'Estimates do not reserve bandwidth or target capacity',
      'A ready preflight is evidence, not authorization to execute migration',
    ],
  };
  output.planHash = sha256(JSON.stringify({ vm: output.vm, provider: output.provider, capabilityMatrix, candidates }));
  if (Buffer.byteLength(JSON.stringify(output)) > MAX_RESPONSE_BYTES) {
    throw new MigrationPreflightError('Migration preflight exceeds the response size limit', 'MIGRATION_PREFLIGHT_TOO_LARGE', 502);
  }
  return output;
}

function stateSummary(target) {
  return {
    powerState: target.status?.powerState || 'unknown', enabled: target.status?.enabled,
    maintenanceMode: target.status?.maintenanceMode || null,
  };
}

function telemetrySummary(target) {
  return {
    observedAt: target.observedAt || null,
    cpuCount: target.spec?.cpuCount || null,
    memoryBytes: target.spec?.memoryBytes || null,
    memoryFreeBytes: target.status?.memoryFreeBytes ?? null,
    cpuUtilizationPercent: target.status?.cpuUtilizationPercent ?? null,
    memoryUtilizationPercent: target.status?.memoryUtilizationPercent ?? null,
  };
}

module.exports = {
  preflightForHost, MigrationPreflightError, SCHEMA_VERSION, MAX_RESPONSE_BYTES, MAX_TARGETS,
  _internals: { _text, _finding, _check, _estimate, _mode, _commonTargetEvidence, _maintenanceReservations, stateSummary, telemetrySummary },
};
