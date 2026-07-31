'use strict';

jest.mock('../config', () => ({
  app: { env: 'test' },
  features: { providerPrivilegedCompliance: true, providerVmConsole: true },
  security: { encryptionKey: 'test-compliance-signing-key' },
  providerConsole: { tokenTtlSeconds: 45, maxPendingPerUser: 5 },
}));
jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('inject database'); }) }));

const Database = require('better-sqlite3');
const migration = require('../db/migrations/169_provider_privileged_compliance');
const service = require('../services/provider-sdk/privileged-compliance');
const broker = require('../services/provider-console/broker');

const host = { id: 7, name: 'pve-primary', daemon_type: 'proxmox' };
const admin = { id: 1, username: 'requester', role: 'admin' };
const approver = { id: 2, username: 'approver', role: 'admin' };

describe('provider privileged access and compliance lifecycle', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY,username TEXT,role TEXT,is_active INTEGER DEFAULT 1);
      CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY,name TEXT,daemon_type TEXT,is_active INTEGER);
      CREATE TABLE governance_permissions (permission_key TEXT PRIMARY KEY,resource_type TEXT,verb TEXT,description TEXT);
      CREATE TABLE governance_roles (id INTEGER PRIMARY KEY,is_builtin INTEGER DEFAULT 0);
      CREATE TABLE governance_role_permissions (role_id INTEGER,permission_key TEXT);
      CREATE TABLE governance_scopes (id INTEGER PRIMARY KEY,scope_type TEXT,scope_key TEXT,
        display_name TEXT,parent_id INTEGER,metadata_json TEXT DEFAULT '{}');
      CREATE TABLE provider_console_sessions (
        id TEXT PRIMARY KEY,token_hash TEXT UNIQUE,host_id INTEGER,resource_id TEXT,provider_type TEXT,
        protocol TEXT,user_id INTEGER,created_at TEXT DEFAULT (datetime('now')),expires_at TEXT,
        consumed_at TEXT,connected_at TEXT,closed_at TEXT,close_code TEXT);
      CREATE TABLE provider_resource_identities (canonical_id TEXT PRIMARY KEY,host_id INTEGER,resource_kind TEXT);
      CREATE TABLE provider_artifact_catalog (canonical_id TEXT PRIMARY KEY,host_id INTEGER);
      CREATE TABLE provider_recovery_points (canonical_id TEXT PRIMARY KEY,host_id INTEGER);
      CREATE TABLE provider_security_findings (id TEXT PRIMARY KEY,host_id INTEGER,advisory_id TEXT,
        cve_ids_json TEXT,severity TEXT,priority_score INTEGER,confidence TEXT,evidence_hash TEXT,state TEXT,observed_at TEXT);
      CREATE TABLE audit_log (id INTEGER PRIMARY KEY,action TEXT,target_type TEXT,target_id TEXT,
        details TEXT,created_at TEXT,entry_hash TEXT);
      INSERT INTO users VALUES (1,'requester','admin',1),(2,'approver','admin',1),(3,'delegated','viewer',1);
      INSERT INTO docker_hosts VALUES (7,'pve-primary','proxmox',1),(8,'other','proxmox',1);
      INSERT INTO governance_scopes VALUES (1,'organization','default','Docker Dash',NULL,'{}');
      INSERT INTO provider_security_findings VALUES
        ('psfd_aaaaaaaaaaaaaaaaaaaaaaaaaa',7,'ADV-1','["CVE-2026-12345"]','high',80,'high',
         '${'e'.repeat(64)}','open','2026-07-31T10:00:00Z');
      INSERT INTO audit_log VALUES (1,'provider_security_lifecycle_advisories_correlated','provider_host','7',
        '{"hostId":7}','2026-07-31T10:00:00Z','${'a'.repeat(64)}');
    `);
    migration.up(db);
  });

  afterEach(() => db.close());

  function options(extra = {}) {
    return { database: db, enabled: true, signingSecret: 'unit-test-signing-secret',
      verifyTotp: () => ({ success: true }), ...extra };
  }

  it('requires step-up MFA, four eyes and one-time claiming for scoped JIT', () => {
    expect(() => service.requestElevation(host, { scopeId: 1,
      permissionKey: 'data.classification.manage', reason: 'Time-bound classification change',
      ttlSeconds: 600, totpCode: '000000' }, admin,
    options({ verifyTotp: () => ({ error: 'Invalid TOTP code' }) }))).toThrow(/TOTP/i);

    const requested = service.requestElevation(host, { scopeId: 1,
      permissionKey: 'data.classification.manage', reason: 'Time-bound classification change',
      ttlSeconds: 600, totpCode: '123456' }, admin, options());
    expect(requested).toEqual(expect.objectContaining({ tokenIssued: false,
      grant: expect.objectContaining({ state: 'pending', mfaVerifiedAt: expect.any(String) }) }));
    expect(() => service.approveElevation(host, requested.grant.id,
      { confirmation: `APPROVE JIT ${requested.grant.id}` }, admin, options()))
      .toThrow(/independent/i);
    const approved = service.approveElevation(host, requested.grant.id,
      { confirmation: `APPROVE JIT ${requested.grant.id}` }, approver, options());
    expect(approved.grant).toEqual(expect.objectContaining({ state: 'active', approvedBy: 2, claimed: false }));

    const claimed = service.claimElevation(host, requested.grant.id, admin, options());
    expect(claimed.token).toMatch(/^[a-f0-9]{64}$/);
    expect(service.validateElevation(host.id, admin, 'data.classification.manage', claimed.token, options()))
      .toEqual(expect.objectContaining({ id: requested.grant.id, state: 'active' }));
    expect(() => service.claimElevation(host, requested.grant.id, admin, options())).toThrow(/cannot be claimed/i);
    const stored = JSON.stringify(db.prepare('SELECT * FROM provider_privileged_elevation_grants').all());
    expect(stored).not.toContain(claimed.token);
    db.prepare("UPDATE provider_privileged_elevation_grants SET expires_at='2020-01-01T00:00:00Z' WHERE id=?")
      .run(requested.grant.id);
    expect(() => service.validateElevation(host.id, admin,
      'data.classification.manage', claimed.token, options())).toThrow(/expired|current JIT/i);
  });

  it('rate-limits repeated failed local TOTP step-up attempts without storing codes', () => {
    const input = { scopeId: 1, permissionKey: 'compliance.evidence.export',
      reason: 'Short evidence export', ttlSeconds: 600, totpCode: '654321' };
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(() => service.requestElevation(host, input, admin,
        options({ verifyTotp: () => ({ error: 'Invalid TOTP code' }) }))).toThrow(/TOTP/i);
    }
    expect(() => service.requestElevation(host, input, admin, options()))
      .toThrow(/cooldown/i);
    expect(JSON.stringify(db.prepare('SELECT * FROM provider_privileged_step_up_attempts').all()))
      .not.toContain(input.totpCode);
  });

  it('enforces four-eyes activation, expiry metadata and independent break-glass review', () => {
    expect(() => service.requestBreakGlass(host, { scopeId: 1, reason: 'Recorder qualification',
      ticketRef: 'INC-2026-0041', notificationRefs: ['oncall:security'],
      recordingPolicy: 'screen', recordingConsent: true, ttlSeconds: 600 }, admin, options()))
      .toThrow(/recordingPolicyRef/i);
    const requested = service.requestBreakGlass(host, { scopeId: 1, reason: 'Identity provider outage',
      ticketRef: 'INC-2026-0042', notificationRefs: ['oncall:security', 'manager:platform'],
      recordingPolicy: 'screen', recordingConsent: true, recordingPolicyRef: 'legal:remote-v1',
      ttlSeconds: 600 }, admin, options());
    expect(requested).toEqual(expect.objectContaining({ notificationsDispatched: false,
      request: expect.objectContaining({ state: 'pending', recordingPolicy: 'screen',
        recordingPolicyRef: 'legal:remote-v1', recordingConsentAt: expect.any(String),
        temporaryIdentity: expect.stringMatching(/^break-glass:/) }) }));
    expect(() => service.approveBreakGlass(host, requested.request.id,
      { confirmation: `APPROVE BREAK GLASS ${requested.request.id}` }, admin, options())).toThrow(/independent/i);
    service.approveBreakGlass(host, requested.request.id,
      { confirmation: `APPROVE BREAK GLASS ${requested.request.id}` }, approver, options());
    const active = service.activateBreakGlass(host, requested.request.id,
      { confirmation: `ACTIVATE BREAK GLASS ${requested.request.id}` }, admin, options());
    expect(active).toEqual(expect.objectContaining({ tokenShownOnce: true,
      temporaryAccountCreated: false, request: expect.objectContaining({ state: 'active' }) }));
    expect(service.validateBreakGlass(host.id, admin, 1, active.token, options()))
      .toEqual(expect.objectContaining({ id: requested.request.id, state: 'active' }));
    service.closeBreakGlass(host, requested.request.id, admin, options());
    const reviewed = service.reviewBreakGlass(host, requested.request.id,
      { outcome: 'expected', notes: 'Access matched the incident timeline' }, approver, options());
    expect(reviewed).toEqual(expect.objectContaining({ state: 'reviewed', reviewOutcome: 'expected', reviewedBy: 2 }));
    expect(JSON.stringify(db.prepare('SELECT * FROM provider_break_glass_requests').all()))
      .not.toContain(active.token);
  });

  it('makes metadata recording implicit and requires consent plus policy for screen recording', () => {
    expect(broker._internals._recording({})).toEqual(expect.objectContaining({
      policy: 'metadata', state: 'metadata_only', mediaStored: false }));
    expect(() => broker._internals._recording({ policy: 'screen', policyRef: 'legal:remote-v1' }))
      .toThrow(/consent/i);
    expect(broker._internals._recording({ policy: 'screen', policyRef: 'legal:remote-v1', consent: true }))
      .toEqual(expect.objectContaining({ policy: 'screen', state: 'screen_requested',
        consentAt: expect.any(String), mediaStored: false }));
    const columns = new Set(db.prepare('PRAGMA table_info(provider_console_sessions)').all().map(row => row.name));
    expect([...columns]).toEqual(expect.arrayContaining([
      'recording_policy', 'recording_policy_ref', 'recording_consent_at', 'recording_state',
    ]));
  });

  it('projects classification, deduplicates control mappings and scores four recovery factors', () => {
    const classified = service.upsertClassification(host, { scopeId: 1,
      resourceKind: 'endpoint', resourceId: 'endpoint:7', classification: 'restricted' }, admin, options());
    expect(classified.classification).toEqual(expect.objectContaining({ classification: 'restricted',
      policy: { backup: 'immutable_encrypted_required', evidenceExport: 'hashes_only', telemetry: 'disabled' } }));
    const mapped = service.importMappings(host, { scopeId: 1, mappings: [
      { subjectKind: 'classification', subjectKey: classified.classification.id,
        framework: 'NIST', controlRef: 'organization-control-7', rationale: 'Internal mapping' },
      { subjectKind: 'classification', subjectKey: classified.classification.id,
        framework: 'NIST', controlRef: 'organization-control-7', rationale: 'Internal mapping' },
    ] }, admin, options());
    expect(mapped).toEqual(expect.objectContaining({ count: 1, duplicatedFindingsCreated: 0 }));
    const observedAt = '2026-07-31T10:00:00Z';
    const posture = service.recordRansomwarePosture(host, { scopeId: 1, source: 'provider', observedAt,
      factors: {
        immutability: { state: 'verified', evidenceRef: 'backup:lock', observedAt },
        isolation: { state: 'verified', evidenceRef: 'drill:network', observedAt },
        restoreTests: { state: 'verified', evidenceRef: 'drill:success', observedAt },
        credentialSeparation: { state: 'unknown', evidenceRef: 'identity:missing', observedAt },
      } }, admin, options());
    expect(posture.posture).toEqual(expect.objectContaining({ score: 75, confidence: 'medium' }));
  });

  it('creates installation-signed JSON and PDF evidence without storing bundle content', () => {
    service.upsertClassification(host, { scopeId: 1, resourceKind: 'endpoint',
      resourceId: 'endpoint:7', classification: 'confidential' }, admin, options());
    const json = service.createComplianceExport(host, { scopeId: 1, format: 'json' }, admin, options());
    expect(json.export).toEqual(expect.objectContaining({ format: 'json', classification: 'confidential',
      bundleHash: expect.stringMatching(/^[a-f0-9]{64}$/), signature: expect.stringMatching(/^[a-f0-9]{64}$/) }));
    expect(json.bundle.safety).toEqual(expect.objectContaining({ rawConfigurationStored: false,
      secretMaterialStored: false, sessionScreenContentStored: false }));
    expect(json.bundle.exportMode).toBe('redacted');
    expect(json.bundle.findings[0]).not.toHaveProperty('cveIds');
    expect(json.bundle.integrity.signingScope).toBe('installation-local');
    const pdf = service.createComplianceExport(host, { scopeId: 1, format: 'pdf' }, admin, options());
    expect(pdf.content.subarray(0, 8).toString('ascii')).toBe('%PDF-1.4');
    expect(pdf.bundleStored).toBe(false);
    const rows = JSON.stringify(db.prepare('SELECT * FROM provider_compliance_exports').all());
    expect(rows).not.toContain('CVE-2026-12345');
    expect(service.overview(host, admin, options())).toEqual(expect.objectContaining({
      governanceIntegration: expect.objectContaining({ permissionCount: 10 }),
      safety: expect.objectContaining({ temporaryAccountCreated: false, screenRecordingStored: false }),
    }));
  });

  it('integrates delegated permissions, custom roles and host-bound scope hierarchy', () => {
    db.prepare('INSERT INTO governance_roles(id,is_builtin) VALUES (10,0)').run();
    db.prepare(`INSERT INTO governance_role_permissions(role_id,permission_key) VALUES
      (10,'privileged.elevation.approve'),(10,'compliance.evidence.export')`).run();
    db.prepare(`INSERT INTO governance_scopes(id,scope_type,scope_key,display_name,parent_id,metadata_json)
      VALUES (2,'provider','provider-host:8','Other endpoint',1,'{"providerHostId":8}')`).run();
    db.prepare(`INSERT INTO governance_scopes(id,scope_type,scope_key,display_name,parent_id,metadata_json)
      VALUES (3,'project','project:restricted','Restricted project',1,'{}')`).run();
    db.prepare(`INSERT INTO provider_console_sessions
      (id,token_hash,host_id,resource_id,provider_type,protocol,user_id,expires_at)
      VALUES ('pcs_aaaaaaaaaaaaaaaaaaaaaaaaaa','${'f'.repeat(64)}',7,
        'ddr_vm_aaaaaaaaaaaaaaaaaaaaaaaaaa','proxmox','vnc',1,'2026-08-01T00:00:00Z')`).run();
    const pending = service.requestElevation(host, { scopeId: 1,
      permissionKey: 'compliance.evidence.export', reason: 'Delegated approval visibility',
      ttlSeconds: 600, totpCode: '123456' }, admin, options());
    const delegated = { id: 3, username: 'delegated', role: 'viewer' };
    const allowed = new Set(['privileged.elevation.approve', 'compliance.evidence.export']);
    const governanceService = { listScopes: () => [{ id: 1 }],
      can: (_actor, scopeId, permission) => Number(scopeId) === 1 && allowed.has(permission) };
    const delegatedOverview = service.overview(host, delegated, options({ governanceService }));
    expect(delegatedOverview.grants.map(grant => grant.id)).toContain(pending.grant.id);
    expect(delegatedOverview.governanceIntegration).toEqual(expect.objectContaining({
      customRoleCount: 1,
      actorPermissions: expect.arrayContaining([
        'privileged.elevation.approve', 'compliance.evidence.export',
      ]),
    }));
    expect(delegatedOverview.remoteSessions).toEqual([]);
    const delegatedExport = service.createComplianceExport(host,
      { scopeId: 1, format: 'json' }, delegated, options({ governanceService }));
    expect(delegatedExport.bundle.remoteSessions).toEqual([]);
    expect(delegatedExport.bundle.safety.sessionEvidenceWithheld).toBe(true);
    expect(() => service.createComplianceExport(host, { scopeId: 3, format: 'json' }, admin,
    options())).toThrow(/organization or provider scope/i);
    expect(() => service.upsertClassification(host, { scopeId: 2,
      resourceKind: 'endpoint', resourceId: 'endpoint:7', classification: 'internal' }, admin,
    options())).toThrow(/another provider endpoint/i);
  });
});
