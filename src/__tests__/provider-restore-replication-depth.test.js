'use strict';

process.env.ENCRYPTION_KEY = 'restore-replication-depth-test-key';

jest.mock('../config', () => ({
  security: { encryptionKey: 'restore-replication-depth-test-key' },
  features: { providerRestoreReplicationDepth: true },
}));
jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('inject database'); }) }));
jest.mock('../services/provider-sdk/registry', () => ({}));

const Database = require('better-sqlite3');
const migration = require('../db/migrations/166_provider_restore_replication_depth');
const service = require('../services/provider-operations/restore-replication-depth');

const pointId = `ddr_rp_${'a'.repeat(26)}`;
const basePointId = `ddr_rp_${'b'.repeat(26)}`;
const vmId = `ddr_vm_${'c'.repeat(26)}`;
const sourceStorageId = `ddr_storage_${'d'.repeat(26)}`;
const targetStorageId = `ddr_storage_${'e'.repeat(26)}`;
const host = { id: 7, name: 'pve-primary', daemon_type: 'proxmox' };

describe('restore depth and replication policy control plane', () => {
  let db; let registry;

  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY);
      CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY,name TEXT,daemon_type TEXT,is_active INTEGER);
      CREATE TABLE provider_recovery_points (
        canonical_id TEXT PRIMARY KEY,host_id INTEGER,provider_type TEXT,recovery_point_json TEXT,observed_at TEXT
      );
      CREATE TABLE provider_resource_identities (
        canonical_id TEXT PRIMARY KEY,host_id INTEGER,resource_kind TEXT
      );
      INSERT INTO users VALUES (9);
      INSERT INTO docker_hosts VALUES (7,'pve-primary','proxmox',1),(8,'pve-dr','proxmox',1);
      INSERT INTO provider_recovery_points VALUES
        ('${pointId}',7,'proxmox','{}','2026-07-31T10:00:00.000Z'),
        ('${basePointId}',7,'proxmox','{}','2026-07-30T10:00:00.000Z');
      INSERT INTO provider_resource_identities VALUES
        ('${vmId}',7,'virtualMachine'),
        ('${sourceStorageId}',7,'storage'),
        ('${targetStorageId}',8,'storage');`);
    migration.up(db);
    registry = { capabilitiesForHost: jest.fn(async () => ({ features: {
      'backup.restore.file': { state: 'unsupported', reason: 'adapter missing', constraints: {} },
      'backup.restore.instant': { state: 'unsupported', reason: 'adapter missing', constraints: {} },
      'backup.restore.differential': { state: 'unsupported', reason: 'adapter missing', constraints: {} },
      'backup.copy.cross_site': { state: 'unsupported', reason: 'adapter missing', constraints: {} },
      'replication.configure': { state: 'unsupported', reason: 'adapter missing', constraints: {} },
    } })) };
  });

  afterEach(() => db.close());

  function options(extra = {}) {
    return { database: db, registry, enabled: true, canOperate: true, createdBy: 9, ...extra };
  }

  it('imports bounded file metadata, rejects traversal and never stores file content', () => {
    expect(() => service.importFileCatalog(host, pointId, { entries: [
      { path: '/etc/../root/secret', type: 'file' },
    ] }, options())).toThrow(expect.objectContaining({ code: 'UNSAFE_RECOVERY_FILE_PATH' }));

    const imported = service.importFileCatalog(host, pointId, {
      state: 'complete', observedAt: '2026-07-31T10:01:00Z', entries: [
        { path: '/', type: 'directory' },
        { path: '/etc', type: 'directory' },
        { path: '/etc/app.conf', type: 'file', sizeBytes: 42,
          checksum: `sha256:${'f'.repeat(64)}`, modifiedAt: '2026-07-31T09:00:00Z' },
      ],
    }, options());
    expect(imported.catalog).toEqual(expect.objectContaining({ entryCount: 3,
      manifestHash: expect.stringMatching(/^[a-f0-9]{64}$/) }));
    const listed = service.listFileEntries(7, pointId, { parent: '/etc' }, options());
    expect(listed.items).toEqual([expect.objectContaining({ path: '/etc/app.conf', sizeBytes: 42 })]);
    expect(JSON.stringify(listed)).not.toContain('secret');
  });

  it('persists deterministic fail-closed plans for every advanced restore mode', async () => {
    service.importFileCatalog(host, pointId, { entries: [{ path: '/etc/app.conf', type: 'file' }] }, options());
    const requests = [
      { kind: 'file_download', paths: ['/etc/app.conf'] },
      { kind: 'file_restore', paths: ['/etc/app.conf'], targetPath: '/safe/restore' },
      { kind: 'instant', networkIsolation: true },
      { kind: 'differential', baseRecoveryPointId: basePointId,
        baseChecksum: `sha256:${'1'.repeat(64)}`, targetIsolated: true },
      { kind: 'cross_site_copy', targetHostId: 8, bandwidthLimitMbps: 50,
        resume: true, verifyChecksum: true },
    ];
    for (const request of requests) {
      const first = await service.preflightDepthForHost(host, pointId, request, options());
      const second = await service.preflightDepthForHost(host, pointId, request, options());
      expect(first.allowed).toBe(false);
      expect(first.planHash).toBe(second.planHash);
      expect(first.blockers.map(item => item.code)).toContain('EXECUTION_ADAPTER_UNAVAILABLE');
    }
    expect(db.prepare('SELECT count(*) AS count FROM provider_restore_depth_plans').get().count).toBe(10);
  });

  it('stores versioned replication drafts and refuses execution enablement', async () => {
    const draft = await service.upsertReplicationPolicy(host, {
      name: 'Payments async DR', targetHostId: 8, mode: 'async', rpoTargetSeconds: 900,
      bandwidthLimitMbps: 100, schedule: '*/15 * * * *', workloadIds: [vmId],
      storageMappings: [{ sourceStorageId, targetStorageId }], enabled: false,
    }, options());
    expect(draft.policy).toEqual(expect.objectContaining({ enabled: false, revision: 1,
      workloadIds: [vmId], policyHash: expect.stringMatching(/^[a-f0-9]{64}$/) }));
    const updated = await service.upsertReplicationPolicy(host, {
      ...draft.policy, name: 'Payments async DR updated', enabled: false,
    }, options());
    expect(updated.policy.revision).toBe(2);
    await expect(service.upsertReplicationPolicy(host, {
      ...updated.policy, enabled: true,
    }, options())).rejects.toMatchObject({ code: 'REPLICATION_EXECUTION_UNAVAILABLE' });
    expect(service.listReplicationPolicies(7, options())).toHaveLength(1);
  });
});
