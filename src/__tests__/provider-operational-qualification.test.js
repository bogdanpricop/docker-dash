'use strict';

const Database = require('better-sqlite3');
const qualification = require('../services/provider-sdk/operational-qualification');

function database() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE provider_vm_snapshots (canonical_id TEXT PRIMARY KEY);
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY);
    CREATE TABLE lifecycle_version_inventory (id INTEGER PRIMARY KEY);
    CREATE TABLE lifecycle_update_catalog (id INTEGER PRIMARY KEY);
    CREATE TABLE tracked_certificates (
      id INTEGER PRIMARY KEY,host_id INTEGER,fingerprint_sha256 TEXT,not_after TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE lifecycle_certificate_ownership (
      id INTEGER PRIMARY KEY,certificate_id INTEGER,owner TEXT,environment TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE lifecycle_certificate_renewal_jobs (
      id INTEGER PRIMARY KEY,ownership_id INTEGER,state TEXT,plan_hash TEXT,
      rollback_on_failure INTEGER,updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  require('../db/migrations/106_provider_resource_identities').up(db);
  require('../db/migrations/112_provider_artifact_catalog').up(db);
  require('../db/migrations/107_provider_operations').up(db);
  require('../db/migrations/117_provider_recovery_points').up(db);
  require('../db/migrations/118_provider_backup_policies').up(db);
  require('../db/migrations/119_provider_backup_execution').up(db);
  require('../db/migrations/120_provider_restore_drills').up(db);
  require('../db/migrations/121_provider_dr_runbooks').up(db);
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
  require('../db/migrations/166_provider_restore_replication_depth').up(db);
  require('../db/migrations/167_provider_security_assurance').up(db);
  require('../db/migrations/168_provider_security_lifecycle').up(db);
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

  it('qualifies exactly B137-B146 with mixed implementation releases and no execution', () => {
    db = database();
    db.exec('INSERT INTO users(id) VALUES (9); INSERT INTO docker_hosts(id) VALUES (7),(8);');
    const nodeId = `ddr_host_${'a'.repeat(26)}`; const storageId = `ddr_storage_${'b'.repeat(26)}`;
    for (const [id, kind, hash] of [[nodeId, 'host', '2'], [storageId, 'storage', '3']]) {
      db.prepare(`INSERT INTO provider_resource_identities
        (canonical_id,host_id,provider_type,resource_kind,native_ref_hash,native_ref_enc,identity_stability)
        VALUES (?,?,?,?,?,?,?)`).run(id, 7, 'proxmox', kind, hash.repeat(64), 'encrypted', 'stable');
    }
    const repositoryId = `ddr_backup_repo_${'c'.repeat(26)}`;
    const pointId = `ddr_rp_${'d'.repeat(26)}`;
    db.prepare(`INSERT INTO provider_backup_repositories
      (canonical_id,host_id,provider_type,native_ref_hash,native_ref_enc,display_name,
       repository_json,observed_at) VALUES (?,?,?,?,?,?,?,?)`).run(repositoryId, 7, 'proxmox',
      '4'.repeat(64), 'encrypted', 'PBS', '{}', '2026-08-01T10:00:00.000Z');
    db.prepare(`INSERT INTO provider_recovery_points
      (canonical_id,host_id,provider_type,repository_id,native_ref_hash,native_ref_enc,
       recovery_point_json,observed_at) VALUES (?,?,?,?,?,?,?,?)`).run(pointId, 7, 'proxmox',
      repositoryId, '5'.repeat(64), 'encrypted', '{}', '2026-08-01T10:00:00.000Z');
    db.prepare(`INSERT INTO provider_backup_policies
      (id,host_id,repository_id,name,enabled,schedule_json,scope_json,consistency_json,
       retention_json,protection_json,controls_json,verification_json,policy_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('pbp_bbbbbbbb', 7, repositoryId, 'Encrypted', 0,
      '{}', '{}', '{}', '{}', '{}', '{}', '{}', '6'.repeat(64), 9);
    db.prepare(`INSERT INTO provider_restore_drill_policies
      (id,host_id,backup_policy_id,name,enabled,schedule_json,target_node_id,target_storage_id,
       assertions_json,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`).run('pdrp_aaaaaaaa', 7,
      'pbp_bbbbbbbb', 'Weekly drill', 0, '{}', nodeId, storageId, '{}', 9);
    db.prepare(`INSERT INTO provider_recovery_file_catalogs
      (id,host_id,recovery_point_id,state,source,entry_count,manifest_hash,observed_at,created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run('prfc_aaaaaaaa', 7, pointId, 'complete',
      'imported_evidence', 1, '7'.repeat(64), '2026-08-01T10:00:00.000Z', 9);
    db.prepare(`INSERT INTO provider_recovery_file_entries
      (catalog_id,path,parent_path,name,entry_type,size_bytes) VALUES (?,?,?,?,?,?)`)
      .run('prfc_aaaaaaaa', '/etc/app.conf', '/etc', 'app.conf', 'file', 12);
    const insertPlan = db.prepare(`INSERT INTO provider_restore_depth_plans
      (id,host_id,recovery_point_id,restore_kind,request_json,evidence_json,plan_hash,
       allowed,created_by,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    for (const [index, kind] of ['file_download', 'instant', 'differential', 'cross_site_copy'].entries()) {
      insertPlan.run(`prdp_${String(index + 1).repeat(8)}`, 7, pointId, kind, '{}', '{}',
        ['8', '9', 'a', 'b'][index].repeat(64), 0, 9, '2026-08-01T10:05:00.000Z');
    }
    db.prepare(`INSERT INTO provider_replication_policies
      (id,source_host_id,target_host_id,name,mode,enabled,rpo_target_seconds,workload_ids_json,
       storage_mappings_json,capability_json,policy_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run('prpl_aaaaaaaa', 7, 8, 'Async DR', 'async', 0,
      900, '[]', '[]', '{}', 'c'.repeat(64), 9);
    db.prepare(`INSERT INTO provider_dr_protection_groups
      (id,primary_host_id,recovery_host_id,name,strategy,enabled,rpo_target_seconds,
       rto_target_seconds,created_by) VALUES (?,?,?,?,?,?,?,?,?)`).run('pdrg_aaaaaaaa', 7, 8,
      'Payments DR', 'backup_restore', 0, 3600, 900, 9);

    const first = qualification.qualificationForHost({ id: 7, daemon_type: 'proxmox' },
      { actorId: 9, database: db, batch: 'recovery-depth' });
    const second = qualification.qualificationForHost({ id: 7, daemon_type: 'proxmox' },
      { actorId: 9, database: db, batch: 'recovery-depth' });

    expect(first.batch).toEqual({ key: 'recovery-depth', label: 'B137–B146' });
    expect(first.items.map(item => item.featureId)).toEqual([
      'B137', 'B138', 'B139', 'B140', 'B141', 'B142', 'B143', 'B144', 'B145', 'B146',
    ]);
    expect(first.implementationRelease).toBeNull();
    expect(first.implementationReleases).toEqual(['v8.80.0', 'v8.81.0']);
    expect(first.items.find(item => item.featureId === 'B137').delivery.implementationRelease)
      .toBe('v8.80.0');
    expect(first.items.find(item => item.featureId === 'B139').delivery.implementationRelease)
      .toBe('v8.81.0');
    expect(first.summary).toEqual(expect.objectContaining({ featureCount: 10, schemaReady: 10,
      runtimeObserved: 9, executeFlagsEnabled: 0, browserSmokeRecorded: 0 }));
    expect(first.items.find(item => item.featureId === 'B138').runtime).toEqual(
      expect.objectContaining({ state: 'not_observed', recordCount: 0, integrityEvidenceCount: 0 }));
    expect(first.items.find(item => item.featureId === 'B139').runtime).toEqual(
      expect.objectContaining({ configuredCount: 1, runCount: 0, succeededCount: 0 }));
    expect(first.items.find(item => item.featureId === 'B141').runtime).toEqual(
      expect.objectContaining({ catalogCount: 1, entryCount: 1, planCount: 1 }));
    expect(first.items.find(item => item.featureId === 'B145').runtime).toEqual(
      expect.objectContaining({ configuredCount: 1, enabledCount: 0 }));
    expect(first.items.find(item => item.featureId === 'B146').runtime).toEqual(
      expect.objectContaining({ configuredCount: 1, enabledCount: 0, runCount: 0 }));
    expect(first.items.every(item => Object.values(item.qualificationSafety)
      .every(value => value === 0))).toBe(true);
    expect(first.evidenceHash).toBe(second.evidenceHash);
  });

  it('qualifies exactly B147-B156 with strict DR and security evidence facets', () => {
    db = database();
    db.exec('INSERT INTO users(id) VALUES (9); INSERT INTO docker_hosts(id) VALUES (7),(8);');
    const vmId = `ddr_vm_${'a'.repeat(26)}`;
    db.prepare(`INSERT INTO provider_resource_identities
      (canonical_id,host_id,provider_type,resource_kind,native_ref_hash,native_ref_enc,identity_stability)
      VALUES (?,?,?,?,?,?,?)`).run(vmId, 7, 'proxmox', 'virtualMachine', '1'.repeat(64),
      'encrypted', 'stable');
    db.prepare(`INSERT INTO provider_dr_protection_groups
      (id,primary_host_id,recovery_host_id,name,strategy,enabled,rpo_target_seconds,
       rto_target_seconds,created_by) VALUES (?,?,?,?,?,?,?,?,?)`).run('pdrg_bbbbbbbb', 7, 8,
      'Payments DR', 'backup_restore', 0, 3600, 900, 9);
    db.prepare(`INSERT INTO provider_dr_group_members
      (group_id,sequence,vm_id,vm_name,boot_stage,depends_on_json,recovery_source,recovery_target_json)
      VALUES (?,?,?,?,?,?,?,?)`).run('pdrg_bbbbbbbb', 0, vmId, 'payments', 1, '[]',
      'backup', '{}');
    const insertRun = db.prepare(`INSERT INTO provider_dr_runs
      (id,group_id,primary_host_id,group_revision,runbook_mode,state,plan_hash,evidence_json,
       evidence_hash,compliance,rpo_max_seconds,rto_max_seconds,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const [index, mode] of ['planned_failover', 'failback', 'test'].entries()) {
      insertRun.run(`pdrun_${String(index + 2).repeat(8)}`, 'pdrg_bbbbbbbb', 7, 1, mode,
        'succeeded', String(index + 3).repeat(64), '{}', String(index + 6).repeat(64),
        'met', 300 + index, 120 + index, 9);
    }
    db.prepare(`INSERT INTO provider_security_evidence
      (id,host_id,resource_kind,resource_id,resource_name,pack_key,pack_version,source,
       facts_json,evidence_hash,observed_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('psec_cccccccc', 7, 'endpoint', 'endpoint:7', 'pve-primary', 'proxmox-security',
        '1.0.0', 'imported_evidence', JSON.stringify({
          secureBoot: { capable: true, enabled: true },
          vtpm: { present: true, version: '2.0', state: 'ready' },
          encryption: { disks: { state: 'full', total: 1, encrypted: 1 },
            migration: 'encrypted', backups: 'encrypted', savedState: 'encrypted' },
          confidential: { enabled: false, supportedModes: ['sev_snp'] },
        }), '9'.repeat(64), '2026-08-01T10:00:00.000Z', 9);
    db.prepare(`INSERT INTO provider_key_providers
      (id,host_id,name,provider_kind,endpoint_origin,secret_ref,health_state,health_observed_at,
       affected_resource_ids_json,evidence_hash,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run('pkpr_dddddddd', 7, 'Primary KMS', 'external_kms', 'https://kms.example.test',
        'vault://virtualization/kms', 'healthy', '2026-08-01T10:00:00.000Z', '[]',
        'a'.repeat(64), 9);

    const first = qualification.qualificationForHost({ id: 7, daemon_type: 'proxmox' },
      { actorId: 9, database: db, batch: 'dr-security' });
    const second = qualification.qualificationForHost({ id: 7, daemon_type: 'proxmox' },
      { actorId: 9, database: db, batch: 'dr-security' });

    expect(first.batch).toEqual({ key: 'dr-security', label: 'B147–B156' });
    expect(first.items.map(item => item.featureId)).toEqual([
      'B147', 'B148', 'B149', 'B150', 'B151', 'B152', 'B153', 'B154', 'B155', 'B156',
    ]);
    expect(first.implementationRelease).toBeNull();
    expect(first.implementationReleases).toEqual(['v8.81.0', 'v8.82.0']);
    expect(first.summary).toEqual(expect.objectContaining({ featureCount: 10, schemaReady: 10,
      runtimeObserved: 10, browserSmokeRecorded: 0 }));
    expect(first.items.find(item => item.featureId === 'B147').runtime).toEqual(
      expect.objectContaining({ configuredCount: 1, runCount: 1, succeededCount: 1 }));
    expect(first.items.find(item => item.featureId === 'B148').runtime).toEqual(
      expect.objectContaining({ recordCount: 1, modes: ['failback'] }));
    expect(first.items.find(item => item.featureId === 'B149').runtime).toEqual(
      expect.objectContaining({ recordCount: 1, modes: ['test'] }));
    expect(first.items.find(item => item.featureId === 'B150').runtime).toEqual(
      expect.objectContaining({ objectiveCount: 3, metCount: 3 }));
    expect(first.items.find(item => item.featureId === 'B151').runtime).toEqual(
      expect.objectContaining({ evidenceCount: 1, importedCount: 1 }));
    expect(first.items.find(item => item.featureId === 'B155').runtime).toEqual(
      expect.objectContaining({ configuredCount: 1, healthyCount: 1 }));
    expect(first.items.every(item => Object.values(item.qualificationSafety)
      .every(value => value === 0))).toBe(true);
    expect(first.evidenceHash).toBe(second.evidenceHash);
  });

  it('qualifies exactly B157-B166 with strict planning and lifecycle evidence facets', () => {
    db = database();
    db.exec(`INSERT INTO users(id) VALUES (9); INSERT INTO docker_hosts(id) VALUES (7);
      INSERT INTO lifecycle_version_inventory(id) VALUES (1);
      INSERT INTO lifecycle_update_catalog(id) VALUES (2);`);
    const hostResourceId = `ddr_host_${'b'.repeat(26)}`;
    const artifactId = `dda_art_${'c'.repeat(26)}`;
    db.prepare(`INSERT INTO provider_resource_identities
      (canonical_id,host_id,provider_type,resource_kind,native_ref_hash,native_ref_enc,identity_stability)
      VALUES (?,?,?,?,?,?,?)`).run(hostResourceId, 7, 'proxmox', 'host', '1'.repeat(64),
      'encrypted', 'stable');
    db.prepare(`INSERT INTO provider_artifact_catalog
      (canonical_id,host_id,provider_type,artifact_kind,native_ref_hash,native_ref_enc,
       display_name,artifact_json,observed_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(artifactId, 7,
      'proxmox', 'vmTemplate', '2'.repeat(64), 'encrypted', 'trusted-template', '{}',
      '2026-08-01T10:00:00.000Z');
    db.prepare(`INSERT INTO provider_confidential_provisioning_plans
      (id,host_id,artifact_id,target_host_id,confidential_mode,request_json,evidence_json,
       plan_hash,allowed,created_by,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run('pcvp_aaaaaaaa', 7, artifactId, hostResourceId, 'sev_snp', '{}', '{}',
        '3'.repeat(64), 0, 9, '2026-08-01T10:05:00.000Z');
    db.prepare(`INSERT INTO provider_security_evidence
      (id,host_id,resource_kind,resource_id,resource_name,pack_key,pack_version,source,
       facts_json,evidence_hash,observed_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('psec_bbbbbbbb', 7, 'endpoint', 'endpoint:7', 'pve-primary', 'proxmox-security',
        '1.0.0', 'imported_evidence', JSON.stringify({
          hardening: { baselineKey: 'cis-pve-v1', baselineVersion: '1.0.0',
            checks: [], summary: { pass: 1, fail: 0, unknown: 0 } },
          virtualHardware: { baselineKey: 'vm-security-v1', baselineVersion: '1.0.0',
            firmware: 'uefi', bootOrder: ['disk'], legacySettings: [], devices: [],
            summary: { compliant: 1, noncompliant: 0, unknown: 0, unsafeLegacySettingCount: 0 } },
          transport: { services: [] },
          certificateTrust: { certificates: [] },
        }), '4'.repeat(64), '2026-08-01T10:00:00.000Z', 9);
    db.exec(`INSERT INTO tracked_certificates
      (id,host_id,fingerprint_sha256,not_after) VALUES (1,7,'${'5'.repeat(64)}','2027-08-01T00:00:00Z');
      INSERT INTO lifecycle_certificate_ownership
      (id,certificate_id,owner,environment) VALUES (2,1,'platform','production');
      INSERT INTO lifecycle_certificate_renewal_jobs
      (id,ownership_id,state,plan_hash,rollback_on_failure) VALUES (3,2,'succeeded','${'6'.repeat(64)}',1);`);
    db.prepare(`INSERT INTO provider_security_findings
      (id,host_id,inventory_id,advisory_catalog_id,resource_kind,resource_id,resource_name,
       advisory_id,cve_ids_json,severity,priority_score,confidence,exposure_json,
       match_evidence_json,evidence_hash,state,observed_at,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('psfd_cccccccc', 7, 1, 2, 'endpoint',
      'endpoint:7', 'pve-primary', 'ADV-2026-001', '["CVE-2026-12345"]', 'critical', 95,
      'high', '{}', '{}', '7'.repeat(64), 'planned', '2026-08-01T10:00:00.000Z', 9);
    db.prepare(`INSERT INTO provider_security_finding_exceptions
      (id,finding_id,owner,reason,expires_at,compensating_controls_json,exception_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?)`).run('psfx_dddddddd', 'psfd_cccccccc', 'security', 'Change freeze',
      '2099-08-01T00:00:00.000Z', '["segmentation"]', '8'.repeat(64), 9);
    db.prepare(`INSERT INTO provider_security_remediation_plans
      (id,finding_id,action_key,risk,steps_json,downtime_seconds,dependencies_json,rollback_json,
       dry_run_json,plan_hash,allowed,state,expires_at,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('psrp_eeeeeeee', 'psfd_cccccccc',
      'apply_security_update', 'moderate', '[]', 60, '[]', '{}', '{"state":"pass"}',
      '9'.repeat(64), 1, 'planned', '2099-08-01T00:00:00.000Z', 9);

    const first = qualification.qualificationForHost({ id: 7, daemon_type: 'proxmox' },
      { actorId: 9, database: db, batch: 'security-lifecycle' });
    const second = qualification.qualificationForHost({ id: 7, daemon_type: 'proxmox' },
      { actorId: 9, database: db, batch: 'security-lifecycle' });

    expect(first.batch).toEqual({ key: 'security-lifecycle', label: 'B157–B166' });
    expect(first.items.map(item => item.featureId)).toEqual([
      'B157', 'B158', 'B159', 'B160', 'B161', 'B162', 'B163', 'B164', 'B165', 'B166',
    ]);
    expect(first.implementationRelease).toBeNull();
    expect(first.implementationReleases).toEqual(['v8.82.0', 'v8.83.0']);
    expect(first.summary).toEqual(expect.objectContaining({ featureCount: 10, schemaReady: 10,
      runtimeObserved: 10, browserSmokeRecorded: 0 }));
    expect(first.items.find(item => item.featureId === 'B157').runtime).toEqual(
      expect.objectContaining({ planCount: 1, allowedCount: 0 }));
    expect(first.items.find(item => item.featureId === 'B162').runtime).toEqual(
      expect.objectContaining({ certificateCount: 1, ownershipCount: 1, renewalCount: 1,
        succeededCount: 1 }));
    expect(first.items.find(item => item.featureId === 'B163').runtime).toEqual(
      expect.objectContaining({ recordCount: 1, cveFindingCount: 1 }));
    expect(first.items.find(item => item.featureId === 'B165').runtime).toEqual(
      expect.objectContaining({ activeExceptionCount: 1 }));
    expect(first.items.find(item => item.featureId === 'B166').runtime).toEqual(
      expect.objectContaining({ planCount: 1, allowedCount: 1 }));
    expect(first.items.every(item => Object.values(item.qualificationSafety)
      .every(value => value === 0))).toBe(true);
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
