'use strict';

jest.mock('../config', () => ({ features: { providerSecurityAssurance: true } }));
jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('inject database'); }) }));
jest.mock('../services/provider-sdk/registry', () => ({}));

const Database = require('better-sqlite3');
const migration = require('../db/migrations/167_provider_security_assurance');
const service = require('../services/provider-sdk/security-assurance');

const host = { id: 7, name: 'pve-primary', daemon_type: 'proxmox' };
const targetHostId = `ddr_host_${'a'.repeat(26)}`;
const otherHostId = `ddr_host_${'b'.repeat(26)}`;
const vmId = `ddr_vm_${'c'.repeat(26)}`;
const artifactId = `dda_art_${'d'.repeat(26)}`;

describe('provider security assurance evidence control plane', () => {
  let db; let registry;

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
      INSERT INTO users VALUES (9);
      INSERT INTO docker_hosts VALUES (7,'pve-primary','proxmox',1),(8,'other','proxmox',1);
      INSERT INTO provider_resource_identities VALUES
        ('${targetHostId}',7,'host'),('${otherHostId}',8,'host'),('${vmId}',7,'virtualMachine');
      INSERT INTO provider_resource_snapshots VALUES
        ('${targetHostId}','pve-node-a','2026-07-31T10:00:00Z'),
        ('${otherHostId}','other-node','2026-07-31T10:00:00Z'),
        ('${vmId}','payments','2026-07-31T10:00:00Z');
      INSERT INTO provider_artifact_catalog VALUES ('${artifactId}',7,'trusted-template');`);
    migration.up(db);
    registry = { capabilitiesForHost: jest.fn(async () => ({
      provider: { type: 'proxmox', endpointId: 7 }, features: {
        'security.confidentialVm.plan': { state: 'unsupported', reason: 'No creation adapter' },
      },
    })) };
  });

  afterEach(() => db.close());

  function options(extra = {}) {
    return { database: db, registry, enabled: true, createdBy: 9, canOperate: true, ...extra };
  }

  it('normalizes versioned evidence and treats missing domains as unknown', async () => {
    const saved = service.upsertEvidence(host, {
      resourceKind: 'virtualMachine', resourceId: vmId, source: 'provider',
      observedAt: new Date().toISOString(), facts: {
        secureBoot: { capable: true, enabled: true, compliant: true, firmware: 'uefi' },
        vtpm: { present: true, version: '2.0', state: 'ready', migrationSupported: null,
          cloneSupported: null },
      },
    }, options());
    expect(saved).toEqual(expect.objectContaining({ created: true, networkCallsStarted: 0 }));
    expect(saved.evidence.pack).toEqual({ key: 'proxmox-security', version: '1.0.0' });
    const result = await service.assuranceForHost(host, options());
    expect(result.coverage).toEqual({ endpoint: 0, host: 0, virtualMachine: 1, artifact: 0 });
    expect(result.items[0].controls).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'secure_boot', state: 'pass' }),
      expect.objectContaining({ id: 'vtpm', state: 'pass' }),
    ]));
    expect(result.items[0].facts.encryption).toBeUndefined();
    expect(result.limitations.join(' ')).toContain('absence is unknown');
  });

  it('registers only symbolic key references and rejects inline credentials', () => {
    expect(() => service.upsertKeyProvider(host, {
      name: 'Unsafe', providerKind: 'external_kms', endpointOrigin: 'https://kms.example.test',
      secretRef: 'client-secret-value', health: { state: 'healthy' },
    }, options())).toThrow(expect.objectContaining({ code: 'INVALID_KEY_PROVIDER' }));

    const result = service.upsertKeyProvider(host, {
      name: 'Primary KMS', providerKind: 'external_kms', endpointOrigin: 'https://kms.example.test',
      secretRef: 'vault://virtualization/kms/client', health: {
        state: 'healthy', observedAt: new Date().toISOString(),
        certificateExpiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
      }, affectedResourceIds: [vmId],
    }, options());
    expect(result.keyProvider).toEqual(expect.objectContaining({
      endpointOrigin: 'https://kms.example.test', secretRefHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      affectedResourceIds: [vmId],
    }));
    expect(result.keyProvider).not.toHaveProperty('secretRef');
    expect(JSON.stringify(result)).not.toContain('vault://virtualization/kms/client');
  });

  it('normalizes virtual hardware, protocol, certificate trust and exposure evidence', async () => {
    service.upsertEvidence(host, { resourceKind: 'virtualMachine', resourceId: vmId,
      observedAt: new Date().toISOString(), facts: {
        virtualHardware: { baselineKey: 'vm-security-v1', baselineVersion: '1.0.0',
          firmware: 'uefi', bootOrder: ['disk'], legacySettings: [],
          devices: [{ id: 'scsi0', kind: 'virtio-disk', state: 'compliant' }] },
        transport: { services: [{ id: 'management-api', protocol: 'https', port: 443,
          tlsVersion: '1.2', authentication: 'certificate', certificateState: 'valid',
          legacyApi: false }] },
        certificateTrust: { certificates: [{ id: 'management', subject: 'CN=pve-primary',
          chainState: 'valid', sanState: 'valid', expiryState: 'valid', algorithm: 'RSA-3072/SHA-256',
          algorithmState: 'pass', renewalOwner: 'platform-security',
          expiresAt: new Date(Date.now() + 90 * 86400000).toISOString() }] },
        exposure: { criticality: 'critical', reachability: 'restricted', protections: ['mfa'] },
      } }, options());
    const result = await service.assuranceForHost(host, options());
    expect(result.items[0].controls).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'virtual_hardware_baseline', state: 'pass' }),
      expect.objectContaining({ id: 'insecure_protocols', state: 'pass' }),
      expect.objectContaining({ id: 'certificate_trust', state: 'pass' }),
      expect.objectContaining({ id: 'exposure_context', state: 'pass' }),
    ]));
    expect(() => service.upsertEvidence(host, { resourceKind: 'endpoint', facts: {
      transport: { services: [{ id: 'legacy', protocol: 'telnet', port: 23 }] },
    } }, options())).toThrow(expect.objectContaining({ code: 'INVALID_SECURITY_ASSURANCE_EVIDENCE' }));
  });

  it('persists a compatible confidential-VM plan without authorizing creation', async () => {
    const key = service.upsertKeyProvider(host, {
      name: 'Primary KMS', providerKind: 'external_kms', endpointOrigin: 'https://kms.example.test',
      secretRef: 'vault://virtualization/kms/client', health: {
        state: 'healthy', observedAt: new Date().toISOString(),
        certificateExpiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
      },
    }, options()).keyProvider;
    service.upsertEvidence(host, { resourceKind: 'artifact', resourceId: artifactId,
      observedAt: new Date().toISOString(), facts: {
        secureBoot: { enabled: true, firmware: 'uefi' },
        vtpm: { present: true, version: '2.0', state: 'ready' },
        confidential: { compatibleModes: ['sev_snp'] },
      } }, options());
    service.upsertEvidence(host, { resourceKind: 'host', resourceId: targetHostId,
      observedAt: new Date().toISOString(), facts: {
        secureBoot: { capable: true, firmware: 'uefi' },
        encryption: { disks: { state: 'full', total: 2, encrypted: 2 },
          migration: 'encrypted', keyProviderId: key.id },
        confidential: { supportedModes: ['sev_snp'] },
      } }, options());

    const plan = await service.preflightConfidentialProvisioning(host, {
      artifactId, targetHostId, mode: 'sev_snp',
    }, options());
    expect(plan).toEqual(expect.objectContaining({ allowed: true, executionAuthorized: false,
      planHash: expect.stringMatching(/^[a-f0-9]{64}$/) }));
    expect(plan.warnings.map(item => item.code)).toContain('PROVISIONING_EXECUTION_SEPARATE');
    expect(db.prepare('SELECT allowed FROM provider_confidential_provisioning_plans WHERE id=?')
      .get(plan.id).allowed).toBe(1);
  });

  it('fails closed for stale or cross-endpoint evidence', async () => {
    expect(() => service.upsertEvidence(host, { resourceKind: 'endpoint', facts: {
      secureBoot: { enabled: true, unexpectedClaim: true },
    } }, options())).toThrow(expect.objectContaining({ code: 'INVALID_SECURITY_ASSURANCE_EVIDENCE' }));
    expect(() => service.upsertEvidence(host, { resourceKind: 'host', resourceId: otherHostId,
      facts: { secureBoot: { enabled: true } } }, options()))
      .toThrow(expect.objectContaining({ code: 'SECURITY_RESOURCE_SCOPE_MISMATCH' }));
    service.upsertEvidence(host, { resourceKind: 'artifact', resourceId: artifactId,
      observedAt: new Date(Date.now() - 25 * 3600000).toISOString(), facts: {
        secureBoot: { enabled: true }, vtpm: { present: true },
        confidential: { compatibleModes: ['tdx'] },
      } }, options());
    const plan = await service.preflightConfidentialProvisioning(host,
      { artifactId, targetHostId, mode: 'tdx' }, options());
    expect(plan.allowed).toBe(false);
    expect(plan.blockers.map(item => item.code)).toEqual(expect.arrayContaining([
      'TRUSTED_IMAGE_EVIDENCE_STALE', 'CONFIDENTIAL_HOST_EVIDENCE_MISSING',
      'HEALTHY_KEY_PROVIDER_REQUIRED',
    ]));
  });
});
