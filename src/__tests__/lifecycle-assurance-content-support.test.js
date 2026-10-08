'use strict';

const Database = require('better-sqlite3');
const migration044 = require('../db/migrations/044_tracked_certificates');
const migration132 = require('../db/migrations/132_lifecycle_maintenance_compatibility');
const migration133 = require('../db/migrations/133_lifecycle_assurance_content_support');
const { LifecycleAssuranceService, _internals } = require('../services/lifecycle-assurance');

function database() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE governance_permissions (permission_key TEXT PRIMARY KEY, resource_type TEXT NOT NULL, verb TEXT NOT NULL, description TEXT NOT NULL);
    CREATE TABLE governance_roles (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE);
    CREATE TABLE governance_role_permissions (role_id INTEGER REFERENCES governance_roles(id), permission_key TEXT REFERENCES governance_permissions(permission_key), PRIMARY KEY(role_id,permission_key));
    CREATE TABLE provider_operations (id TEXT PRIMARY KEY, host_id INTEGER, state TEXT NOT NULL);
    CREATE TABLE infrastructure_approval_requests (id INTEGER PRIMARY KEY, action_key TEXT NOT NULL, target_id TEXT NOT NULL, payload_hash TEXT NOT NULL, state TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO users (id,username,role) VALUES (1,'admin','admin')").run();
  db.prepare("INSERT INTO governance_roles (id,slug) VALUES (1,'site-admin')").run();
  migration044.up(db); migration132.up(db); migration133.up(db); return db;
}

const admin = { id: 1, username: 'admin', role: 'admin' };
const future = days => new Date(Date.now() + days * 86400000).toISOString();
const past = days => new Date(Date.now() - days * 86400000).toISOString();
const digest = letter => letter.repeat(64);

