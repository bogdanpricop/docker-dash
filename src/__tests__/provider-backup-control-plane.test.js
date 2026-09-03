'use strict';

jest.mock('../services/audit', () => ({ log: jest.fn() }));

const Database = require('better-sqlite3');
const identityMigration = require('../db/migrations/106_provider_resource_identities');
const operationMigration = require('../db/migrations/107_provider_operations');
const recoveryMigration = require('../db/migrations/117_provider_recovery_points');
const policyMigration = require('../db/migrations/118_provider_backup_policies');
const executionMigration = require('../db/migrations/119_provider_backup_execution');
const controlPlaneMigration = require('../db/migrations/165_provider_backup_control_plane');
const control = require('../services/provider-operations/backup-control-plane');

function database() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY,username TEXT);
    INSERT INTO users VALUES (9,'admin');
    CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY,name TEXT,daemon_type TEXT,is_active INTEGER);
    INSERT INTO docker_hosts VALUES (7,'pve-a','proxmox',1);`);
  identityMigration.up(db); operationMigration.up(db); recoveryMigration.up(db);
  policyMigration.up(db); executionMigration.up(db); controlPlaneMigration.up(db);
  return db;
}

function policy(overrides = {}) {
  return {
    id: `pbp_${'a'.repeat(26)}`, hostId: 7, repositoryId: `ddr_repo_${'b'.repeat(26)}`,
    providerType: 'proxmox', backupMode: 'incremental',
    scope: { exclusions: { workloadIds: [], labels: {}, diskSelectors: [], pathSelectors: [] } },
    consistency: { requested: 'crash', fallback: 'fail', preFreezeHookRef: null, postThawHookRef: null },
    retention: { strategy: 'portable_newest', keepLast: 3, daily: 7, weekly: 4, monthly: 12, yearly: 3 },
    protection: { encryption: { mode: 'required', algorithm: 'provider-native', keyReference: 'vault/pbs' },
      immutability: { mode: 'required', minimumLockDays: 30 } },
    controls: { maxConcurrent: 2, bandwidthLimitMbps: 100,
      limits: { global: 16, provider: 8, host: 4, repository: 2 },
      bandwidthWindows: [{ site: 'dc-a', link: null, start: '22:00', end: '06:00',
        days: [], timezone: 'UTC', limitMbps: 25 }] },
    verification: { afterBackup: true, requiredMethods: ['metadata', 'checksum', 'chain'] },
    ...overrides,
  };
}

describe('provider backup R5a control plane', () => {
  it('applies migration 165 idempotently and keeps evidence columns additive', () => {
    const db = database();
    try {
      expect(() => controlPlaneMigration.up(db)).not.toThrow();
      const executionColumns = db.prepare('PRAGMA table_info(provider_backup_executions)').all().map(row => row.name);
      const itemColumns = db.prepare('PRAGMA table_info(provider_backup_execution_items)').all().map(row => row.name);
      expect(executionColumns).toContain('contract_json');
      expect(itemColumns).toEqual(expect.arrayContaining(['admission_json', 'integrity_json']));
    } finally { db.close(); }
  });

  it('builds an immutable B129-B138 execution contract without provider-native references', () => {
    const value = control.buildContract({ id: 7, daemon_type: 'proxmox' }, policy(), {
      planHash: 'c'.repeat(64), scope: { workloads: [{ id: `ddr_vm_${'d'.repeat(26)}`,
        site: 'dc-a', owner: 'payments', classification: 'critical' }] },
      retention: { protectedCount: 3, candidateCount: 2, mutationAuthorized: false },
    }, { capability: { state: 'conditional', reason: null } });
    expect(value).toEqual(expect.objectContaining({ backupMode: 'incremental',
      contractHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      retention: expect.objectContaining({ mutationAuthorized: false }),
      verification: expect.objectContaining({ requiredMethods: ['metadata', 'checksum', 'chain'] }) }));
    expect(JSON.stringify(value)).not.toContain('OpaqueRef');
  });

  it('applies the strictest global/provider/host/repository/policy admission limit', () => {
    const db = database();
    try {
      const vmId = `ddr_vm_${'d'.repeat(26)}`; const repositoryId = `ddr_repo_${'b'.repeat(26)}`;
      db.prepare(`INSERT INTO provider_resource_identities
        (canonical_id,host_id,provider_type,resource_kind,native_ref_hash,native_ref_enc,identity_stability)
        VALUES (?,?,?,?,?,?,?)`).run(vmId, 7, 'proxmox', 'virtualMachine', 'e'.repeat(64), 'enc', 'stable');
      db.prepare(`INSERT INTO provider_backup_repositories
        (canonical_id,host_id,provider_type,native_ref_hash,native_ref_enc,display_name,repository_json,observed_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(repositoryId, 7, 'proxmox', 'f'.repeat(64), 'enc', 'PBS', '{}', new Date().toISOString());
      db.prepare(`INSERT INTO provider_backup_policies
        (id,host_id,repository_id,name,enabled,mode,schedule_json,scope_json,consistency_json,retention_json,
         protection_json,controls_json,verification_json,policy_hash,created_by)
        VALUES (?,?,?,?,0,'plan_only','{}','{}','{}','{}','{}','{}','{}',?,9)`).run(policy().id, 7, repositoryId, 'R5a', '1'.repeat(64));
      const runId = `pbpr_${'2'.repeat(26)}`; const executionId = `pbex_${'3'.repeat(26)}`;
      db.prepare(`INSERT INTO provider_backup_policy_runs
        (id,policy_id,trigger_type,slot_key,state,policy_hash,plan_hash,plan_json)
        VALUES (?,?,'manual','slot','planned',?,?,'{}')`).run(runId, policy().id, '1'.repeat(64), '4'.repeat(64));
      db.prepare(`INSERT INTO provider_backup_executions
        (id,policy_id,plan_run_id,trigger_type,state,plan_hash,idempotency_key_hash,request_hash)
        VALUES (?,?,?,'manual','running',?,?,?)`).run(executionId, policy().id, runId,
        '4'.repeat(64), '5'.repeat(64), '6'.repeat(64));
      db.prepare(`INSERT INTO provider_backup_execution_items
        (id,execution_id,workload_id,baseline_hash,state) VALUES (?,?,?,?, 'running')`)
        .run(`pbei_${'7'.repeat(26)}`, executionId, vmId, '8'.repeat(64));
      const result = control.admission(db, policy({ controls: { ...policy().controls,
        maxConcurrent: 1, limits: { global: 5, provider: 5, host: 5, repository: 5 } } }));
      expect(result.allowed).toBe(false);
      expect(result.capacity).toBe(0);
      expect(result.constrainedBy).toContain('policy');
    } finally { db.close(); }
  });

  it('selects the most restrictive matching bandwidth window', () => {
    const result = control.bandwidth(policy(), { site: 'dc-a' }, new Date('2026-07-30T23:00:00Z'));
    expect(result).toEqual(expect.objectContaining({ limitMbps: 25, source: 'window' }));
  });

  it('verifies metadata/checksum/chain plus encryption and immutable lock evidence', () => {
    const evidence = control.evaluateIntegrity({
      id: `ddr_rp_${'9'.repeat(26)}`, observedAt: '2026-07-30T23:00:00Z', createdAt: '2026-07-30T22:00:00Z',
      repository: { id: `ddr_repo_${'b'.repeat(26)}` }, workload: { id: `ddr_vm_${'d'.repeat(26)}` },
      backup: { encrypted: true }, retention: { immutableUntil: '2026-09-01T00:00:00Z' },
      verification: { state: 'verified', methods: { checksum: 'verified', chain: 'verified' } },
    }, policy(), new Date('2026-07-30T23:00:00Z'));
    expect(evidence.state).toBe('verified');
    expect(evidence.methods).toEqual({ metadata: 'verified', checksum: 'verified', chain: 'verified' });
    expect(evidence.protection).toEqual({ encryption: 'verified', immutability: 'verified' });
    expect(evidence.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('fails closed when required chain or protection evidence fails', () => {
    const evidence = control.evaluateIntegrity({ id: `ddr_rp_${'9'.repeat(26)}`,
      repository: { id: `ddr_repo_${'b'.repeat(26)}` }, workload: { id: `ddr_vm_${'d'.repeat(26)}` },
      createdAt: '2026-07-30T22:00:00Z', backup: { encrypted: false }, retention: {},
      verification: { methods: { checksum: 'verified', chain: 'failed' } },
    }, policy(), new Date('2026-07-30T23:00:00Z'));
    expect(evidence.state).toBe('failed');
    expect(evidence.methods.chain).toBe('failed');
    expect(evidence.protection.encryption).toBe('failed');
  });
});
