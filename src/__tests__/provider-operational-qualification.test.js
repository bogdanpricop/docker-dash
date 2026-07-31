'use strict';

const Database = require('better-sqlite3');
const qualification = require('../services/provider-sdk/operational-qualification');

function database() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE provider_vm_snapshots (canonical_id TEXT PRIMARY KEY);
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY);
  `);
  require('../db/migrations/106_provider_resource_identities').up(db);
  require('../db/migrations/107_provider_operations').up(db);
  require('../db/migrations/117_provider_recovery_points').up(db);
  require('../db/migrations/118_provider_backup_policies').up(db);
  require('../db/migrations/119_provider_backup_execution').up(db);
  require('../db/migrations/153_provider_inventory_views').up(db);
  require('../db/migrations/154_provider_snapshot_risk').up(db);
  require('../db/migrations/155_storage_repository_health').up(db);
  require('../db/migrations/157_provider_vm_action_schedules').up(db);
  require('../db/migrations/158_network_dependency_map').up(db);
  require('../db/migrations/159_network_mtu_assessments').up(db);
  require('../db/migrations/160_network_bond_health').up(db);
  require('../db/migrations/161_network_load_balancer_inventory').up(db);
  require('../db/migrations/163_provider_vm_nic_safety').up(db);
  require('../db/migrations/164_network_reachability_assessments').up(db);
  require('../db/migrations/156_network_intent_validation').up(db);
  require('../db/migrations/162_network_public_ip_plans').up(db);
  require('../db/migrations/165_provider_backup_control_plane').up(db);
  return db;
}

describe('provider operational qualification', () => {
  let db;
  afterEach(() => db?.close());

  it('qualifies exactly ten released features without running external work', () => {
    db = database();
    db.exec('INSERT INTO users(id) VALUES (9); INSERT INTO docker_hosts(id) VALUES (7);');
    db.prepare(`INSERT INTO provider_inventory_views
      (user_id,name,resource_type,provider_host_id,filters_json,columns_json,sort_json)
      VALUES (?,?,?,?,?,?,?)`).run(9, 'Running VMs', 'virtual-machines', 7, '{}', '[]', '{}');
    db.prepare(`INSERT INTO network_reachability_assessments
      (scope_key,protocol,destination_port,source_json,destination_json,evidence_json,summary_json,
       verdict,assessment_hash) VALUES (?,?,?,?,?,?,?,?,?)`).run('provider:7', 'tcp', 443, '{}', '{}',
      '{}', '{}', 'unknown', 'a'.repeat(64));

    const first = qualification.qualificationForHost({ id: 7, daemon_type: 'proxmox' },
      { actorId: 9, database: db });
    const second = qualification.qualificationForHost({ id: 7, daemon_type: 'proxmox' },
      { actorId: 9, database: db });

    expect(first.items.map(item => item.featureId)).toEqual([
      'B015', 'B045', 'B090', 'B096', 'B104', 'B118', 'B119', 'B120', 'B121', 'B123',
    ]);
    expect(first.summary).toEqual(expect.objectContaining({ featureCount: 10, schemaReady: 10,
      runtimeObserved: 2, executeFlagsEnabled: 0, browserSmokeRecorded: 0 }));
    expect(first.items.find(item => item.featureId === 'B015').runtime).toEqual(
      expect.objectContaining({ state: 'observed', recordCount: 1, scope: 'current-user' }));
    expect(first.items.find(item => item.featureId === 'B119').runtime).toEqual(
      expect.objectContaining({ state: 'observed', networkCallsStarted: 0,
        providerMutationsStarted: 0 }));
    expect(first.items.every(item => item.qualificationSafety.providerMutationsStarted === 0)).toBe(true);
    expect(first.items.find(item => item.featureId === 'B104').runtime.executeFlag.enabled).toBe(false);
    expect(first.evidenceHash).toBe(second.evidenceHash);
    expect(first.limitations.join(' ')).toContain('not a browser test');
  });

  it('reports missing schema and never upgrades absent evidence to success', () => {
    db = new Database(':memory:');
    const result = qualification.qualificationForHost({ id: 7, daemon_type: 'xen' },
      { actorId: 9, database: db });
    expect(result.summary).toEqual(expect.objectContaining({ schemaReady: 0, runtimeObserved: 0 }));
    expect(result.items.every(item => item.schema.state === 'missing')).toBe(true);
    expect(result.items.every(item => item.runtime.state === 'not_observed')).toBe(true);
  });

  it('qualifies exactly B124, B125 and B129-B136 from local evidence only', () => {
    db = database();
    db.exec('INSERT INTO users(id) VALUES (9); INSERT INTO docker_hosts(id) VALUES (7);');
    db.prepare(`INSERT INTO network_public_ip_lifecycle_plans
      (scope_key,provider_type,action,plan_json,blockers_json,state,plan_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?)`).run('provider:7', 'proxmox', 'allocate', '{}', '[]',
      'ready', 'b'.repeat(64), 9);
    db.prepare(`INSERT INTO network_intent_validations
      (scope_key,intent_version,intent_json,findings_json,summary_json,verdict,intent_hash,
       validation_hash,created_by) VALUES (?,?,?,?,?,?,?,?,?)`).run('provider:7', '1.0', '{}',
      '[]', '{}', 'pass', 'c'.repeat(64), 'd'.repeat(64), 9);
    db.prepare(`INSERT INTO provider_backup_repositories
      (canonical_id,host_id,provider_type,native_ref_hash,native_ref_enc,display_name,
       repository_json,observed_at) VALUES (?,?,?,?,?,?,?,?)`).run('ddr_backup_repo_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      7, 'proxmox', 'e'.repeat(64), 'encrypted', 'PBS', '{}', '2026-08-01T10:00:00.000Z');
    db.prepare(`INSERT INTO provider_backup_policies
      (id,host_id,repository_id,name,enabled,schedule_json,scope_json,consistency_json,
       retention_json,protection_json,controls_json,verification_json,policy_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('pbp_aaaaaaaa', 7,
      'ddr_backup_repo_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'Nightly', 0, '{}', '{}', '{}', '{}',
      '{}', '{}', '{}', 'f'.repeat(64), 9);
    db.prepare(`INSERT INTO provider_backup_policy_runs
      (id,policy_id,trigger_type,slot_key,state,policy_hash,plan_hash,plan_json,created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run('pbpr_aaaaaaaa', 'pbp_aaaaaaaa', 'preview', 'preview-1',
      'planned', 'f'.repeat(64), '1'.repeat(64), '{}', 9);

    const first = qualification.qualificationForHost({ id: 7, daemon_type: 'proxmox' },
      { actorId: 9, database: db, batch: 'network-backup' });
    const second = qualification.qualificationForHost({ id: 7, daemon_type: 'proxmox' },
      { actorId: 9, database: db, batch: 'network-backup' });

    expect(first.batch).toEqual({ key: 'network-backup', label: 'B124/B125/B129–B136' });
    expect(first.items.map(item => item.featureId)).toEqual([
      'B124', 'B125', 'B129', 'B130', 'B131', 'B132', 'B133', 'B134', 'B135', 'B136',
    ]);
    expect(first.summary).toEqual(expect.objectContaining({ featureCount: 10, schemaReady: 10,
      runtimeObserved: 10, executeFlagsEnabled: 0, browserSmokeRecorded: 0 }));
    expect(first.items.find(item => item.featureId === 'B124').runtime).toEqual(
      expect.objectContaining({ state: 'observed', recordCount: 1, providerMutationsStarted: 0,
        externalMutationsStarted: 0 }));
    expect(first.items.find(item => item.featureId === 'B125').runtime).toEqual(
      expect.objectContaining({ state: 'observed', recordCount: 1, providerMutationsStarted: 0 }));
    expect(first.items.find(item => item.featureId === 'B129').runtime).toEqual(
      expect.objectContaining({ configuredCount: 1, plannedCount: 1, executionCount: 0,
        releaseFlags: expect.arrayContaining([
          expect.objectContaining({ name: 'DD_PROVIDER_BACKUP_EXECUTION', enabled: false }),
        ]) }));
    expect(first.items.every(item => item.qualificationSafety.externalCommandsStarted === 0)).toBe(true);
    expect(first.evidenceHash).toBe(second.evidenceHash);
  });

  it('rejects an unknown qualification batch', () => {
    db = new Database(':memory:');
    expect(() => qualification.qualificationForHost({ id: 7 },
      { actorId: 9, database: db, batch: 'future' })).toThrow('Unknown qualification batch');
  });

  it('rejects missing host and actor identity', () => {
    db = new Database(':memory:');
    expect(() => qualification.qualificationForHost(null, { actorId: 9, database: db }))
      .toThrow('Valid provider host required');
    expect(() => qualification.qualificationForHost({ id: 7 }, { database: db }))
      .toThrow('Valid actor required');
  });
});