describe('V0.3f lifecycle assurance, content and support (B266-B275)', () => {
  let db; let lifecycle;
  beforeEach(() => { db = database(); lifecycle = new LifecycleAssuranceService(() => db); });
  afterEach(() => db.close());

  function certificateOwnership() {
    const certificateId = Number(db.prepare('INSERT INTO tracked_certificates (name,fingerprint_sha256,not_after) VALUES (?,?,?)')
      .run(`cert-${Date.now()}`, digest('a'), future(20)).lastInsertRowid);
    const ownershipId = Number(db.prepare(`INSERT INTO lifecycle_certificate_ownership
      (certificate_id,inventory_key,resource_type,resource_ref,owner,environment,created_by) VALUES (?,?,?,?,?,'production',1)`)
      .run(certificateId, `tls/${Date.now()}`, 'service', 'api', 'platform').lastInsertRowid);
    return { certificateId, ownershipId };
  }
  function operation(state = 'running') {
    const id = `op_${state === 'failed' ? 'b' : 'a'.repeat(26)}`;
    const normalized = id.length === 29 ? id : `op_${'b'.repeat(26)}`;
    db.prepare('INSERT OR REPLACE INTO provider_operations (id,host_id,state) VALUES (?,7,?)').run(normalized, state); return normalized;
  }
  function approveExecution(job, operationId) {
    const payloadHash = _internals.hash({ renewalJobId: job.id, planHash: job.planHash });
    db.prepare("INSERT INTO infrastructure_approval_requests (id,action_key,target_id,payload_hash,state) VALUES (1,'certificate.renew',?,?,'approved')")
      .run(String(job.id), payloadHash);
    return { operationId, approvalId: 1, confirmation: `EXECUTE RENEWAL ${job.id}`, request: {} };
  }

  test('migration creates nineteen stores, four permissions and site-admin grants', () => {
    const names = ['lifecycle_certificate_renewal_jobs','license_entitlements','license_assignments','license_usage_observations',
      'license_alert_policies','license_alerts','host_configuration_snapshots','host_configuration_diffs','host_drift_policies',
      'host_drift_assessments','host_profiles','host_profile_assessments','airgap_mirrors','airgap_mirror_artifacts',
      'airgap_mirror_runs','support_bundle_requests','support_bundle_nodes','post_upgrade_validation_packs','post_upgrade_validation_runs'];
    const p = names.map(() => '?').join(',');
    expect(db.prepare(`SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name IN (${p})`).get(...names).count).toBe(19);
    expect(db.prepare("SELECT COUNT(*) count FROM governance_permissions WHERE permission_key IN ('lifecycle_renewal.manage','license_entitlement.manage','configuration_assurance.manage','lifecycle_support.manage')").get().count).toBe(4);
    expect(db.prepare('SELECT COUNT(*) count FROM governance_role_permissions').get().count).toBe(6);
  });

  test('certificate renewal is explicit about an unavailable adapter', () => {
    const { ownershipId } = certificateOwnership();
    expect(lifecycle.planRenewal({ ownershipId, adapterKey: 'vendor-acme' }, admin))
      .toMatchObject({ state: 'unsupported', applyStarted: false, evidence: { supported: false } });
  });

  test('approved renewal applies, verifies and updates tracked evidence through an adapter', async () => {
    const { certificateId, ownershipId } = certificateOwnership();
    lifecycle = new LifecycleAssuranceService(() => db, { renewalAdapters: { acme: async input => input.phase === 'apply'
      ? { requestAccepted: true } : input.phase === 'verify' ? { verified: true, fingerprintSha256: digest('c'), notAfter: future(90) }
        : { rolledBack: true } } });
    let job = lifecycle.planRenewal({ ownershipId, adapterKey: 'acme' }, admin);
    job = lifecycle.approveRenewal(job.id, { planHash: job.planHash, confirmation: `APPROVE RENEWAL ${job.id}` }, admin);
    const result = await lifecycle.executeRenewal(job.id, approveExecution(job, operation()), admin);
    expect(result).toMatchObject({ state: 'succeeded', renewedFingerprint: digest('c'), implicitRebootScheduled: false });
    expect(db.prepare('SELECT fingerprint_sha256 FROM tracked_certificates WHERE id=?').get(certificateId).fingerprint_sha256).toBe(digest('c'));
  });

  test('failed certificate verification invokes rollback and retains previous fingerprint', async () => {
    const { certificateId, ownershipId } = certificateOwnership();
    lifecycle = new LifecycleAssuranceService(() => db, { renewalAdapters: { acme: async input => input.phase === 'apply'
      ? { requestAccepted: true } : input.phase === 'verify' ? { verified: false } : { rolledBack: true, restored: 'previous' } } });
    let job = lifecycle.planRenewal({ ownershipId, adapterKey: 'acme', rollbackOnFailure: true }, admin);
    job = lifecycle.approveRenewal(job.id, { planHash: job.planHash, confirmation: `APPROVE RENEWAL ${job.id}` }, admin);
    const result = await lifecycle.executeRenewal(job.id, approveExecution(job, operation()), admin);
    expect(result).toMatchObject({ state: 'rolled_back', previousFingerprint: digest('a') });
    expect(result.evidence.rollback).toMatchObject({ rolledBack: true });
    expect(db.prepare('SELECT fingerprint_sha256 FROM tracked_certificates WHERE id=?').get(certificateId).fingerprint_sha256).toBe(digest('a'));
  });

  test('license inventory stores opaque references, assignments and exact usage evidence', () => {
    expect(() => lifecycle.saveEntitlement({ vendor: 'Acme', product: 'Cloud', edition: 'Enterprise',
      entitlementReference: 'vault/license-key', metric: 'core', capacity: 100, unit: 'cores', sourceUrl: 'https://vendor.example/license' }, admin)).toThrow(/never a license key/);
    const item = lifecycle.saveEntitlement({ vendor: 'Acme', product: 'Cloud', edition: 'Enterprise',
      entitlementReference: 'contract-2026', metric: 'core', capacity: 100, unit: 'cores', expiresAt: future(30),
      sourceUrl: 'https://vendor.example/license', metadata: { agreement: 'EA' } }, admin);
    const assigned = lifecycle.assignEntitlement(item.id, { resourceType: 'cluster', resourceRef: 'cluster-a',
      assignedCapacity: 80, owner: 'platform', environment: 'production' }, admin);
    expect(assigned.assignments[0]).toMatchObject({ resourceRef: 'cluster-a', assignedCapacity: 80 });
    expect(lifecycle.recordLicenseUsage(item.id, { usedCapacity: 75, assignedCapacity: 80,
      observedAt: new Date().toISOString(), evidence: { source: 'vendor-api' } }, admin)).toMatchObject({ usedCapacity: 75 });
  });

  test('license alerts detect assignment, usage, expiry and forecast without changing licenses', () => {
    const item = lifecycle.saveEntitlement({ vendor: 'Acme', product: 'Cloud', edition: 'Enterprise', entitlementReference: 'contract-alert',
      metric: 'core', capacity: 100, unit: 'cores', expiresAt: future(5), sourceUrl: 'https://vendor.example/license' }, admin);
    lifecycle.assignEntitlement(item.id, { resourceType: 'cluster', resourceRef: 'cluster-a', assignedCapacity: 90, owner: 'platform', environment: 'production' }, admin);
    lifecycle.recordLicenseUsage(item.id, { usedCapacity: 50, assignedCapacity: 90, observedAt: past(2), evidence: { sample: 1 } }, admin);
    lifecycle.recordLicenseUsage(item.id, { usedCapacity: 90, assignedCapacity: 90, observedAt: past(1), evidence: { sample: 2 } }, admin);
    lifecycle.saveLicenseAlertPolicy({ name: 'license-risk', entitlementId: item.id, overPercent: 80,
      underPercent: 10, expiryDays: 30, forecastDays: 10 }, admin);
    const result = lifecycle.evaluateLicenseAlerts(admin);
    expect(result.licenseChangesApplied).toBe(0);
    expect(result.alerts.map(alert => alert.type)).toEqual(expect.arrayContaining(['over_assignment','over_usage','expiry','forecast']));
    expect(lifecycle.evaluateLicenseAlerts(admin).created).toBe(0);
  });

  test('configuration snapshots redact secret values and deduplicate canonical captures', () => {
    const body = { providerHostId: 7, scopeRef: 'host.node-a', sourceKind: 'actual', observedAt: new Date().toISOString(),
      configuration: { service: { enabled: true, apiToken: 'never-store-me' }, network: { mtu: 1500 } } };
    const first = lifecycle.saveConfigurationSnapshot(body, admin); const second = lifecycle.saveConfigurationSnapshot(body, admin);
    expect(first.id).toBe(second.id); expect(first.configuration.service.apiToken).toBe('[REDACTED]');
    expect(first.redactedPaths).toEqual(['service.apiToken']); expect(JSON.stringify(first)).not.toContain('never-store-me');
  });

  test('configuration diff is human-readable and drift policy persists denied evidence', () => {
    const before = lifecycle.saveConfigurationSnapshot({ providerHostId: 7, scopeRef: 'host.node-a', sourceKind: 'actual',
      configuration: { service: { enabled: true }, network: { mtu: 1500 }, notes: 'old' } }, admin);
    const after = lifecycle.saveConfigurationSnapshot({ providerHostId: 7, scopeRef: 'host.node-a', sourceKind: 'desired',
      configuration: { service: { enabled: true }, network: { mtu: 9000 }, owner: 'platform' } }, admin);
    const diff = lifecycle.createConfigurationDiff({ fromSnapshotId: before.id, toSnapshotId: after.id }, admin);
    expect(diff.summary).toMatchObject({ added: 1, changed: 1, removed: 1 });
    const policy = lifecycle.saveDriftPolicy({ name: 'host-drift', providerHostId: 7, scopePattern: 'host.*', owner: 'platform',
      rules: { allowed: ['owner'], denied: ['network.*'], ignored: ['notes'] } }, admin);
    const result = lifecycle.evaluateDrift(policy.id, diff.id, admin);
    expect(result).toMatchObject({ state: 'denied', remediationStarted: false });
    expect(result.classifications.find(item => item.path === 'network.mtu').disposition).toBe('denied');
  });

  test('host profile compliance produces an advisory remediation plan only', () => {
    const snapshot = lifecycle.saveConfigurationSnapshot({ providerHostId: 7, scopeRef: 'host.node-a', sourceKind: 'actual',
      configuration: { service: { enabled: false }, network: { mtu: 1500 } } }, admin);
    const profile = lifecycle.saveHostProfile({ name: 'production-host', version: '1.0', scopePattern: 'host.*', severity: 'critical',
      baseline: { 'service.enabled': true, 'network.mtu': 1500, 'ha.enabled': true } }, admin);
    const result = lifecycle.assessHostProfile(profile.id, snapshot.id, admin);
    expect(result).toMatchObject({ state: 'noncompliant', remediationStarted: false });
    expect(result.remediationPlan).toHaveLength(2);
  });

  test('air-gap mirror is explicit when unsupported and accepts only trusted signed artifacts', async () => {
    let mirror = lifecycle.saveMirror({ name: 'site-a', siteRef: 'site-a', adapterKey: 'filesystem',
      rootReference: '/mirror/site-a', trustRoots: ['vendor-signing'], maxBytes: 10000 }, admin);
    const request = { artifacts: [{ kind: 'package', name: 'hypervisor', version: '1.0', digest: digest('d'),
      signatureIdentity: 'vendor-signing', sourceUrl: 'https://vendor.example/package' }] };
    expect(await lifecycle.syncMirror(mirror.id, request, admin)).toMatchObject({ state: 'unsupported', artifactsAdded: 0 });
    lifecycle = new LifecycleAssuranceService(() => db, { mirrorAdapters: { filesystem: async ({ requested }) => ({
      artifacts: requested.map(item => ({ ...item, signatureVerified: true, byteSize: 2048, localReference: `/mirror/${item.name}` })) }) } });
    const synced = await lifecycle.syncMirror(mirror.id, request, admin);
    expect(synced).toMatchObject({ state: 'succeeded', artifactsAdded: 1, bytesAdded: 2048, unsignedArtifactsAccepted: 0 });
    mirror = lifecycle.mirrors(admin)[0]; expect(mirror.artifacts[0]).toMatchObject({ signatureVerified: true, digest: digest('d') });
  });

  test('air-gap mirror rejects unsigned or untrusted adapter results', async () => {
    const mirror = lifecycle.saveMirror({ name: 'site-b', siteRef: 'site-b', adapterKey: 'filesystem',
      rootReference: '/mirror/site-b', trustRoots: ['trusted'], maxBytes: 10000 }, admin);
    lifecycle = new LifecycleAssuranceService(() => db, { mirrorAdapters: { filesystem: async ({ requested }) => ({
      artifacts: requested.map(item => ({ ...item, signatureIdentity: 'untrusted', signatureVerified: false,
        byteSize: 100, localReference: '/mirror/bad' })) }) } });
    const result = await lifecycle.syncMirror(mirror.id, { artifacts: [{ kind: 'image', name: 'app', version: '1',
      digest: digest('e'), signatureIdentity: 'trusted', sourceUrl: 'https://registry.example/app' }] }, admin);
    expect(result).toMatchObject({ state: 'failed', artifactsAdded: 0, unsignedArtifactsAccepted: 0 });
  });

  test('support bundle orchestrator collects multiple nodes, redacts secrets and records checksum plus expiry', async () => {
    lifecycle = new LifecycleAssuranceService(() => db, { supportCollectors: { native: async ({ targetRef }) => ({
      evidence: { targetRef, status: 'ok', apiToken: `secret-${targetRef}`, logs: ['bounded'] } }) } });
    const result = await lifecycle.collectSupportBundle({ name: 'incident-42', adapterKey: 'native', targetRefs: ['node-a','node-b'],
      sections: ['logs','configuration'], maxNodeBytes: 100000, expiresAt: future(2) }, admin);
    expect(result).toMatchObject({ state: 'ready', secretsReturned: false }); expect(result.nodes).toHaveLength(2);
    expect(result.checksumSha256).toMatch(DIGEST_RE); expect(JSON.stringify(lifecycle.supportBundles(admin))).not.toContain('secret-node');
  });

  test('post-upgrade validation covers all six categories and fails closed on required unsupported checks', async () => {
    const checks = ['api','ha','migration','storage','network','vm'].map(category => ({
      key: `${category}-smoke`, category, adapterKey: category === 'vm' ? 'missing' : 'probe', required: true, config: {} }));
    lifecycle = new LifecycleAssuranceService(() => db, { validationAdapters: { probe: async ({ check }) => ({ passed: true, probe: check.category }) } });
    const pack = lifecycle.saveValidationPack({ name: 'post-upgrade', version: '1.0', checks }, admin);
    const result = await lifecycle.runValidationPack(pack.id, { targetRef: 'cluster-a', context: { release: '8.0' } }, admin);
    expect(result).toMatchObject({ state: 'failed', providerMutationsStarted: 0 });
    expect(result.results).toHaveLength(6); expect(result.results.find(item => item.category === 'vm').state).toBe('unsupported');
  });
});

const DIGEST_RE = /^[a-f0-9]{64}$/;
