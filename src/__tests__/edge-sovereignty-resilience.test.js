'use strict';

process.env.APP_SECRET = 'edge-sovereignty-test-signing-secret-32';
process.env.ENCRYPTION_KEY = 'edge-sovereignty-test-encryption-key';
process.env.DB_PATH = ':memory:';

const Database = require('better-sqlite3');
const migration131 = require('../db/migrations/131_automation_operations_lifecycle_updates');
const migration139 = require('../db/migrations/139_edge_disconnected_foundation');
const migration140 = require('../db/migrations/140_edge_sovereignty_resilience');
const { EdgePlatformService } = require('../services/edge-platform');
const { InfrastructureOperationsService } = require('../services/infrastructure-operations');

const requester = { id: 1, username: 'edge-requester', role: 'admin' };
const approver = { id: 2, username: 'edge-approver', role: 'admin' };
const future = milliseconds => new Date(Date.now() + milliseconds).toISOString();
const digest = character => `sha256:${character.repeat(64)}`;

function setup() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, daemon_type TEXT NOT NULL, daemon_config TEXT, is_active INTEGER DEFAULT 1);
    CREATE TABLE governance_permissions (permission_key TEXT PRIMARY KEY, resource_type TEXT NOT NULL, verb TEXT NOT NULL, description TEXT NOT NULL);
    CREATE TABLE governance_roles (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE);
    CREATE TABLE governance_role_permissions (role_id INTEGER REFERENCES governance_roles(id), permission_key TEXT REFERENCES governance_permissions(permission_key), PRIMARY KEY(role_id,permission_key));
    INSERT INTO users VALUES (1,'edge-requester','admin',1),(2,'edge-approver','admin',1);
    INSERT INTO docker_hosts VALUES (7,'edge-node','docker','{}',1);
    INSERT INTO governance_roles VALUES (1,'site-admin');
  `);
  migration131.up(db); migration139.up(db); migration140.up(db);
  const approvals = new InfrastructureOperationsService(() => db);
  const service = new EdgePlatformService(() => db, { signingSecret: 'unit-test-edge-signing-secret-32', approvalService: approvals });
  const site = service.saveSite({ slug: 'bucharest-edge', name: 'Bucharest edge', timezone: 'Europe/Bucharest',
    region: 'ro-bucharest', jurisdiction: 'EU/RO', localOwner: 'platform-team', trustRoots: ['signer/platform-release'],
    hosts: [{ hostId: 7, role: 'standalone' }], status: 'active' }, requester);
  const agent = service.registerAgent(site.id, { agentId: 'edge-a', certificateFingerprint: digest('a'),
    runbookAllowlist: ['collect_inventory'], updateRing: 'canary', state: 'active' }, requester);
  return { db, approvals, service, site, agent };
}
function approve(db, approvals, approvalId) {
  const payloadHash = db.prepare('SELECT payload_hash payloadHash FROM infrastructure_approval_requests WHERE id=?').get(approvalId).payloadHash;
  return approvals.decideApproval(approvalId, { payloadHash, decision: 'approved', reason: 'independent operational review' }, approver);
}

describe('V6.5b edge sovereignty and resilient remote operations (B336-B345)', () => {
  test('B336 residency policy records decisions and blocks synchronization outside the allowed zone', () => {
    const { db, service, site } = setup(); service.saveResidencyPolicy(site.id, { zone: 'EU/RO', categoryRules: {
      inventory: ['EU/RO'], logs: ['EU/RO'], metrics: ['EU/RO'], backups: ['EU/RO'] } }, requester);
    expect(service.evaluateResidency(site.id, { dataCategory: 'logs', destinationJurisdiction: 'US/VA' }, requester))
      .toMatchObject({ decision: 'blocked', failClosed: true });
    service.saveSyncPolicy(site.id, { bandwidthKbps: 128, maxBatchBytes: 1048576,
      priorityOrder: ['inventory','event','metric','artifact'] }, requester);
    service.bufferEvents(site.id, { agentId: 'edge-a', events: [{ eventId: 'log-1', category: 'event',
      occurredAt: new Date().toISOString(), payload: { message: 'bounded evidence' } }] }, requester);
    expect(() => service.createSyncPlan(site.id, { destinationJurisdiction: 'US/VA' }, requester))
      .toThrow(expect.objectContaining({ code: 'EDGE_RESIDENCY_BLOCKED' }));
    expect(service.createSyncPlan(site.id, { destinationJurisdiction: 'EU/RO' }, requester))
      .toMatchObject({ destinationJurisdiction: 'EU/RO', residencyEvidence: [{ dataCategory: 'logs', decision: 'allowed' }] }); db.close();
  });

  test('B337 disconnected identity emits only hash-bound short grants with four-eyes activation', () => {
    const { db, service, site } = setup(); const policy = service.saveIdentityCachePolicy(site.id, { issuerRef: 'oidc/romprix',
      normalTtlSeconds: 600, emergencyTtlSeconds: 180, normalScopes: ['inventory.read','events.write'],
      emergencyScopes: ['inventory.read','health.write'] }, requester);
    expect(policy).toMatchObject({ storesBearerTokens: false, storesPasswords: false, requireFourEyesEmergency: true });
    const grant = service.issueIdentityGrant(site.id, { subjectRef: 'user/bogdan.pricop', assertionHash: digest('b'),
      scopes: ['inventory.read'], mode: 'emergency', ttlSeconds: 120, reason: 'WAN outage', ticketRef: 'INC-336' }, requester);
    expect(grant).toMatchObject({ state: 'pending_activation', tokenReturnedByApi: false, passwordStored: false });
    expect(() => service.activateIdentityGrant(grant.id, { grantHash: grant.grantHash, confirmation: grant.subjectRef }, requester))
      .toThrow(expect.objectContaining({ code: 'FOUR_EYES_REQUIRED' }));
    expect(service.activateIdentityGrant(grant.id, { grantHash: grant.grantHash, confirmation: grant.subjectRef }, approver))
      .toMatchObject({ state: 'active', activatedBy: 2, tokenReturnedByApi: false }); db.close();
  });

  test('B338 site-local vault stores references only and signs edge-agent resolution plans', () => {
    const { db, service, site, agent } = setup(); const adapter = service.saveVaultAdapter(site.id, { name: 'site-vault',
      providerKind: 'hashicorp_vault', endpointRef: 'https://vault.edge.internal', namespaceRef: 'sites/bucharest', authMethod: 'mtls',
      certificateFingerprint: digest('c'), allowedPurposes: ['bmc.power','backup.read'] }, requester);
    expect(adapter).toMatchObject({ credentialsStoredCentrally: false, providerKind: 'hashicorp_vault' });
    const plan = service.createSecretResolutionPlan(adapter.id, { agentRecordId: agent.id, secretRef: 'kv/bmc/edge-node',
      purpose: 'bmc.power', expiresAt: future(180000) }, requester);
    expect(plan).toMatchObject({ resolutionLocation: 'edge_agent', secretReturnedByApi: false, providerMutationsStarted: 0 });
    expect(() => service.saveVaultAdapter(site.id, { name: 'bad-vault', providerKind: 'local_tpm', endpointRef: 'tpm/site',
      authMethod: 'tpm_attestation', allowedPurposes: ['bmc.power'], password: 'inline' }, requester))
      .toThrow(expect.objectContaining({ code: 'EDGE_SECRET_MATERIAL' })); db.close();
  });

  test('B339 single-node profile exposes HA caveats and blocks unsafe capacity evidence', () => {
    const { db, service, site } = setup(); const profile = service.saveSingleNodeProfile(site.id, { minimumCpuMillicores: 1000,
      minimumMemoryMiB: 2048, minimumStorageGiB: 20 }, requester);
    expect(profile).toMatchObject({ haAvailable: false, automaticUpgrade: false, requireExternalBackup: true });
    expect(service.assessSingleNode(site.id, { nodeCount: 1, cpuMillicores: 2000, memoryMiB: 4096, storageGiB: 100,
      externalBackupVerified: false, maintenanceWindowDeclared: true }, requester)).toMatchObject({ state: 'blocked', applySupported: false });
    expect(service.assessSingleNode(site.id, { nodeCount: 1, cpuMillicores: 2000, memoryMiB: 4096, storageGiB: 100,
      externalBackupVerified: true, maintenanceWindowDeclared: true }, requester)).toMatchObject({ state: 'ready', haAvailable: false }); db.close();
  });

  test('B340 quorum view computes majority, witness participation and failure-domain risk read-only', () => {
    const { db, service, site } = setup(); const snapshot = service.recordQuorumSnapshot(site.id, { clusterRef: 'cluster/edge-a', observedAt: new Date().toISOString(), members: [
      { memberRef: 'node/a', role: 'voter', healthy: true, failureDomain: 'rack/a' },
      { memberRef: 'node/b', role: 'voter', healthy: true, failureDomain: 'rack/a' },
      { memberRef: 'witness/c', role: 'witness', healthy: false, failureDomain: 'cloud/eu' }] }, requester);
    expect(snapshot).toMatchObject({ requiredVotes: 2, availableVotes: 2, state: 'at_risk',
      risks: ['no_vote_margin'], readOnlyEvidence: true, providerMutationsStarted: 0 }); db.close();
  });

  test('B341 reservation assessment protects system CPU, memory and storage headroom', () => {
    const { db, service, site } = setup(); service.saveReservationPolicy(site.id, { systemCpuMillicores: 500,
      systemMemoryMiB: 1024, systemStorageGiB: 10, maxWorkloadPercent: 75, evictionFreeStoragePercent: 15 }, requester);
    expect(service.assessReservations(site.id, { capacity: { cpuMillicores: 4000, memoryMiB: 8192, storageGiB: 100 },
      workload: { cpuMillicores: 2500, memoryMiB: 5000, storageGiB: 70 } }, requester)).toMatchObject({ state: 'compliant', applySupported: false });
    expect(service.assessReservations(site.id, { capacity: { cpuMillicores: 4000, memoryMiB: 8192, storageGiB: 100 },
      workload: { cpuMillicores: 3800, memoryMiB: 8000, storageGiB: 95 } }, requester)).toMatchObject({ state: 'blocked' }); db.close();
  });

  test('B342 low-bandwidth console stays serial/text first and disables clipboard, files and implicit launch', () => {
    const { db, service, site } = setup(); const profile = service.saveConsoleProfile(site.id, { transportOrder: ['serial','text','html5'],
      maxBandwidthKbps: 128, maxFps: 5, colorDepth: 8, adaptiveQuality: true, idleTtlSeconds: 300,
      clipboardEnabled: true, fileTransferEnabled: true }, requester);
    expect(profile).toMatchObject({ transportOrder: ['serial','text','html5'], clipboardEnabled: false,
      fileTransferEnabled: false, launchSupported: false, sessionTokenReturned: false }); db.close();
  });

  test('B343 remote-hands checklist requires payload-bound approval by a different administrator', () => {
    const { db, approvals, service, site } = setup(); const plan = service.createRemoteHandsPlan(site.id, { targetRef: 'host/edge-node',
      checklist: ['Confirm asset label', 'Connect serial console', 'Photograph status LEDs'], consoleRef: 'serial/rack-a',
      expiresAt: future(3600000), assigneeUserId: approver.id }, requester);
    expect(plan).toMatchObject({ state: 'pending_approval', centralExecutionSupported: false, providerMutationsStarted: 0 }); approve(db, approvals, plan.approvalId);
    expect(() => service.authorizeRemoteHands(plan.id, { approvalId: plan.approvalId, confirmation: plan.targetRef }, requester))
      .toThrow(expect.objectContaining({ code: 'FOUR_EYES_REQUIRED' }));
    expect(service.authorizeRemoteHands(plan.id, { approvalId: plan.approvalId, confirmation: plan.targetRef }, approver))
      .toMatchObject({ state: 'ready_for_local_operator', authorizedBy: 2, executionLocation: 'local_operator' }); db.close();
  });

  test('B344 BMC inventory binds a host to Redfish and keeps credentials in the local vault', () => {
    const { db, service, site } = setup(); const vault = service.saveVaultAdapter(site.id, { name: 'bmc-vault', providerKind: 'local_tpm',
      endpointRef: 'tpm/bucharest', authMethod: 'tpm_attestation', allowedPurposes: ['bmc.power'] }, requester);
    const endpoint = service.saveBmcEndpoint(site.id, { hostId: 7, name: 'edge-node-bmc', protocol: 'redfish',
      endpointRef: 'redfish/edge-node', vaultAdapterId: vault.id, credentialRef: 'kv/bmc/edge-node', owner: 'local-operations' }, requester);
    expect(endpoint).toMatchObject({ credentialsStoredCentrally: false, protocol: 'redfish' });
    const inventory = service.recordBmcInventory(endpoint.id, { powerState: 'on', manufacturer: 'Dell', model: 'R650', serialNumber: 'ABC123',
      firmware: { bios: '2.4.1', bmc: '6.10' }, sensors: { temperature: { state: 'ok', celsius: 31 } }, health: 'ok', observedAt: new Date().toISOString() }, requester);
    expect(inventory).toMatchObject({ health: 'ok', collectionLocation: 'edge_agent', credentialsReturned: false }); db.close();
  });

  test('B345 BMC recovery blocks missing safeguards then emits a four-eyes JIT edge envelope without execution', () => {
    const { db, approvals, service, site } = setup(); const vault = service.saveVaultAdapter(site.id, { name: 'bmc-vault', providerKind: 'local_tpm',
      endpointRef: 'tpm/bucharest', authMethod: 'tpm_attestation', allowedPurposes: ['bmc.power'] }, requester);
    const endpoint = service.saveBmcEndpoint(site.id, { hostId: 7, name: 'edge-node-bmc', protocol: 'redfish', endpointRef: 'redfish/edge-node',
      vaultAdapterId: vault.id, credentialRef: 'kv/bmc/edge-node', owner: 'local-operations' }, requester);
    const base = { actionKey: 'power_cycle', reason: 'Host console frozen after approved maintenance', ticketRef: 'INC-345', expiresAt: future(600000) };
    expect(service.createBmcRecoveryPlan(endpoint.id, { ...base, safeguards: { targetIdentityMatched: true } }, requester))
      .toMatchObject({ state: 'blocked', approvalId: null, providerMutationsStarted: 0 });
    const plan = service.createBmcRecoveryPlan(endpoint.id, { ...base, expiresAt: future(590000), assigneeUserId: approver.id, safeguards: {
      targetIdentityMatched: true, fencingVerified: true, quorumSafe: true, workloadsEvacuated: true, recentBackupVerified: true } }, requester);
    expect(plan).toMatchObject({ state: 'pending_approval', centralBmcExecutionSupported: false }); approve(db, approvals, plan.approvalId);
    expect(service.authorizeBmcRecovery(plan.id, { approvalId: plan.approvalId, confirmation: endpoint.endpointRef }, approver))
      .toMatchObject({ state: 'ready_for_edge_agent', executionLocation: 'edge_agent', credentialResolution: 'site_local_vault',
        centralBmcExecutionSupported: false, providerMutationsStarted: 0 }); db.close();
  });
});
