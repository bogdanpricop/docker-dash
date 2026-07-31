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
const RECOVERY_DEPTH_FEATURE_IDS = Object.freeze([
  'B137', 'B138', 'B139', 'B140', 'B141',
  'B142', 'B143', 'B144', 'B145', 'B146',
]);
const DR_SECURITY_FEATURE_IDS = Object.freeze([
  'B147', 'B148', 'B149', 'B150', 'B151',
  'B152', 'B153', 'B154', 'B155', 'B156',
]);
const FEATURE_IDS = FOUNDATION_FEATURE_IDS;
const BATCHES = Object.freeze({
  foundation: Object.freeze({ key: 'foundation',
    label: 'B015/B045/B090/B096/B104/B118–B121/B123', featureIds: FOUNDATION_FEATURE_IDS }),
  'network-backup': Object.freeze({ key: 'network-backup',
    label: 'B124/B125/B129–B136', featureIds: NETWORK_BACKUP_FEATURE_IDS }),
  'recovery-depth': Object.freeze({ key: 'recovery-depth',
    label: 'B137–B146', featureIds: RECOVERY_DEPTH_FEATURE_IDS }),
  'dr-security': Object.freeze({ key: 'dr-security',
    label: 'B147–B156', featureIds: DR_SECURITY_FEATURE_IDS }),
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
  B137: Object.freeze({
    name: 'Backup encryption policy', mode: 'evidence-only',
    tables: ['provider_backup_policies', 'provider_recovery_points'],
    columns: { provider_backup_policies: ['protection_json'], provider_recovery_points: ['recovery_point_json'] },
    outstanding: ['provider_native_key_rotation_evidence', 'second_provider_executor',
      'disposable_provider_canary', 'browser_smoke'],
  }),
  B138: Object.freeze({
    name: 'Backup integrity verification', mode: 'evidence-only',
    tables: ['provider_backup_execution_items', 'provider_backup_integrity_evidence'],
    columns: { provider_backup_execution_items: ['integrity_json'],
      provider_backup_integrity_evidence: ['methods_json', 'protection_json'] },
    outstanding: ['provider_native_checksum_chain_evidence', 'second_provider_executor',
      'disposable_provider_canary', 'browser_smoke'],
  }),
  B139: Object.freeze({
    name: 'Automated restore drill', mode: 'guarded-mutation', implementationRelease: 'v8.81.0',
    tables: ['provider_restore_drill_policies', 'provider_restore_drill_runs'],
    columns: { provider_restore_drill_runs: ['operation_id', 'evidence_hash'] },
    outstanding: ['second_provider_drill_executor', 'disposable_provider_canary', 'browser_smoke'],
  }),
  B140: Object.freeze({
    name: 'Restore drill scheduler', mode: 'guarded-mutation', implementationRelease: 'v8.81.0',
    tables: ['provider_restore_drill_policies', 'provider_restore_drill_runs'],
    columns: { provider_restore_drill_policies: ['schedule_json', 'last_slot_key'] },
    outstanding: ['scheduler_restart_canary', 'second_provider_drill_executor', 'browser_smoke'],
  }),
  B141: Object.freeze({
    name: 'File-level restore browser', mode: 'metadata-only', implementationRelease: 'v8.81.0',
    tables: ['provider_recovery_file_catalogs', 'provider_recovery_file_entries', 'provider_restore_depth_plans'],
    columns: { provider_recovery_file_catalogs: ['manifest_hash'],
      provider_recovery_file_entries: ['path'], provider_restore_depth_plans: ['restore_kind'] },
    outstanding: ['provider_native_file_content_adapter', 'approved_content_endpoint', 'browser_smoke'],
  }),
  B142: Object.freeze({
    name: 'Instant/live restore adapter', mode: 'plan-only', implementationRelease: 'v8.81.0',
    tables: ['provider_restore_depth_plans'],
    columns: { provider_restore_depth_plans: ['restore_kind', 'allowed', 'plan_hash'] },
    outstanding: ['provider_native_instant_restore_executor', 'isolated_network_canary', 'browser_smoke'],
  }),
  B143: Object.freeze({
    name: 'Differential restore adapter', mode: 'plan-only', implementationRelease: 'v8.81.0',
    tables: ['provider_restore_depth_plans'],
    columns: { provider_restore_depth_plans: ['restore_kind', 'evidence_json', 'plan_hash'] },
    outstanding: ['provider_native_differential_restore_executor', 'base_integrity_canary', 'browser_smoke'],
  }),
  B144: Object.freeze({
    name: 'Cross-site backup copy', mode: 'plan-only', implementationRelease: 'v8.81.0',
    tables: ['provider_restore_depth_plans'],
    columns: { provider_restore_depth_plans: ['restore_kind', 'request_json', 'plan_hash'] },
    outstanding: ['resumable_copy_executor', 'cross_site_canary', 'browser_smoke'],
  }),
  B145: Object.freeze({
    name: 'VM replication policy', mode: 'draft-only', implementationRelease: 'v8.81.0',
    tables: ['provider_replication_policies'],
    columns: { provider_replication_policies: ['mode', 'enabled', 'policy_hash'] },
    outstanding: ['provider_native_replication_configure_executor', 'fencing_canary', 'browser_smoke'],
  }),
  B146: Object.freeze({
    name: 'DR protection groups', mode: 'rehearsal-only', implementationRelease: 'v8.81.0',
    tables: ['provider_dr_protection_groups', 'provider_dr_group_members', 'provider_dr_runs'],
    columns: { provider_dr_protection_groups: ['strategy', 'enabled'],
      provider_dr_group_members: ['depends_on_json'], provider_dr_runs: ['execution_type', 'evidence_hash'] },
    outstanding: ['provider_fencing_and_network_cutover', 'data_authority_reversal',
      'disposable_provider_canary', 'browser_smoke'],
  }),
  B147: Object.freeze({
    name: 'Failover plan/runbook', mode: 'rehearsal-only', implementationRelease: 'v8.81.0',
    tables: ['provider_dr_protection_groups', 'provider_dr_group_members', 'provider_dr_runs'],
    columns: { provider_dr_runs: ['runbook_mode', 'execution_type', 'plan_hash', 'evidence_hash'] },
    outstanding: ['provider_native_failover_executor', 'provider_fencing_and_network_cutover',
      'disposable_provider_canary', 'browser_smoke'],
  }),
  B148: Object.freeze({
    name: 'Failback workflow', mode: 'rehearsal-only', implementationRelease: 'v8.81.0',
    tables: ['provider_dr_protection_groups', 'provider_dr_runs'],
    columns: { provider_dr_runs: ['runbook_mode', 'execution_type', 'plan_hash', 'evidence_hash'] },
    outstanding: ['provider_native_failback_executor', 'data_authority_reversal',
      'reprotection_canary', 'browser_smoke'],
  }),
  B149: Object.freeze({
    name: 'Non-disruptive DR test', mode: 'rehearsal-only', implementationRelease: 'v8.82.0',
    tables: ['provider_dr_protection_groups', 'provider_dr_group_members', 'provider_dr_runs'],
    columns: { provider_dr_group_members: ['recovery_target_json'],
      provider_dr_runs: ['runbook_mode', 'execution_type', 'evidence_json', 'evidence_hash'] },
    outstanding: ['bubble_network_and_clone_executor', 'cleanup_ownership_canary', 'browser_smoke'],
  }),
  B150: Object.freeze({
    name: 'RPO/RTO compliance dashboard', mode: 'evidence-only', implementationRelease: 'v8.82.0',
    tables: ['provider_dr_protection_groups', 'provider_dr_runs'],
    columns: { provider_dr_protection_groups: ['rpo_target_seconds', 'rto_target_seconds'],
      provider_dr_runs: ['compliance', 'rpo_max_seconds', 'rto_max_seconds'] },
    outstanding: ['provider_native_replication_evidence', 'successful_restore_canary', 'browser_smoke'],
  }),
  B151: Object.freeze({
    name: 'Provider security posture packs', mode: 'evidence-only', implementationRelease: 'v8.82.0',
    tables: ['provider_security_evidence'],
    columns: { provider_security_evidence: ['pack_key', 'pack_version', 'source', 'facts_json', 'evidence_hash'] },
    outstanding: ['provider_native_security_collectors', 'controlled_remediation', 'browser_smoke'],
  }),
  B152: Object.freeze({
    name: 'Secure Boot inventory', mode: 'evidence-only', implementationRelease: 'v8.82.0',
    tables: ['provider_security_evidence'],
    columns: { provider_security_evidence: ['facts_json', 'observed_at'] },
    outstanding: ['provider_native_secure_boot_collector', 'browser_smoke', 'provider_canary'],
  }),
  B153: Object.freeze({
    name: 'vTPM inventory', mode: 'evidence-only', implementationRelease: 'v8.82.0',
    tables: ['provider_security_evidence'],
    columns: { provider_security_evidence: ['facts_json', 'observed_at'] },
    outstanding: ['provider_native_vtpm_collector', 'browser_smoke', 'provider_canary'],
  }),
  B154: Object.freeze({
    name: 'Encryption inventory', mode: 'evidence-only', implementationRelease: 'v8.82.0',
    tables: ['provider_security_evidence'],
    columns: { provider_security_evidence: ['facts_json', 'observed_at'] },
    outstanding: ['provider_native_encryption_collector', 'browser_smoke', 'provider_canary'],
  }),
  B155: Object.freeze({
    name: 'KMS/key-provider registry', mode: 'evidence-only', implementationRelease: 'v8.82.0',
    tables: ['provider_key_providers'],
    columns: { provider_key_providers: ['secret_ref', 'health_state', 'evidence_hash', 'deleted_at'] },
    outstanding: ['provider_native_kms_health_collector', 'certificate_canary', 'browser_smoke'],
  }),
  B156: Object.freeze({
    name: 'Shielded/confidential VM detector', mode: 'evidence-only', implementationRelease: 'v8.82.0',
    tables: ['provider_security_evidence'],
    columns: { provider_security_evidence: ['facts_json', 'observed_at'] },
    outstanding: ['provider_native_confidential_compute_collector', 'browser_smoke', 'provider_canary'],
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
  const item = _row(database, `SELECT COUNT(*) execution_item_count,MAX(i.updated_at) last_evidence_at,
    SUM(CASE WHEN i.integrity_json IS NOT NULL AND i.integrity_json <> '{}' THEN 1 ELSE 0 END) integrity_detail_count
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
  const integrityDetailCount = _number(item.integrity_detail_count);
  const integrityEvidenceCount = _number(integrity.integrity_evidence_count);
  return {
    recordCount: configuredCount + plannedCount + executionCount + integrityEvidenceCount,
    configuredCount, plannedCount, executionCount, executionItemCount, integrityDetailCount,
    integrityEvidenceCount,
    lastEvidenceAt: _latest(policy.last_evidence_at, plan.last_evidence_at,
      execution.last_evidence_at, item.last_evidence_at, integrity.last_evidence_at),
    releaseFlags: [
      { name: 'DD_PROVIDER_BACKUP_POLICIES', enabled: config.features?.providerBackupPolicies === true },
      { name: 'DD_PROVIDER_BACKUP_EXECUTION', enabled: config.features?.providerBackupExecution === true },
    ],
  };
}

function _backupFacetRuntime(database, featureId, context) {
  const runtime = _backupRuntime(database, context);
  if (featureId === 'B137') return { ...runtime, recordCount: runtime.configuredCount };
  return { ...runtime, recordCount: runtime.integrityDetailCount + runtime.integrityEvidenceCount };
}

function _restoreDrillRuntime(database, context) {
  const policy = _row(database, `SELECT COUNT(*) configured_count,MAX(updated_at) last_evidence_at
    FROM provider_restore_drill_policies WHERE host_id=? AND deleted_at IS NULL`, [context.hostId]);
  const run = _row(database, `SELECT COUNT(*) run_count,MAX(updated_at) last_evidence_at,
    SUM(CASE WHEN state='succeeded' THEN 1 ELSE 0 END) succeeded_count
    FROM provider_restore_drill_runs WHERE host_id=?`, [context.hostId]);
  const configuredCount = _number(policy.configured_count);
  const runCount = _number(run.run_count);
  return {
    recordCount: configuredCount + runCount, configuredCount, runCount,
    succeededCount: _number(run.succeeded_count),
    lastEvidenceAt: _latest(policy.last_evidence_at, run.last_evidence_at),
    releaseFlags: [
      { name: 'DD_PROVIDER_RECOVERY_RESTORE', enabled: config.features?.providerRecoveryRestore === true },
      { name: 'DD_PROVIDER_RESTORE_DRILLS', enabled: config.features?.providerRestoreDrills === true },
    ],
  };
}

function _restoreDepthRuntime(database, featureId, context) {
  const releaseFlags = [{ name: 'DD_PROVIDER_RESTORE_REPLICATION_DEPTH',
    enabled: config.features?.providerRestoreReplicationDepth === true }];
  if (featureId === 'B141') {
    const catalog = _row(database, `SELECT COUNT(*) catalog_count,MAX(updated_at) last_evidence_at
      FROM provider_recovery_file_catalogs WHERE host_id=?`, [context.hostId]);
    const entry = _row(database, `SELECT COUNT(*) entry_count,MAX(c.updated_at) last_evidence_at
      FROM provider_recovery_file_entries e JOIN provider_recovery_file_catalogs c ON c.id=e.catalog_id
      WHERE c.host_id=?`, [context.hostId]);
    const plan = _row(database, `SELECT COUNT(*) plan_count,MAX(created_at) last_evidence_at
      FROM provider_restore_depth_plans WHERE host_id=? AND restore_kind IN ('file_download','file_restore')`,
    [context.hostId]);
    const catalogCount = _number(catalog.catalog_count); const entryCount = _number(entry.entry_count);
    const planCount = _number(plan.plan_count);
    return { recordCount: catalogCount + entryCount + planCount, catalogCount, entryCount, planCount,
      lastEvidenceAt: _latest(catalog.last_evidence_at, entry.last_evidence_at, plan.last_evidence_at),
      releaseFlags };
  }
  if (featureId === 'B145') {
    const policy = _row(database, `SELECT COUNT(*) configured_count,MAX(updated_at) last_evidence_at,
      SUM(CASE WHEN enabled=1 THEN 1 ELSE 0 END) enabled_count
      FROM provider_replication_policies WHERE source_host_id=? AND deleted_at IS NULL`, [context.hostId]);
    return { recordCount: _number(policy.configured_count), configuredCount: _number(policy.configured_count),
      enabledCount: _number(policy.enabled_count), lastEvidenceAt: policy.last_evidence_at || null, releaseFlags };
  }
  const restoreKind = { B142: 'instant', B143: 'differential', B144: 'cross_site_copy' }[featureId];
  const plan = _row(database, `SELECT COUNT(*) plan_count,MAX(created_at) last_evidence_at,
    SUM(CASE WHEN allowed=1 THEN 1 ELSE 0 END) allowed_count
    FROM provider_restore_depth_plans WHERE host_id=? AND restore_kind=?`, [context.hostId, restoreKind]);
  return { recordCount: _number(plan.plan_count), planCount: _number(plan.plan_count),
    allowedCount: _number(plan.allowed_count), lastEvidenceAt: plan.last_evidence_at || null, releaseFlags };
}

function _drRuntime(database, context) {
  const group = _row(database, `SELECT COUNT(*) configured_count,MAX(updated_at) last_evidence_at,
    SUM(CASE WHEN enabled=1 THEN 1 ELSE 0 END) enabled_count
    FROM provider_dr_protection_groups WHERE primary_host_id=? AND deleted_at IS NULL`, [context.hostId]);
  const member = _row(database, `SELECT COUNT(*) member_count,MAX(m.updated_at) last_evidence_at
    FROM provider_dr_group_members m JOIN provider_dr_protection_groups g ON g.id=m.group_id
    WHERE g.primary_host_id=? AND g.deleted_at IS NULL`, [context.hostId]);
  const run = _row(database, `SELECT COUNT(*) run_count,MAX(created_at) last_evidence_at,
    SUM(CASE WHEN state='succeeded' THEN 1 ELSE 0 END) succeeded_count
    FROM provider_dr_runs WHERE primary_host_id=?`, [context.hostId]);
  const configuredCount = _number(group.configured_count); const memberCount = _number(member.member_count);
  const runCount = _number(run.run_count);
  return { recordCount: configuredCount + memberCount + runCount, configuredCount, memberCount, runCount,
    enabledCount: _number(group.enabled_count), succeededCount: _number(run.succeeded_count),
    lastEvidenceAt: _latest(group.last_evidence_at, member.last_evidence_at, run.last_evidence_at),
    releaseFlags: [{ name: 'DD_PROVIDER_DR_RUNBOOKS', enabled: config.features?.providerDrRunbooks === true }] };
}

function _drFacetRuntime(database, featureId, context) {
  const releaseFlags = [{ name: 'DD_PROVIDER_DR_RUNBOOKS',
    enabled: config.features?.providerDrRunbooks === true }];
  const group = _row(database, `SELECT COUNT(*) configured_count,MAX(updated_at) last_evidence_at
    FROM provider_dr_protection_groups WHERE primary_host_id=? AND deleted_at IS NULL`, [context.hostId]);
  if (featureId === 'B150') {
    const objective = _row(database, `SELECT
      SUM(CASE WHEN rpo_max_seconds IS NOT NULL OR rto_max_seconds IS NOT NULL THEN 1 ELSE 0 END) objective_count,
      SUM(CASE WHEN compliance='met' THEN 1 ELSE 0 END) met_count,
      SUM(CASE WHEN compliance='breached' THEN 1 ELSE 0 END) breached_count,
      SUM(CASE WHEN compliance IN ('unknown','never_tested') THEN 1 ELSE 0 END) unknown_count,
      MAX(created_at) last_evidence_at FROM provider_dr_runs WHERE primary_host_id=?`, [context.hostId]);
    return { recordCount: _number(objective.objective_count), configuredCount: _number(group.configured_count),
      objectiveCount: _number(objective.objective_count), metCount: _number(objective.met_count),
      breachedCount: _number(objective.breached_count), unknownCount: _number(objective.unknown_count),
      lastEvidenceAt: _latest(group.last_evidence_at, objective.last_evidence_at), releaseFlags };
  }
  const modes = featureId === 'B147' ? ['planned_failover', 'unplanned_failover']
    : featureId === 'B148' ? ['failback'] : ['test'];
  const placeholders = modes.map(() => '?').join(',');
  const run = _row(database, `SELECT COUNT(*) run_count,MAX(created_at) last_evidence_at,
    SUM(CASE WHEN state='succeeded' THEN 1 ELSE 0 END) succeeded_count
    FROM provider_dr_runs WHERE primary_host_id=? AND runbook_mode IN (${placeholders})`,
  [context.hostId, ...modes]);
  const configuredCount = _number(group.configured_count); const runCount = _number(run.run_count);
  return { recordCount: featureId === 'B147' ? configuredCount + runCount : runCount,
    configuredCount, runCount, succeededCount: _number(run.succeeded_count), modes,
    lastEvidenceAt: _latest(group.last_evidence_at, run.last_evidence_at), releaseFlags };
}

function _securityAssuranceRuntime(database, featureId, context) {
  const releaseFlags = [{ name: 'DD_PROVIDER_SECURITY_ASSURANCE',
    enabled: config.features?.providerSecurityAssurance === true }];
  if (featureId === 'B155') {
    const provider = _row(database, `SELECT COUNT(*) configured_count,MAX(updated_at) last_evidence_at,
      SUM(CASE WHEN health_state='healthy' THEN 1 ELSE 0 END) healthy_count,
      SUM(CASE WHEN health_state IN ('degraded','unavailable') THEN 1 ELSE 0 END) unhealthy_count
      FROM provider_key_providers WHERE host_id=? AND deleted_at IS NULL`, [context.hostId]);
    return { recordCount: _number(provider.configured_count), configuredCount: _number(provider.configured_count),
      healthyCount: _number(provider.healthy_count), unhealthyCount: _number(provider.unhealthy_count),
      lastEvidenceAt: provider.last_evidence_at || null, releaseFlags };
  }
  const factPath = { B152: '$.secureBoot', B153: '$.vtpm', B154: '$.encryption',
    B156: '$.confidential' }[featureId];
  const evidence = factPath
    ? _row(database, `SELECT
      SUM(CASE WHEN json_valid(facts_json) AND json_type(facts_json, ?) IS NOT NULL THEN 1 ELSE 0 END) evidence_count,
      MAX(CASE WHEN json_valid(facts_json) AND json_type(facts_json, ?) IS NOT NULL THEN observed_at END) last_evidence_at
      FROM provider_security_evidence WHERE host_id=?`, [factPath, factPath, context.hostId])
    : _row(database, `SELECT COUNT(*) evidence_count,MAX(observed_at) last_evidence_at,
      SUM(CASE WHEN source='provider' THEN 1 ELSE 0 END) provider_reported_count,
      SUM(CASE WHEN source='imported_evidence' THEN 1 ELSE 0 END) imported_count
      FROM provider_security_evidence WHERE host_id=?`, [context.hostId]);
  return { recordCount: _number(evidence.evidence_count), evidenceCount: _number(evidence.evidence_count),
    providerReportedCount: _number(evidence.provider_reported_count),
    importedCount: _number(evidence.imported_count), lastEvidenceAt: evidence.last_evidence_at || null,
    factPath: factPath || null, releaseFlags };
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
  if (featureId === 'B137' || featureId === 'B138') {
    return _backupFacetRuntime(database, featureId, context);
  }
  if (featureId === 'B139' || featureId === 'B140') return _restoreDrillRuntime(database, context);
  if (['B141', 'B142', 'B143', 'B144', 'B145'].includes(featureId)) {
    return _restoreDepthRuntime(database, featureId, context);
  }
  if (featureId === 'B146') return _drRuntime(database, context);
  if (['B147', 'B148', 'B149', 'B150'].includes(featureId)) {
    return _drFacetRuntime(database, featureId, context);
  }
  if (['B151', 'B152', 'B153', 'B154', 'B155', 'B156'].includes(featureId)) {
    return _securityAssuranceRuntime(database, featureId, context);
  }
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
      delivery: { implementationRelease: definition.implementationRelease || IMPLEMENTATION_RELEASE,
        qualificationRelease: `v${version}`, included: true },
      schema: { state: schemaReady ? 'ready' : 'missing', tables, columns },
      runtime: { state: runtime.recordCount > 0 ? 'observed' : 'not_observed', ...runtime },
      qualificationSafety: { providerMutationsStarted: 0, networkCallsStarted: 0,
        externalCommandsStarted: 0 },
      validation: { browserSmoke: 'not_recorded', outstanding: [...definition.outstanding] },
    };
  });
  const implementationReleases = [...new Set(items.map(item => item.delivery.implementationRelease))];
  const evidence = {
    schemaVersion: '1.3', batch: { key: batch.key, label: batch.label },
    hostId, providerType: context.providerType,
    applicationVersion: version,
    implementationRelease: implementationReleases.length === 1 ? implementationReleases[0] : null,
    implementationReleases, items,
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
  FEATURE_IDS, NETWORK_BACKUP_FEATURE_IDS, RECOVERY_DEPTH_FEATURE_IDS, DR_SECURITY_FEATURE_IDS, BATCHES,
  OperationalQualificationError, qualificationForHost,
  _internals: { DEFINITIONS, _canonical, _hash, _passiveRuntime, _tableExists, _columnExists,
    _backupRuntime, _backupFacetRuntime, _restoreDrillRuntime, _restoreDepthRuntime, _drRuntime,
    _drFacetRuntime, _securityAssuranceRuntime },
};
