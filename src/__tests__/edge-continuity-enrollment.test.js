'use strict';

process.env.APP_SECRET = 'edge-continuity-test-signing-secret-32';
process.env.ENCRYPTION_KEY = 'edge-continuity-test-encryption-key';
process.env.DB_PATH = ':memory:';

const Database = require('better-sqlite3');
const migration131 = require('../db/migrations/131_automation_operations_lifecycle_updates');
const migration139 = require('../db/migrations/139_edge_disconnected_foundation');
const migration140 = require('../db/migrations/140_edge_sovereignty_resilience');
const migration141 = require('../db/migrations/141_edge_continuity_experience');
const { EdgePlatformService } = require('../services/edge-platform');
const { InfrastructureOperationsService } = require('../services/infrastructure-operations');

const requester = { id: 1, username: 'requester', role: 'admin' };
const approver = { id: 2, username: 'approver', role: 'admin' };
const digest = character => `sha256:${character.repeat(64)}`;
const future = milliseconds => new Date(Date.now() + milliseconds).toISOString();

function setup() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, daemon_type TEXT NOT NULL, daemon_config TEXT, is_active INTEGER DEFAULT 1);
    CREATE TABLE governance_permissions (permission_key TEXT PRIMARY KEY, resource_type TEXT NOT NULL, verb TEXT NOT NULL, description TEXT NOT NULL);
    CREATE TABLE governance_roles (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE);
    CREATE TABLE governance_role_permissions (role_id INTEGER REFERENCES governance_roles(id), permission_key TEXT REFERENCES governance_permissions(permission_key), PRIMARY KEY(role_id,permission_key));
    INSERT INTO users VALUES (1,'requester','admin',1),(2,'approver','admin',1);
    INSERT INTO docker_hosts VALUES (7,'edge-a','docker','{}',1),(8,'edge-b','docker','{}',1);
    INSERT INTO governance_roles VALUES (1,'site-admin');
  `);
  migration131.up(db); migration139.up(db); migration140.up(db); migration141.up(db);
  const approvalService = new InfrastructureOperationsService(() => db);
  const service = new EdgePlatformService(() => db, { signingSecret: 'edge-continuity-signing-secret-32', approvalService });
  const site = service.saveSite({ slug: 'bucharest-edge', name: 'Bucharest edge', timezone: 'Europe/Bucharest',
    region: 'ro-bucharest', jurisdiction: 'EU/RO', localOwner: 'platform-team', trustRoots: ['signer/platform-release'],
    hosts: [{ hostId: 7, role: 'worker' }, { hostId: 8, role: 'worker' }], status: 'active' }, requester);
  return { db, service, site };
}

describe('V6.5c edge continuity and zero-touch enrollment (B346-B350)', () => {
  test('B346 disaster declaration freezes mutation envelopes, queues notifications and requires separate-admin recovery', () => {
    const { db, service, site } = setup(); const agent = service.registerAgent(site.id, { agentId: 'edge-disaster',
      certificateFingerprint: digest('a'), runbookAllowlist: ['disaster_assessment'], updateRing: 'held', state: 'active' }, requester);
    service.saveConnectivity(site.id, { mode: 'intermittent', maxStalenessSeconds: 300, cacheTtlSeconds: 86400, mutationMode: 'queue' }, requester);
    const declaration = service.declareDisaster(site.id, { severity: 'critical', reason: 'Site lost utility power and WAN', ticketRef: 'INC-346',
      agentRecordId: agent.id, runbookExpiresAt: future(3600000), notifications: [{ channel: 'email', recipientRef: 'ops@example.com' }] }, requester);
    expect(declaration).toMatchObject({ state: 'active', mutationFreeze: true, externalNotificationDeliveryStarted: false });
    expect(declaration.notifications).toEqual(expect.arrayContaining([{ channel: 'local_banner', recipientRef: 'site/bucharest-edge' }]));
    expect(db.prepare('SELECT COUNT(*) count FROM edge_disaster_notification_outbox WHERE declaration_id=?').get(declaration.id).count).toBe(2);
    expect(() => service.createIntent(site.id, { actionKey: 'service.restart', targetRef: 'service/api', payload: {},
      prerequisites: ['site_reconnected'], expiresAt: future(3600000) }, requester)).toThrow(expect.objectContaining({ code: 'EDGE_SITE_DISASTER_FREEZE' }));
    expect(() => service.resolveDisaster(declaration.id, { confirmation: site.slug, evidence: { power: 'stable' } }, requester))
      .toThrow(expect.objectContaining({ code: 'FOUR_EYES_REQUIRED' }));
    expect(service.resolveDisaster(declaration.id, { confirmation: site.slug, evidence: { power: 'stable', wan: 'restored' } }, approver))
      .toMatchObject({ state: 'resolved', resolvedBy: 2 }); db.close();
  });

  test('B347 backup seed is signed, chunk-verified and resumes through monotonic checkpoints without central transfer', () => {
    const { db, service, site } = setup(); const seed = service.createBackupSeed(site.id, { datasetRef: 'dataset/site-a',
      baseBackupRef: 'backup/base-20260729', baseBackupDigest: digest('b'), encryptionKeyRef: 'vault/backup-key', mediaRef: 'media/usb-001',
      expiresAt: future(7 * 86400000), chunks: [{ index: 0, digest: digest('c'), bytes: 1024, verified: true },
        { index: 1, digest: digest('d'), bytes: 2048, verified: true }] }, requester);
    expect(seed).toMatchObject({ state: 'ready', totalBytes: 3072, transferStarted: false }); expect(seed.signature).toMatch(/^[a-f0-9]{64}$/);
    const first = service.recordBackupSeedCheckpoint(seed.id, { sequence: 1, completedChunk: 0, transferredBytes: 1024,
      continuationCursor: 'chunk/1', rollingDigest: digest('e'), mediaIdentityHash: digest('f') }, requester);
    expect(first).toMatchObject({ state: 'in_progress', continuationSupported: true, transferPerformedByApi: false });
    expect(() => service.recordBackupSeedCheckpoint(seed.id, { sequence: 1, completedChunk: 0, transferredBytes: 1024,
      continuationCursor: 'chunk/1', rollingDigest: digest('e'), mediaIdentityHash: digest('f') }, requester))
      .toThrow(expect.objectContaining({ code: 'EDGE_BACKUP_CHECKPOINT_REPLAY' }));
    expect(service.recordBackupSeedCheckpoint(seed.id, { sequence: 2, completedChunk: 1, transferredBytes: 3072,
      continuationCursor: 'complete/2', rollingDigest: digest('a'), mediaIdentityHash: digest('f') }, requester)).toMatchObject({ state: 'complete' });
    expect(db.prepare('SELECT state FROM edge_backup_seed_manifests WHERE id=?').get(seed.id).state).toBe('complete'); db.close();
  });

  test('B348 fleet compliance exports counts and state only while withholding raw evidence', () => {
    const { db, service, site } = setup(); service.saveComplianceProfile(site.id, { requiredControls: ['agent_version','connectivity','backup'], maximumUnknown: 0 }, requester);
    const snapshot = service.recordComplianceSnapshot(site.id, { observedAt: new Date().toISOString(), controls: [
      { control: 'agent_version', state: 'pass', evidenceDigest: digest('a') },
      { control: 'connectivity', state: 'pass', evidenceDigest: digest('b') },
      { control: 'backup', state: 'fail', evidenceDigest: digest('c') }] }, requester);
    expect(snapshot).toMatchObject({ passedCount: 2, failedCount: 1, posture: 'non_compliant', sensitiveDetailsWithheld: true });
    expect(snapshot.controlStates).toEqual([{ control: 'agent_version', state: 'pass' }, { control: 'connectivity', state: 'pass' }, { control: 'backup', state: 'fail' }]);
    expect(service.fleetCompliance(requester)).toMatchObject({ summary: { sites: 1, nonCompliant: 1 },
      sensitiveDetailsWithheld: true, rawEvidenceExported: false }); db.close();
  });

  test('B349 fault-domain model visualizes rack/power/network/storage coverage and placement risk without moving workloads', () => {
    const { db, service, site } = setup(); for (const type of ['rack','power','network','storage']) {
      service.saveFaultDomain(site.id, { domainType: type, domainKey: `${type}-a`, name: `${type} A`, owner: 'facilities', hostIds: [7], metadata: { zone: 'a' } }, requester);
      service.saveFaultDomain(site.id, { domainType: type, domainKey: `${type}-b`, name: `${type} B`, owner: 'facilities', hostIds: [8], metadata: { zone: 'b' } }, requester);
    }
    expect(service.assessFaultDomains(site.id, { workloadRef: 'workload/database', hostIds: [7,8], requiredReplicas: 2 }, requester))
      .toMatchObject({ state: 'resilient', risks: [], visualizationReady: true, placementMutationStarted: false });
    service.saveFaultDomain(site.id, { domainType: 'rack', domainKey: 'rack-a', name: 'rack A', owner: 'facilities', hostIds: [7,8], metadata: { zone: 'a' } }, requester);
    expect(service.assessFaultDomains(site.id, { workloadRef: 'workload/database-risk', hostIds: [7,8], requiredReplicas: 2 }, requester))
      .toMatchObject({ state: 'at_risk', risks: ['rack_shared_failure_domain'], placementMutationStarted: false }); db.close();
  });

  test('B350 one-time hardware-bound enrollment rejects replay and creates certificate identity only after four-eyes approval', () => {
    const { db, service, site } = setup(); const expectedHardware = { manufacturer: 'Dell', model: 'R650', serialNumber: 'ABC123', tpmEkHash: digest('a') };
    const issued = service.createEnrollmentToken(site.id, { expectedHardware, runbookAllowlist: ['collect_inventory'], updateRing: 'held', ttlSeconds: 600 }, requester);
    expect(issued).toMatchObject({ state: 'issued', tokenReturnedOnce: true, privateKeyGenerated: false }); expect(issued.token).toMatch(/^edge_enroll_/);
    const redeemed = service.redeemEnrollment({ token: issued.token, agentId: 'edge-zero-touch', hardwareClaims: expectedHardware,
      publicKeyFingerprint: digest('b'), nonce: 'bootstrap-nonce-001' });
    expect(redeemed).toMatchObject({ state: 'certificate_pending', enrollmentTokenReturned: false, certificatePrivateKeyReturned: false });
    expect(() => service.redeemEnrollment({ token: issued.token, agentId: 'edge-replay', hardwareClaims: expectedHardware,
      publicKeyFingerprint: digest('c'), nonce: 'bootstrap-nonce-002' })).toThrow(expect.objectContaining({ code: 'EDGE_ENROLLMENT_TOKEN_INVALID' }));
    const approval = { attestationHash: redeemed.attestationHash, confirmation: redeemed.agentId, certificateFingerprint: digest('d') };
    expect(() => service.approveEnrollment(redeemed.id, approval, requester)).toThrow(expect.objectContaining({ code: 'FOUR_EYES_REQUIRED' }));
    expect(service.approveEnrollment(redeemed.id, approval, approver)).toMatchObject({ state: 'enrolled', edgeAgentId: expect.any(Number),
      certificateFingerprint: digest('d'), certificatePrivateKeyReturned: false });
    expect(db.prepare('SELECT COUNT(*) count FROM edge_agents WHERE agent_id=?').get('edge-zero-touch').count).toBe(1); db.close();
  });
});
