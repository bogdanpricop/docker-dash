'use strict';

const crypto = require('crypto');
const config = require('../../config');
const { getDb } = require('../../db');
const version = require('../../version');
const repositoryHealth = require('../storage-repository-health');

const IMPLEMENTATION_RELEASE = 'v8.80.0';
const FOUNDATION_FEATURE_IDS = Object.freeze([
  'B015', 'B045', 'B090', 'B096', 'B104',
  'B118', 'B119', 'B120', 'B121', 'B123',
]);
const NETWORK_BACKUP_FEATURE_IDS = Object.freeze([
  'B124', 'B125', 'B129', 'B130', 'B131',
  'B132', 'B133', 'B134', 'B135', 'B136',
]);
const FEATURE_IDS = FOUNDATION_FEATURE_IDS;
const BATCHES = Object.freeze({
  foundation: Object.freeze({ key: 'foundation',
    label: 'B015/B045/B090/B096/B104/B118–B121/B123', featureIds: FOUNDATION_FEATURE_IDS }),
  'network-backup': Object.freeze({ key: 'network-backup',
    label: 'B124/B125/B129–B136', featureIds: NETWORK_BACKUP_FEATURE_IDS }),
});

const DEFINITIONS = Object.freeze({
  B015: Object.freeze({
    name: 'Saved inventory views', mode: 'control-plane',
    tables: ['provider_inventory_views'],
    outstanding: ['browser_smoke'],
  }),
  B045: Object.freeze({
    name: 'Scheduled VM actions', mode: 'guarded-mutation',
    tables: ['provider_vm_action_schedules', 'provider_vm_action_schedule_runs'],
    outstanding: ['browser_smoke', 'disposable_provider_canary'],
  }),
  B090: Object.freeze({
    name: 'Stale snapshot growth monitor', mode: 'read-only',
    tables: ['provider_snapshot_risk_policies', 'provider_snapshot_risk_observations'],
    outstanding: ['browser_smoke'],
  }),
  B096: Object.freeze({
    name: 'NFS/SMB repository health', mode: 'bounded-network-read',
    tables: ['storage_repository_endpoints', 'storage_repository_observations'],
    outstanding: ['approved_data_plane_adapter', 'browser_smoke'],
  }),
  B104: Object.freeze({
    name: 'NIC connect/disconnect', mode: 'guarded-mutation',
    tables: ['provider_vm_nic_safety_declarations', 'provider_operations'],
    outstanding: ['browser_smoke', 'disposable_provider_canary'],
  }),
  B118: Object.freeze({
    name: 'VM dependency map', mode: 'read-only',
    tables: ['network_dependency_address_observations', 'network_dependency_dns_observations', 'network_dependency_snapshots'],
    outstanding: ['provider_native_evidence_adapter', 'browser_smoke'],
  }),
  B119: Object.freeze({
    name: 'Network reachability test', mode: 'simulation-only',
    tables: ['network_reachability_assessments'],
    outstanding: ['provider_simulation_adapter', 'approved_active_probe_runner', 'browser_smoke'],
  }),
  B120: Object.freeze({
    name: 'MTU mismatch detector', mode: 'passive',
    tables: ['network_mtu_assessments'],
    outstanding: ['provider_native_evidence_adapter', 'browser_smoke'],
  }),
  B121: Object.freeze({
    name: 'Bond/LAG health', mode: 'passive',
    tables: ['network_bond_health_observations'],
    outstanding: ['provider_native_collector', 'browser_smoke'],
  }),
  B123: Object.freeze({
    name: 'Load balancer inventory', mode: 'read-only',
    tables: ['network_load_balancer_observations'],
    outstanding: ['provider_native_collector', 'browser_smoke'],
  }),
  B124: Object.freeze({
    name: 'Public IP lifecycle planning', mode: 'plan-only',
    tables: ['network_public_ip_lifecycle_plans'],
    columns: { network_public_ip_lifecycle_plans: ['provider_mutations_started', 'external_mutations_started'] },
    outstanding: ['provider_adapter', 'disposable_provider_canary', 'controlled_apply', 'browser_smoke'],
  }),
  B125: Object.freeze({
    name: 'Network intent validation', mode: 'read-only',
    tables: ['network_intent_validations'],
    columns: { network_intent_validations: ['provider_mutations_started'] },
    outstanding: ['first_executor_hash_binding', 'browser_smoke'],
  }),
  B129: Object.freeze({
    name: 'Backup mode contract', mode: 'guarded-mutation',
    tables: ['provider_backup_policies', 'provider_backup_policy_runs', 'provider_backup_executions'],
    columns: { provider_backup_executions: ['contract_json'] },
    outstanding: ['second_provider_executor', 'disposable_provider_canary', 'browser_smoke'],
  }),
  B130: Object.freeze({
    name: 'Smart backup selection', mode: 'control-plane',
    tables: ['provider_backup_policies', 'provider_backup_policy_runs'],
    columns: { provider_backup_policies: ['scope_json'] },
    outstanding: ['second_provider_executor', 'disposable_provider_canary', 'browser_smoke'],
  }),
  B131: Object.freeze({
    name: 'Backup exclusions', mode: 'control-plane',
    tables: ['provider_backup_policies', 'provider_backup_policy_runs'],
    columns: { provider_backup_policies: ['scope_json'] },
    outstanding: ['provider_native_disk_path_translation', 'disposable_provider_canary', 'browser_smoke'],
  }),
  B132: Object.freeze({
    name: 'Application-consistent backup orchestration', mode: 'guarded-mutation',
    tables: ['provider_backup_policies', 'provider_backup_executions'],
    columns: { provider_backup_policies: ['consistency_json'], provider_backup_executions: ['contract_json'] },
    outstanding: ['provider_native_hook_adapter', 'disposable_provider_canary', 'browser_smoke'],
  }),
  B133: Object.freeze({
    name: 'Concurrent backup admission', mode: 'guarded-mutation',
    tables: ['provider_backup_policies', 'provider_backup_execution_items'],
    columns: { provider_backup_policies: ['controls_json'], provider_backup_execution_items: ['admission_json'] },
    outstanding: ['restart_concurrency_canary', 'second_provider_executor', 'browser_smoke'],
  }),
  B134: Object.freeze({
    name: 'Backup bandwidth windows', mode: 'guarded-mutation',
    tables: ['provider_backup_policies', 'provider_backup_execution_items'],
    columns: { provider_backup_policies: ['controls_json'], provider_backup_execution_items: ['admission_json'] },
    outstanding: ['provider_native_throttle_adapter', 'disposable_provider_canary', 'browser_smoke'],
  }),
  B135: Object.freeze({
    name: 'GFS retention planning', mode: 'plan-only',
    tables: ['provider_backup_policies', 'provider_backup_policy_runs'],
    columns: { provider_backup_policies: ['retention_json'], provider_backup_policy_runs: ['plan_json'] },
    outstanding: ['retention_mutation_authorization', 'disposable_provider_canary', 'browser_smoke'],
  }),
  B136: Object.freeze({
    name: 'Immutable backup evidence', mode: 'evidence-only',
    tables: ['provider_backup_policies', 'provider_recovery_points', 'provider_backup_integrity_evidence'],
    columns: { provider_backup_policies: ['protection_json'], provider_backup_integrity_evidence: ['protection_json'] },
    outstanding: ['provider_native_lock_enforcement', 'disposable_provider_canary', 'browser_smoke'],
  }),
});

