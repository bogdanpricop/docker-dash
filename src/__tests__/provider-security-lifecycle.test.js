'use strict';

jest.mock('../config', () => ({ features: {
  providerSecurityLifecycle: true, providerSecurityLowRiskRemediation: false,
} }));
jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('inject database'); }) }));

const Database = require('better-sqlite3');
const assuranceMigration = require('../db/migrations/167_provider_security_assurance');
const lifecycleMigration = require('../db/migrations/168_provider_security_lifecycle');
const service = require('../services/provider-sdk/security-lifecycle');

const host = { id: 7, name: 'pve-primary', daemon_type: 'proxmox' };
const vmId = `ddr_vm_${'a'.repeat(26)}`;

describe('provider security advisory and remediation lifecycle', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY);
      CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY,name TEXT,daemon_type TEXT,is_active INTEGER);
      CREATE TABLE provider_resource_identities (
        canonical_id TEXT PRIMARY KEY,host_id INTEGER,resource_kind TEXT
      );
      CREATE TABLE provider_resource_snapshots (
        canonical_id TEXT PRIMARY KEY,display_name TEXT,observed_at TEXT
      );
      CREATE TABLE provider_artifact_catalog (
        canonical_id TEXT PRIMARY KEY,host_id INTEGER,display_name TEXT
      );
      CREATE TABLE lifecycle_version_inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,provider_host_id INTEGER NOT NULL,component_type TEXT NOT NULL,
        vendor TEXT NOT NULL,product TEXT NOT NULL,version TEXT NOT NULL,build TEXT,source TEXT NOT NULL,
        evidence_hash TEXT NOT NULL,observed_at TEXT NOT NULL,created_by INTEGER,created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(provider_host_id,component_type,vendor,product)
      );
      CREATE TABLE lifecycle_update_catalog (
        id INTEGER PRIMARY KEY AUTOINCREMENT,vendor TEXT NOT NULL,product TEXT NOT NULL,
        advisory_id TEXT NOT NULL,title TEXT NOT NULL,update_kind TEXT NOT NULL,target_version TEXT,
        severity TEXT NOT NULL,published_at TEXT NOT NULL,source_url TEXT NOT NULL,source_digest TEXT NOT NULL,
        metadata_json TEXT NOT NULL,ingested_by INTEGER,ingested_at TEXT DEFAULT (datetime('now')),
        UNIQUE(vendor,product,advisory_id)
      );
      INSERT INTO users VALUES (9);
      INSERT INTO docker_hosts VALUES (7,'pve-primary','proxmox',1),(8,'other','proxmox',1);
      INSERT INTO provider_resource_identities VALUES ('${vmId}',7,'virtualMachine');
      INSERT INTO provider_resource_snapshots VALUES ('${vmId}','payments','2026-07-31T10:00:00Z');
      INSERT INTO lifecycle_version_inventory
        (provider_host_id,component_type,vendor,product,version,build,source,evidence_hash,observed_at,created_by)
        VALUES (7,'control_plane','Acme','HyperCore','9.2.1','build-42','provider','${'b'.repeat(64)}',
          '2026-07-31T10:00:00Z',9);
    `);
    assuranceMigration.up(db); lifecycleMigration.up(db);
  });

  afterEach(() => db.close());

  function options(extra = {}) {
    return { database: db, enabled: true, canOperate: true, createdBy: 9, ...extra };
  }
  function advisory(id, affectedVersions, affectedResourceIds = [vmId]) {
    db.prepare(`INSERT INTO lifecycle_update_catalog
      (vendor,product,advisory_id,title,update_kind,severity,published_at,source_url,source_digest,
        metadata_json,ingested_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('Acme', 'HyperCore', id,
      'Security update', 'advisory', 'critical', '2026-07-30T00:00:00Z',
      'https://security.acme.example/advisories/1', 'c'.repeat(64), JSON.stringify({ securityAdvisory: {
        cveIds: ['CVE-2026-12345'], cvss: 9.8, affectedVersions, affectedBuilds: [],
        fixedVersion: '9.2.2', affectedResourceIds,
      } }), 9);
  }
  function evidence() {
    db.prepare(`INSERT INTO provider_security_evidence
      (id,host_id,resource_kind,resource_id,resource_name,pack_key,pack_version,source,facts_json,
        evidence_hash,observed_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      `psec_${'d'.repeat(26)}`, 7, 'virtualMachine', vmId, 'payments', 'proxmox-security',
      '1.0.0', 'provider', JSON.stringify({ exposure: { criticality: 'critical',
        reachability: 'internet', protections: ['waf'] } }), 'e'.repeat(64),
      '2026-07-31T10:00:00Z', 9);
  }

  it('creates findings only for exact official-catalog version/build matches', () => {
    evidence(); advisory('ACME-2026-001', ['9.2.1']); advisory('ACME-2026-002', ['9.2.x']);
    const result = service.correlate(host, options());
    expect(result).toEqual(expect.objectContaining({ matched: 1, skipped: 1,
      source: 'official_catalog', networkCallsStarted: 0, packagesInstalled: 0 }));
    expect(result.findings[0]).toEqual(expect.objectContaining({ advisoryId: 'ACME-2026-001',
      cveIds: ['CVE-2026-12345'], priorityScore: 100, confidence: 'high', state: 'open' }));
    expect(result.findings[0].matchEvidence).toEqual(expect.objectContaining({
      versionMatch: true, buildMatch: false, fixedVersion: '9.2.2' }));
  });

  it('requires owned, expiring exceptions and blocks planning while one is active', () => {
    advisory('ACME-2026-001', ['9.2.1']);
    const finding = service.correlate(host, options()).findings[0];
    const excepted = service.createException(host, finding.id, { owner: 'platform-security',
      reason: 'Vendor hotfix is in qualification',
      expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      compensatingControls: ['Restrict management access', 'Monitor provider audit events'],
    }, options());
    expect(excepted).toEqual(expect.objectContaining({ state: 'excepted', exception: expect.objectContaining({
      owner: 'platform-security', exceptionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }) }));
    const blocked = service.planRemediation(host, finding.id, { actionKey: 'disable_legacy_protocol',
      steps: ['Capture current transport settings', 'Disable TLS 1.0'], downtimeSeconds: 0,
      dependencies: [], rollback: { strategy: 'Restore captured transport settings', verified: true },
      dryRun: { passed: true, evidence: 'Read-only provider validation passed' },
    }, options());
    expect(blocked).toEqual(expect.objectContaining({ allowed: false, state: 'blocked',
      executionAuthorized: false }));
    service.revokeException(host, finding.id, excepted.exception.id, options());
    const ready = service.planRemediation(host, finding.id, { actionKey: 'remove_legacy_device',
      steps: ['Capture hardware', 'Remove floppy device'], downtimeSeconds: 0,
      dependencies: [{ id: 'vm-stopped', passed: true, evidence: 'VM is stopped' }],
      rollback: { strategy: 'Reattach captured device', verified: true },
      dryRun: { passed: true, evidence: 'Reconfiguration dry-run passed' },
    }, options());
    expect(ready).toEqual(expect.objectContaining({ allowed: true, risk: 'low',
      state: 'planned', executionAuthorized: false }));
  });

  it('executes low-risk work only after flag, typed confirmation, canary and verification', async () => {
    advisory('ACME-2026-001', ['9.2.1']); const finding = service.correlate(host, options()).findings[0];
    const plan = service.planRemediation(host, finding.id, { actionKey: 'disable_legacy_protocol',
      steps: ['Disable TLS 1.0'], downtimeSeconds: 0, dependencies: [],
      rollback: { strategy: 'Restore protocol configuration', verified: true },
      dryRun: { passed: true, evidence: 'Dry-run passed' },
    }, options());
    await expect(service.executeLowRisk(host, plan.id, {}, options()))
      .rejects.toMatchObject({ code: 'PROVIDER_SECURITY_REMEDIATION_DISABLED' });
    const adapter = jest.fn(async ({ phase }) => ({
      canary: { ready: true, providerMutationsStarted: false },
      apply: { operationId: 'provider-task-1' }, verify: { verified: true },
    }[phase]));
    const run = await service.executeLowRisk(host, plan.id, {
      planHash: plan.planHash, confirmation: `EXECUTE SECURITY PLAN ${plan.id}`,
      adapterKey: 'proxmox.protocol',
    }, options({ automationEnabled: true, remediationAdapters: { 'proxmox.protocol': adapter } }));
    expect(run).toEqual(expect.objectContaining({ state: 'succeeded', providerMutationsStarted: true }));
    expect(adapter.mock.calls.map(call => call[0].phase)).toEqual(['canary', 'apply', 'verify']);
    expect(service.overview(host, options()).findings[0].state).toBe('remediated');
  });

  it('rolls back a started remediation when post-read verification fails', async () => {
    advisory('ACME-2026-001', ['9.2.1']); const finding = service.correlate(host, options()).findings[0];
    const plan = service.planRemediation(host, finding.id, { actionKey: 'remove_legacy_device',
      steps: ['Remove floppy device'], downtimeSeconds: 0, dependencies: [],
      rollback: { strategy: 'Reattach floppy device', verified: true },
      dryRun: { passed: true, evidence: 'Dry-run passed' },
    }, options());
    const adapter = jest.fn(async ({ phase }) => ({
      canary: { ready: true, providerMutationsStarted: false }, apply: { operationId: 'task-2' },
      verify: { verified: false }, rollback: { rolledBack: true },
    }[phase]));
    const run = await service.executeLowRisk(host, plan.id, { planHash: plan.planHash,
      confirmation: `EXECUTE SECURITY PLAN ${plan.id}`, adapterKey: 'proxmox.hardware',
    }, options({ automationEnabled: true, remediationAdapters: { 'proxmox.hardware': adapter } }));
    expect(run).toEqual(expect.objectContaining({ state: 'failed', providerMutationsStarted: true,
      evidence: expect.objectContaining({ rollback: { rolledBack: true } }) }));
    expect(adapter.mock.calls.map(call => call[0].phase)).toEqual(['canary', 'apply', 'verify', 'rollback']);
    expect(service.overview(host, options()).findings[0].state).toBe('open');
  });

  it('rejects inline credentials and stores only document/reference hashes', () => {
    const invalid = service.validateSecretReferences(host, { documentKind: 'manifest', document: {
      services: { app: { environment: [{ name: 'DATABASE_PASSWORD', value: 'inline-value' }] } },
    } }, options());
    expect(invalid).toEqual(expect.objectContaining({ state: 'invalid', documentStored: false,
      findings: expect.arrayContaining([expect.objectContaining({ code: 'INLINE_SECRET_VALUE' })]) }));
    const valid = service.validateSecretReferences(host, { documentKind: 'template', document: {
      passwordRef: 'vault://docker-dash/database/password',
      valueFrom: { secretKeyRef: { name: 'database', key: 'password' } },
    } }, options());
    expect(valid).toEqual(expect.objectContaining({ state: 'valid', referenceCount: 2,
      referenceHashes: expect.arrayContaining([expect.stringMatching(/^[a-f0-9]{64}$/)]) }));
    const stored = JSON.stringify(db.prepare('SELECT * FROM provider_secret_reference_validations').all());
    expect(stored).not.toContain('inline-value');
    expect(stored).not.toContain('vault://docker-dash/database/password');
  });

  it('surfaces certificate ownership and the latest approval-bound renewal job without PEM data', () => {
    db.exec(`CREATE TABLE tracked_certificates (
        id INTEGER PRIMARY KEY,name TEXT,subject TEXT,issuer TEXT,sans TEXT,not_after TEXT,
        fingerprint_sha256 TEXT,self_signed INTEGER,last_checked_at TEXT,last_error TEXT,host_id INTEGER,pem_content TEXT
      );
      CREATE TABLE lifecycle_certificate_ownership (
        id INTEGER PRIMARY KEY,certificate_id INTEGER,owner TEXT,environment TEXT,resource_type TEXT,
        resource_ref TEXT
      );
      CREATE TABLE lifecycle_certificate_renewal_jobs (
        id INTEGER PRIMARY KEY,ownership_id INTEGER,adapter_key TEXT,state TEXT,plan_hash TEXT,
        rollback_on_failure INTEGER,approved_at TEXT,completed_at TEXT
      );
      INSERT INTO tracked_certificates VALUES (1,'vCenter','CN=vcenter','CN=CA','vcenter.example',
        '2026-09-01T00:00:00Z','${'f'.repeat(64)}',0,'2026-07-31T10:00:00Z','',7,'PRIVATE');
      INSERT INTO lifecycle_certificate_ownership VALUES (2,1,'platform','production','endpoint','vcenter');
      INSERT INTO lifecycle_certificate_renewal_jobs VALUES
        (3,2,'vsphere-cert','approved','${'1'.repeat(64)}',1,'2026-07-31T10:00:00Z',NULL);
    `);
    const result = service.overview(host, options());
    expect(result.certificateRotation[0]).toEqual(expect.objectContaining({ name: 'vCenter',
      ownership: expect.objectContaining({ owner: 'platform' }),
      latestRenewal: expect.objectContaining({ state: 'approved', rollbackOnFailure: true }) }));
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
});
