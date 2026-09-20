'use strict';

process.env.APP_SECRET = 'workstation-fleet-test-secret';
process.env.ENCRYPTION_KEY = 'workstation-fleet-test-encryption-key';

const Database = require('better-sqlite3');
const migration = require('../db/migrations/171_workstation_fleet');
const { WorkstationFleetService, _internals } = require('../services/workstation-fleet');

const admin = { id: 1, username: 'admin', role: 'admin' };
const digest = character => `sha256:${character.repeat(64)}`;

function database() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE governance_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      permission_key TEXT NOT NULL UNIQUE,
      resource_type TEXT NOT NULL,
      verb TEXT NOT NULL,
      description TEXT
    );
    CREATE TABLE edge_sites (id INTEGER PRIMARY KEY,slug TEXT UNIQUE,name TEXT);
    INSERT INTO edge_sites (id,slug,name) VALUES (1,'bucharest','Bucharest');
  `);
  migration.up(db);
  return db;
}

function inventory(bootcDigest = digest('a')) {
  return {
    organizations: [{ id: 1, name: 'Public Org' }],
    locations: [{ id: 2, name: 'Bucharest' }],
    hostGroups: [{ id: 3, name: 'EU OS Canary' }],
    contentViews: [{ id: 4, name: 'EU OS Content' }],
    lifecycleEnvironments: [{ id: 5, name: 'Canary' }],
    hosts: [{
      id: 42, name: 'ws-042.example.test', organization_name: 'Public Org',
      location_name: 'Bucharest', hostgroup_name: 'EU OS Canary',
      operatingsystem_name: 'Fedora Kinoite', architecture_name: 'x86_64',
      ip: '10.20.30.42', mac: '02:00:00:00:00:42', global_status_label: 'OK',
      last_report: '2026-08-05T08:00:00.000Z', updated_at: '2026-08-05T08:00:00.000Z',
      realm_name: 'EU-OS.INTERNAL',
      content_facet_attributes: { lifecycle_environment_name: 'Canary', content_view_name: 'EU OS Content', applicable_errata: 0 },
      facts: { secure_boot: true, tpm_present: true, disk_encrypted: true,
        selinux_state: 'enforcing', identity_enrolled: true, patch_age_days: 2,
        bootc_digest: bootcDigest, bootc_version: '42.20260805' },
    }],
    warnings: [],
  };
}

function registryFixture() {
  return {
    get: jest.fn(() => ({ id: 7, url: 'https://registry.example.test' })),
    manifest: jest.fn(async () => ({
      digest: digest('b'),
      manifest: {
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        config: { digest: digest('c') },
        annotations: {
          'org.opencontainers.image.source': 'https://gitlab.example/eu-os/image',
          'org.opencontainers.image.version': '42.20260805',
          'org.opencontainers.image.base.name': 'quay.io/fedora/fedora-kinoite:42',
          'org.opencontainers.image.base.digest': digest('d'),
        },
      },
    })),
    blob: jest.fn(async () => ({ architecture: 'amd64', os: 'linux',
      config: { Labels: { 'containers.bootc': '1' } } })),
    referrers: jest.fn(async () => [
      { artifactType: 'application/vnd.dev.cosign.simplesigning.v1+json', digest: digest('e') },
      { artifactType: 'application/vnd.cyclonedx+json', digest: digest('f') },
    ]),
  };
}

function clientFixture(currentDigest = digest('a')) {
  return {
    status: jest.fn(async () => ({ ok: true, version: '3.16.0', status: 'available' })),
    inventory: jest.fn(async () => inventory(currentDigest)),
    jobTemplateContract: jest.fn(async () => ({ templateId: '101', valid: true, missingInputs: [], rawTemplateReturned: false })),
    runRemoteJob: jest.fn(async () => ({ taskRef: 'job-9001' })),
    job: jest.fn(async () => ({ taskRef: 'job-9001', state: 'success' })),
    host: jest.fn(async () => inventory(digest('b')).hosts[0]),
  };
}

describe('workstation fleet migration and bootc evidence', () => {
  test('migration is idempotent and seeds four permissions', () => {
    const db = database();
    migration.up(db);
    expect(db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name LIKE 'workstation_%'").get().count).toBe(7);
    expect(db.prepare("SELECT COUNT(*) count FROM governance_permissions WHERE permission_key LIKE 'workstation_fleet.%'").get().count).toBe(4);
    migration.down(db);
    expect(db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name LIKE 'workstation_%'").get().count).toBe(0);
    db.close();
  });

  test('bootc evidence distinguishes bootable images and bounded SBOM/signature referrers', () => {
    const result = _internals.bootcEvidence({
      digest: digest('a'),
      manifest: { mediaType: 'application/vnd.oci.image.manifest.v1+json', annotations: {
        'org.opencontainers.image.version': '42', 'org.opencontainers.image.sbom': 'https://sbom.example/test.json',
      } },
      configBlob: { architecture: 'amd64', os: 'linux', config: { Labels: { 'containers.bootc': '1' } } },
      referrers: [{ artifactType: 'application/vnd.cyclonedx+json', digest: digest('b') },
        { artifactType: 'application/vnd.dev.cosign.simplesigning.v1+json', digest: digest('c') }],
      trust: {},
    });
    expect(result).toMatchObject({ bootcDetected: true, architecture: 'amd64', signaturePresent: true });
    expect(result.sbomRefs).toHaveLength(2);
  });
});

describe('workstation fleet service', () => {
  let db; let client; let service;
  beforeEach(() => {
    db = database();
    client = clientFixture();
    service = new WorkstationFleetService(() => db, {
      clientFactory: () => client,
      registry: registryFixture(),
      trustVerifier: jest.fn(() => ({ policy: 'cosign', passed: true, cryptographicallyVerified: true,
        signer: 'signer/platform-release', outputHash: '9'.repeat(64) })),
      mutationsEnabled: true,
      allowedTemplates: ['101', '102'],
      now: () => Date.parse('2026-08-05T09:00:00.000Z'),
    });
  });
  afterEach(() => db.close());

  function connection() {
    return service.saveConnection({ name: 'Foreman EU', baseUrl: 'https://foreman.example.test',
      authType: 'token', secret: 'top-secret-token', tlsVerify: true }, admin);
  }

  test('connection profiles require HTTPS, encrypt secrets and return only secret presence', async () => {
    expect(() => service.saveConnection({ name: 'bad', baseUrl: 'http://foreman.example.test' }, admin))
      .toThrow(expect.objectContaining({ code: 'FOREMAN_HTTPS_REQUIRED' }));
    const saved = connection();
    expect(saved).toMatchObject({ baseUrl: 'https://foreman.example.test', hasSecret: true, tlsVerify: true });
    expect(saved.secret).toBeUndefined();
    const stored = db.prepare('SELECT secret_encrypted FROM workstation_foreman_connections WHERE id=?').get(saved.id);
    expect(stored.secret_encrypted).not.toContain('top-secret-token');
    await expect(service.testConnection(saved.id, admin)).resolves.toMatchObject({ ok: true });
  });

  test('read-only sync maps location to Edge Site and calculates workstation posture', async () => {
    const saved = connection();
    service.saveMapping(saved.id, { sourceKind: 'location', sourceRef: 'Bucharest', edgeSiteId: 1, scopeRef: 'site/bucharest' }, admin);
    const result = await service.syncConnection(saved.id, admin);
    expect(result).toMatchObject({ run: { state: 'success', counts: { workstations: 1 } }, networkMode: 'read_only' });
    const device = service.devices({}, admin)[0];
    expect(device).toMatchObject({ name: 'ws-042.example.test', edgeSiteId: 1, scopeRef: 'site/bucharest',
      bootcDigest: digest('a'), posture: { state: 'pass', score: 100 } });
    expect(client.inventory).toHaveBeenCalledTimes(1);
  });

  test('mapping changes immediately remap synchronized devices and invalidate prior evidence', async () => {
    const saved = connection();
    await service.syncConnection(saved.id, admin);
    const before = service.devices({}, admin)[0];
    expect(before.edgeSiteId).toBeNull();
    const mapping = service.saveMapping(saved.id, { sourceKind: 'location', sourceRef: 'Bucharest',
      edgeSiteId: 1, scopeRef: 'site/bucharest' }, admin);
    const mapped = service.devices({ siteId: 1, hostGroup: 'EU OS Canary' }, admin)[0];
    expect(mapped).toMatchObject({ edgeSiteId: 1, scopeRef: 'site/bucharest' });
    expect(mapped.sourceHash).not.toBe(before.sourceHash);
    expect(service.removeMapping(mapping.id, admin)).toMatchObject({ removed: true, connectionId: saved.id });
    expect(service.devices({}, admin)[0].edgeSiteId).toBeNull();
  });

  test('registry inspection requires bootc, stores SBOM evidence and enforces canary before stable', async () => {
    connection();
    await expect(service.inspectRegistryArtifact({ registryId: 7, repository: 'eu-os/image', sourceRef: 'latest',
      name: 'EU OS 42', signaturePolicy: 'cosign' }, admin))
      .rejects.toMatchObject({ code: 'BOOTC_SIGNER_POLICY_REQUIRED' });
    const artifact = await service.inspectRegistryArtifact({ registryId: 7, repository: 'eu-os/image', sourceRef: 'latest',
      name: 'EU OS 42', signaturePolicy: 'cosign', signerPattern: '^signer/' }, admin);
    expect(artifact).toMatchObject({ digest: digest('b'),
      imageReference: `registry.example.test/eu-os/image@${digest('b')}`,
      bootcDetected: true, signatureState: 'verified',
      channel: 'held', signer: 'signer/platform-release' });
    expect(artifact.sbomRefs).toEqual([expect.objectContaining({ kind: 'referrer', digest: digest('f') })]);
    expect(() => service.promoteArtifact(artifact.id, { channel: 'stable', reason: 'skip' }, admin))
      .toThrow(expect.objectContaining({ code: 'BOOTC_CANARY_REQUIRED' }));
    expect(service.promoteArtifact(artifact.id, { channel: 'canary', reason: 'signed lab canary' }, admin).channel).toBe('canary');
    expect(service.promoteArtifact(artifact.id, { channel: 'stable', reason: 'canary evidence passed' }, admin).channel).toBe('stable');
    expect(service.artifacts(admin)[0].promotionCount).toBe(2);
    expect(service.artifactPromotions(artifact.id, { limit: 100 }, admin).promotions).toEqual([
      expect.objectContaining({ fromChannel: 'canary', toChannel: 'stable', reason: 'canary evidence passed' }),
      expect.objectContaining({ fromChannel: 'held', toChannel: 'canary', reason: 'signed lab canary' }),
    ]);
    expect(() => service.artifactPromotions(artifact.id, { limit: 101 }, admin))
      .toThrow(expect.objectContaining({ code: 'WORKSTATION_INPUT_INVALID' }));
  });

  test('guarded update is hash/idempotency bound and succeeds only after post-read digest verification', async () => {
    const saved = connection();
    await service.syncConnection(saved.id, admin);
    const artifact = await service.inspectRegistryArtifact({ registryId: 7, repository: 'eu-os/image',
      sourceRef: 'latest', name: 'EU OS 42', signaturePolicy: 'cosign', signerPattern: '^signer/' }, admin);
    service.promoteArtifact(artifact.id, { channel: 'canary', reason: 'approved canary' }, admin);
    const device = service.devices({}, admin)[0];
    expect(() => service.saveConnection({ id: saved.id, baseUrl: 'https://different-foreman.example.test' }, admin))
      .toThrow(expect.objectContaining({ code: 'FOREMAN_CONNECTION_IDENTITY_LOCKED' }));
    const input = { artifactId: artifact.id, action: 'update', remoteJobTemplateId: '101',
      maintenanceWindowRef: 'MW-2026-08-05', approvalRef: 'CHG-42', idempotencyKey: 'update-ws-042-0001' };
    const plan = service.createUpdatePlan(device.id, input, admin);
    expect(service.createUpdatePlan(device.id, input, admin)).toMatchObject({ id: plan.id, duplicate: true });
    expect(() => service.createUpdatePlan(device.id, { ...input, approvalRef: 'CHG-different' }, admin))
      .toThrow(expect.objectContaining({ code: 'WORKSTATION_IDEMPOTENCY_CONFLICT' }));
    expect(service.planPreflight(plan.id, admin)).toMatchObject({ ready: true, blockers: [],
      requirements: { planHash: plan.planHash, typedConfirmation: device.name }, networkCallsStarted: 0 });
    await expect(service.executePlan(plan.id, { planHash: 'wrong', confirmation: device.name }, admin))
      .rejects.toMatchObject({ code: 'WORKSTATION_PLAN_HASH_MISMATCH' });
    client.jobTemplateContract.mockResolvedValueOnce({ templateId: '101', valid: false,
      missingInputs: ['docker_dash_plan_hash'], rawTemplateReturned: false });
    await expect(service.executePlan(plan.id, { planHash: plan.planHash, confirmation: device.name }, admin))
      .rejects.toMatchObject({ code: 'FOREMAN_JOB_TEMPLATE_CONTRACT_INVALID',
        details: { missingInputs: ['docker_dash_plan_hash'] } });
    expect(service.plans(admin)[0].state).toBe('planned');
    let releaseSubmit;
    client.runRemoteJob.mockImplementationOnce(() => new Promise(resolve => {
      releaseSubmit = () => resolve({ taskRef: 'job-9001' });
    }));
    const execution = service.executePlan(plan.id, { planHash: plan.planHash, confirmation: device.name }, admin);
    await new Promise(resolve => setImmediate(resolve));
    expect(releaseSubmit).toEqual(expect.any(Function));
    await expect(service.executePlan(plan.id, { planHash: plan.planHash, confirmation: device.name }, admin))
      .resolves.toMatchObject({ state: 'running', taskRef: null, duplicate: true, submissionPending: true });
    await expect(service.reconcilePlan(plan.id, admin)).resolves.toMatchObject({ state: 'running',
      taskRef: null, submissionPending: true, networkCallsStarted: 0 });
    expect(() => service.removeConnection(saved.id, admin))
      .toThrow(expect.objectContaining({ code: 'FOREMAN_CONNECTION_ACTIVE_WORKFLOW' }));
    expect(client.runRemoteJob).toHaveBeenCalledTimes(1);
    releaseSubmit();
    const running = await execution;
    expect(running).toMatchObject({ state: 'running', taskRef: 'job-9001', credentialsReturned: false, remoteOutputStored: false });
    service.saveConnection({ id: saved.id, tlsVerify: false }, admin);
    await expect(service.reconcilePlan(plan.id, admin)).rejects.toMatchObject({ code: 'FOREMAN_TLS_REQUIRED_FOR_MUTATION' });
    service.saveConnection({ id: saved.id, tlsVerify: true }, admin);
    const completed = await service.reconcilePlan(plan.id, admin);
    expect(completed).toMatchObject({ state: 'succeeded', postReadDigest: digest('b'), postReadVerified: true });
    expect(client.runRemoteJob).toHaveBeenCalledWith(expect.objectContaining({
      targetImageRef: `registry.example.test/eu-os/image@${digest('b')}`,
      targetDigest: digest('b'), idempotencyKey: input.idempotencyKey, planHash: plan.planHash,
      approvalRef: input.approvalRef, maintenanceWindowRef: input.maintenanceWindowRef }));
    expect(client.jobTemplateContract).toHaveBeenCalledWith('101');
  });

  test('mutation flag and template allowlist fail closed', async () => {
    const saved = connection();
    await service.syncConnection(saved.id, admin);
    const artifact = await service.inspectRegistryArtifact({ registryId: 7, repository: 'eu-os/image',
      sourceRef: 'latest', name: 'EU OS 42', signaturePolicy: 'cosign', signerPattern: '^signer/' }, admin);
    service.promoteArtifact(artifact.id, { channel: 'canary', reason: 'approved canary' }, admin);
    const device = service.devices({}, admin)[0];
    const closed = new WorkstationFleetService(() => db, { clientFactory: () => client,
      mutationsEnabled: false, allowedTemplates: ['101'], now: () => Date.parse('2026-08-05T09:00:00.000Z') });
    expect(() => closed.createUpdatePlan(device.id, { artifactId: artifact.id, action: 'update',
      remoteJobTemplateId: 'bootc-update', maintenanceWindowRef: 'MW-invalid', approvalRef: 'CHG-invalid',
      idempotencyKey: 'invalid-template-0001' }, admin)).toThrow(expect.objectContaining({ code: 'FOREMAN_JOB_TEMPLATE_ID_INVALID' }));
    expect(() => closed.createUpdatePlan(device.id, { artifactId: artifact.id, action: 'update',
      remoteJobTemplateId: '101', maintenanceWindowRef: 'MW-invalid', approvalRef: 'CHG-1; reboot',
      idempotencyKey: 'invalid-trace-0001' }, admin)).toThrow(expect.objectContaining({ code: 'WORKSTATION_INPUT_INVALID' }));
    const plan = closed.createUpdatePlan(device.id, { artifactId: artifact.id, action: 'update',
      remoteJobTemplateId: '101', maintenanceWindowRef: 'MW-1', approvalRef: 'CHG-1',
      idempotencyKey: 'closed-update-0001' }, admin);
    expect(closed.planPreflight(plan.id, admin)).toMatchObject({ ready: false,
      blockers: expect.arrayContaining([expect.objectContaining({ code: 'WORKSTATION_MUTATIONS_DISABLED' })]) });
    await expect(closed.executePlan(plan.id, { planHash: plan.planHash, confirmation: device.name }, admin))
      .rejects.toMatchObject({ code: 'WORKSTATION_MUTATIONS_DISABLED' });
    expect(closed.cancelPlan(plan.id, { reason: 'Maintenance approval was withdrawn' }, admin))
      .toMatchObject({ state: 'cancelled', errorCode: 'WORKSTATION_PLAN_CANCELLED',
        errorMessage: 'Maintenance approval was withdrawn', duplicate: false, networkCallsStarted: 0 });
    expect(closed.cancelPlan(plan.id, { reason: 'Repeated request' }, admin)).toMatchObject({ state: 'cancelled', duplicate: true });
    expect(closed.planPreflight(plan.id, admin)).toMatchObject({ ready: false,
      blockers: expect.arrayContaining([expect.objectContaining({ code: 'WORKSTATION_PLAN_STATE' })]) });
  });

  test('stale device evidence and unverified Foreman TLS block remote workflows', async () => {
    const saved = connection();
    await service.syncConnection(saved.id, admin);
    const artifact = await service.inspectRegistryArtifact({ registryId: 7, repository: 'eu-os/image',
      sourceRef: 'latest', name: 'EU OS 42', signaturePolicy: 'cosign', signerPattern: '^signer/' }, admin);
    service.promoteArtifact(artifact.id, { channel: 'canary', reason: 'approved canary' }, admin);
    const device = service.devices({}, admin)[0];
    const stale = new WorkstationFleetService(() => db, { clientFactory: () => client, mutationsEnabled: true,
      allowedTemplates: ['101'], evidenceMaxAgeMs: 24 * 60 * 60_000,
      now: () => Date.parse('2026-08-07T09:00:00.000Z') });
    expect(() => stale.createUpdatePlan(device.id, { artifactId: artifact.id, action: 'update',
      remoteJobTemplateId: '101', maintenanceWindowRef: 'MW-stale', approvalRef: 'CHG-stale',
      idempotencyKey: 'stale-update-0001' }, admin)).toThrow(expect.objectContaining({ code: 'WORKSTATION_EVIDENCE_STALE' }));

    const plan = service.createUpdatePlan(device.id, { artifactId: artifact.id, action: 'update',
      remoteJobTemplateId: '101', maintenanceWindowRef: 'MW-tls', approvalRef: 'CHG-tls',
      idempotencyKey: 'tls-update-0001' }, admin);
    service.saveConnection({ id: saved.id, tlsVerify: false }, admin);
    expect(service.planPreflight(plan.id, admin)).toMatchObject({ ready: false,
      blockers: expect.arrayContaining([expect.objectContaining({ code: 'FOREMAN_TLS_REQUIRED_FOR_MUTATION' })]) });
    await expect(service.executePlan(plan.id, { planHash: plan.planHash, confirmation: device.name }, admin))
      .rejects.toMatchObject({ code: 'FOREMAN_TLS_REQUIRED_FOR_MUTATION' });
  });

  test('running workflows terminate locally after the bounded Foreman timeout without another network call', async () => {
    const saved = connection();
    await service.syncConnection(saved.id, admin);
    const artifact = await service.inspectRegistryArtifact({ registryId: 7, repository: 'eu-os/image',
      sourceRef: 'latest', name: 'EU OS 42', signaturePolicy: 'cosign', signerPattern: '^signer/' }, admin);
    service.promoteArtifact(artifact.id, { channel: 'canary', reason: 'approved canary' }, admin);
    const device = service.devices({}, admin)[0];
    const plan = service.createUpdatePlan(device.id, { artifactId: artifact.id, action: 'update',
      remoteJobTemplateId: '101', maintenanceWindowRef: 'MW-timeout', approvalRef: 'CHG-timeout',
      idempotencyKey: 'timeout-update-0001' }, admin);
    await service.executePlan(plan.id, { planHash: plan.planHash, confirmation: device.name }, admin);
    db.prepare("UPDATE workstation_update_plans SET started_at='2026-08-05T07:00:00.000Z' WHERE id=?").run(plan.id);
    service._jobTimeoutMs = 60 * 60_000;
    client.job.mockClear();
    expect(await service.reconcilePlan(plan.id, admin)).toMatchObject({ state: 'failed',
      errorCode: 'FOREMAN_JOB_TIMEOUT', timedOut: true, networkCallsStarted: 0 });
    expect(client.job).not.toHaveBeenCalled();
    const submissionPlan = service.createUpdatePlan(device.id, { artifactId: artifact.id, action: 'update',
      remoteJobTemplateId: '101', maintenanceWindowRef: 'MW-submit-timeout', approvalRef: 'CHG-submit-timeout',
      idempotencyKey: 'submission-timeout-0002' }, admin);
    db.prepare(`UPDATE workstation_update_plans SET state='running',task_ref=NULL,
      started_at='2026-08-05T07:00:00.000Z' WHERE id=?`).run(submissionPlan.id);
    expect(await service.reconcilePlan(submissionPlan.id, admin)).toMatchObject({ state: 'failed',
      errorCode: 'FOREMAN_JOB_SUBMISSION_TIMEOUT', timedOut: true, networkCallsStarted: 0 });
    expect(client.job).not.toHaveBeenCalled();
  });

  test('failed trust reinspection demotes a canary and invalidates its existing plan', async () => {
    const saved = connection();
    await service.syncConnection(saved.id, admin);
    const artifact = await service.inspectRegistryArtifact({ registryId: 7, repository: 'eu-os/image',
      sourceRef: 'latest', name: 'EU OS 42', signaturePolicy: 'cosign', signerPattern: '^signer/' }, admin);
    service.promoteArtifact(artifact.id, { channel: 'canary', reason: 'approved canary' }, admin);
    const device = service.devices({}, admin)[0];
    const plan = service.createUpdatePlan(device.id, { artifactId: artifact.id, action: 'update',
      remoteJobTemplateId: '101', maintenanceWindowRef: 'MW-trust', approvalRef: 'CHG-trust',
      idempotencyKey: 'trust-update-0001' }, admin);
    service._trustVerifier = jest.fn(() => ({ policy: 'none', passed: true, cryptographicallyVerified: false }));
    const reinspected = await service.inspectRegistryArtifact({ registryId: 7, repository: 'eu-os/image',
      sourceRef: 'latest', name: 'EU OS 42', signaturePolicy: 'none' }, admin);
    expect(reinspected).toMatchObject({ channel: 'held', signatureState: 'present' });
    expect(db.prepare('SELECT COUNT(*) count FROM workstation_artifact_promotions WHERE artifact_id=?').get(artifact.id).count).toBe(2);
    await expect(service.executePlan(plan.id, { planHash: plan.planHash, confirmation: device.name }, admin))
      .rejects.toMatchObject({ code: 'WORKSTATION_ARTIFACT_EVIDENCE_CHANGED' });
  });
});