class OperationalQualificationError extends Error {
  constructor(message, code = 'OPERATIONAL_QUALIFICATION_ERROR', status = 400) {
    super(message); this.name = 'OperationalQualificationError'; this.code = code; this.status = status;
  }
}

function _canonical(value) {
  if (Array.isArray(value)) return `[${value.map(_canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${_canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function _hash(value) {
  return crypto.createHash('sha256').update(_canonical(value)).digest('hex');
}

function _tableExists(database, table) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function _columnExists(database, table, column) {
  if (!_tableExists(database, table)) return false;
  try { return database.prepare(`PRAGMA table_info(${table})`).all().some(item => item.name === column); }
  catch { return false; }
}

function _row(database, sql, params = []) {
  try { return database.prepare(sql).get(...params) || {}; } catch { return {}; }
}

function _number(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }

function _latest(...values) {
  return values.filter(Boolean).sort().at(-1) || null;
}

function _backupRuntime(database, context) {
  const policy = _row(database, `SELECT COUNT(*) configured_count,MAX(updated_at) last_evidence_at
    FROM provider_backup_policies WHERE host_id=? AND deleted_at IS NULL`, [context.hostId]);
  const plan = _row(database, `SELECT COUNT(*) planned_count,MAX(r.created_at) last_evidence_at
    FROM provider_backup_policy_runs r JOIN provider_backup_policies p ON p.id=r.policy_id
    WHERE p.host_id=?`, [context.hostId]);
  const execution = _row(database, `SELECT COUNT(*) execution_count,MAX(e.updated_at) last_evidence_at
    FROM provider_backup_executions e JOIN provider_backup_policies p ON p.id=e.policy_id
    WHERE p.host_id=?`, [context.hostId]);
  const item = _row(database, `SELECT COUNT(*) execution_item_count,MAX(i.updated_at) last_evidence_at
    FROM provider_backup_execution_items i JOIN provider_backup_executions e ON e.id=i.execution_id
    JOIN provider_backup_policies p ON p.id=e.policy_id WHERE p.host_id=?`, [context.hostId]);
  const integrity = _row(database, `SELECT COUNT(*) integrity_evidence_count,MAX(v.observed_at) last_evidence_at
    FROM provider_backup_integrity_evidence v JOIN provider_backup_execution_items i ON i.id=v.execution_item_id
    JOIN provider_backup_executions e ON e.id=i.execution_id
    JOIN provider_backup_policies p ON p.id=e.policy_id WHERE p.host_id=?`, [context.hostId]);
  const configuredCount = _number(policy.configured_count);
  const plannedCount = _number(plan.planned_count);
  const executionCount = _number(execution.execution_count);
  const executionItemCount = _number(item.execution_item_count);
  const integrityEvidenceCount = _number(integrity.integrity_evidence_count);
  return {
    recordCount: configuredCount + plannedCount + executionCount + integrityEvidenceCount,
    configuredCount, plannedCount, executionCount, executionItemCount, integrityEvidenceCount,
    lastEvidenceAt: _latest(policy.last_evidence_at, plan.last_evidence_at,
      execution.last_evidence_at, item.last_evidence_at, integrity.last_evidence_at),
    releaseFlags: [
      { name: 'DD_PROVIDER_BACKUP_POLICIES', enabled: config.features?.providerBackupPolicies === true },
      { name: 'DD_PROVIDER_BACKUP_EXECUTION', enabled: config.features?.providerBackupExecution === true },
    ],
  };
}

function _runtime(database, featureId, context) {
  const hostId = context.hostId; const actorId = context.actorId;
  if (featureId === 'B015') {
    const result = _row(database, `SELECT COUNT(*) record_count,MAX(updated_at) last_evidence_at
      FROM provider_inventory_views WHERE user_id=? AND (provider_host_id IS NULL OR provider_host_id=?)`,
    [actorId, hostId]);
    return { recordCount: _number(result.record_count), lastEvidenceAt: result.last_evidence_at || null,
      scope: 'current-user' };
  }
  if (featureId === 'B045') {
    const result = _row(database, `SELECT COUNT(DISTINCT s.id) configured_count,COUNT(r.id) record_count,
      MAX(COALESCE(r.updated_at,s.updated_at)) last_evidence_at,
      SUM(CASE WHEN r.state='succeeded' THEN 1 ELSE 0 END) succeeded_count
      FROM provider_vm_action_schedules s LEFT JOIN provider_vm_action_schedule_runs r ON r.schedule_id=s.id
      WHERE s.host_id=? AND s.deleted_at IS NULL`, [hostId]);
    return { configuredCount: _number(result.configured_count), recordCount: _number(result.record_count),
      succeededCount: _number(result.succeeded_count), lastEvidenceAt: result.last_evidence_at || null,
      executeFlag: { name: 'DD_PROVIDER_VM_ACTION_SCHEDULES', enabled: config.features?.providerVmActionSchedules === true } };
  }
  if (featureId === 'B090') {
    const result = _row(database, `SELECT COUNT(*) record_count,MAX(observed_at) last_evidence_at
      FROM provider_snapshot_risk_observations WHERE host_id=?`, [hostId]);
    return { recordCount: _number(result.record_count), lastEvidenceAt: result.last_evidence_at || null };
  }
  if (featureId === 'B096') {
    const result = _row(database, `SELECT COUNT(DISTINCT r.id) configured_count,COUNT(o.id) record_count,
      MAX(o.observed_at) last_evidence_at,SUM(CASE WHEN o.write_test=1 THEN 1 ELSE 0 END) write_test_count
      FROM storage_repository_endpoints r LEFT JOIN storage_repository_observations o ON o.repository_id=r.id`);
    const adapter = typeof repositoryHealth.adapterCapabilities === 'function'
      ? repositoryHealth.adapterCapabilities() : { read: false, write: false };
    return { configuredCount: _number(result.configured_count), recordCount: _number(result.record_count),
      writeTestCount: _number(result.write_test_count), lastEvidenceAt: result.last_evidence_at || null,
      dataPlaneAdapter: adapter };
  }
  if (featureId === 'B104') {
    const result = _row(database, `SELECT
      (SELECT COUNT(*) FROM provider_vm_nic_safety_declarations WHERE host_id=?) declaration_count,
      COUNT(*) record_count,MAX(updated_at) last_evidence_at,
      SUM(CASE WHEN state='succeeded' THEN 1 ELSE 0 END) succeeded_count
      FROM provider_operations WHERE host_id=? AND operation_type='vm.nic.link'`, [hostId, hostId]);
    const keys = { proxmox: 'providerVmNicLinkProxmox', vsphere: 'providerVmNicLinkVsphere', xen: 'providerVmNicLinkXen' };
    const envNames = { proxmox: 'DD_PROVIDER_VM_NIC_LINK_PROXMOX', vsphere: 'DD_PROVIDER_VM_NIC_LINK_VSPHERE', xen: 'DD_PROVIDER_VM_NIC_LINK_XEN' };
    return { declarationCount: _number(result.declaration_count), recordCount: _number(result.record_count),
      succeededCount: _number(result.succeeded_count), lastEvidenceAt: result.last_evidence_at || null,
      executeFlag: { name: envNames[context.providerType] || 'provider-specific',
        enabled: config.features?.[keys[context.providerType]] === true } };
  }
  if (featureId === 'B118') {
    const result = _row(database, `SELECT COUNT(*) record_count,MAX(built_at) last_evidence_at,
      COALESCE(SUM(provider_mutations_started),0) provider_mutations_started,
      COALESCE(SUM(network_calls_started),0) network_calls_started
      FROM network_dependency_snapshots WHERE scope_key IN (?,?)`, [`provider:${hostId}`, 'global']);
    return _passiveRuntime(result);
  }
  if (featureId === 'B119') {
    const result = _row(database, `SELECT COUNT(*) record_count,MAX(created_at) last_evidence_at,
      COALESCE(SUM(provider_mutations_started),0) provider_mutations_started,
      COALESCE(SUM(network_calls_started),0) network_calls_started
      FROM network_reachability_assessments WHERE scope_key IN (?,?)`, [`provider:${hostId}`, 'global']);
    return _passiveRuntime(result);
  }
  if (featureId === 'B124') {
    const result = _row(database, `SELECT COUNT(*) record_count,MAX(created_at) last_evidence_at,
      COALESCE(SUM(provider_mutations_started),0) provider_mutations_started,
      COALESCE(SUM(external_mutations_started),0) external_mutations_started
      FROM network_public_ip_lifecycle_plans WHERE scope_key IN (?,?)`, [`provider:${hostId}`, 'global']);
    return { ..._passiveRuntime(result), externalMutationsStarted: _number(result.external_mutations_started) };
  }
  if (featureId === 'B125') {
    const result = _row(database, `SELECT COUNT(*) record_count,MAX(created_at) last_evidence_at,
      COALESCE(SUM(provider_mutations_started),0) provider_mutations_started
      FROM network_intent_validations WHERE scope_key IN (?,?)`, [`provider:${hostId}`, 'global']);
    return _passiveRuntime(result);
  }
  if (NETWORK_BACKUP_FEATURE_IDS.includes(featureId)) return _backupRuntime(database, context);
  const table = { B120: 'network_mtu_assessments', B121: 'network_bond_health_observations',
    B123: 'network_load_balancer_observations' }[featureId];
  const time = featureId === 'B120' ? 'assessed_at' : 'observed_at';
  const result = _row(database, `SELECT COUNT(*) record_count,MAX(${time}) last_evidence_at,
    COALESCE(SUM(provider_mutations_started),0) provider_mutations_started,
    COALESCE(SUM(network_calls_started),0) network_calls_started
    FROM ${table} WHERE provider_host_id=? OR provider_host_id IS NULL`, [hostId]);
  return _passiveRuntime(result);
}

function _passiveRuntime(result) {
  return { recordCount: _number(result.record_count), lastEvidenceAt: result.last_evidence_at || null,
    providerMutationsStarted: _number(result.provider_mutations_started),
    networkCallsStarted: _number(result.network_calls_started) };
}

function qualificationForHost(host, options = {}) {
  const hostId = Number(host?.id); const actorId = Number(options.actorId);
  if (!Number.isSafeInteger(hostId) || hostId <= 0) {
    throw new OperationalQualificationError('Valid provider host required', 'INVALID_HOST');
  }
  if (!Number.isSafeInteger(actorId) || actorId <= 0) {
    throw new OperationalQualificationError('Valid actor required', 'INVALID_ACTOR', 401);
  }
  const database = options.database || getDb();
  const batchKey = options.batch === undefined || options.batch === null || options.batch === ''
    ? 'foundation' : String(options.batch);
  const batch = BATCHES[batchKey];
  if (!batch) throw new OperationalQualificationError('Unknown qualification batch',
    'INVALID_QUALIFICATION_BATCH');
  const context = { hostId, actorId, providerType: String(host.daemon_type || host.daemonType || 'unknown') };
  const items = batch.featureIds.map(featureId => {
    const definition = DEFINITIONS[featureId];
    const tables = definition.tables.map(name => ({ name, available: _tableExists(database, name) }));
    const columns = Object.entries(definition.columns || {}).flatMap(([table, names]) =>
      names.map(name => ({ table, name, available: _columnExists(database, table, name) })));
    const schemaReady = tables.every(table => table.available) && columns.every(column => column.available);
    const runtime = schemaReady ? _runtime(database, featureId, context)
      : { recordCount: 0, lastEvidenceAt: null };
    return {
      featureId, name: definition.name, mode: definition.mode,
      delivery: { implementationRelease: IMPLEMENTATION_RELEASE,
        qualificationRelease: `v${version}`, included: true },
      schema: { state: schemaReady ? 'ready' : 'missing', tables, columns },
      runtime: { state: runtime.recordCount > 0 ? 'observed' : 'not_observed', ...runtime },
      qualificationSafety: { providerMutationsStarted: 0, networkCallsStarted: 0,
        externalCommandsStarted: 0 },
      validation: { browserSmoke: 'not_recorded', outstanding: [...definition.outstanding] },
    };
  });
  const evidence = {
    schemaVersion: '1.1', batch: { key: batch.key, label: batch.label },
    hostId, providerType: context.providerType,
    applicationVersion: version, implementationRelease: IMPLEMENTATION_RELEASE, items,
  };
  const enabledFlagNames = new Set(items.flatMap(item => {
    const flags = item.runtime.releaseFlags || (item.runtime.executeFlag ? [item.runtime.executeFlag] : []);
    return flags.filter(flag => flag.enabled === true).map(flag => flag.name);
  }));
  return {
    ...evidence, generatedAt: new Date().toISOString(), evidenceHash: _hash(evidence),
    summary: {
      featureCount: items.length,
      schemaReady: items.filter(item => item.schema.state === 'ready').length,
      runtimeObserved: items.filter(item => item.runtime.state === 'observed').length,
      executeFlagsEnabled: enabledFlagNames.size,
      browserSmokeRecorded: 0,
    },
    limitations: [
      'This qualification reads local control-plane evidence only and is not a browser test, provider canary, protocol data-plane test or active network probe.',
      'No provider mutation, network call or external command is started by this endpoint.',
      'A missing runtime observation means not observed; it is never converted into a successful result.',
    ],
  };
}

module.exports = {
  FEATURE_IDS, NETWORK_BACKUP_FEATURE_IDS, BATCHES, OperationalQualificationError, qualificationForHost,
  _internals: { DEFINITIONS, _canonical, _hash, _passiveRuntime, _tableExists, _columnExists,
    _backupRuntime },
};
