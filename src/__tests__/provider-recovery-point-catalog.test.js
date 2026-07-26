'use strict';

process.env.ENCRYPTION_KEY = 'provider-recovery-test-key-32-chars';

const Database = require('better-sqlite3');
const identityMigration = require('../db/migrations/106_provider_resource_identities');
const recoveryMigration = require('../db/migrations/117_provider_recovery_points');
const identityStore = require('../services/provider-sdk/identity-store');
const catalog = require('../services/provider-sdk/recovery-point-catalog');

describe('Provider recovery-point catalog', () => {
  let database;
  beforeEach(() => {
    database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    database.exec(`CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY, name TEXT);
      INSERT INTO docker_hosts (id, name) VALUES (7, 'xo-a')`);
    identityMigration.up(database);
    recoveryMigration.up(database);
  });
  afterEach(() => database.close());

  it('keeps repository, archive and workload native references encrypted', () => {
    const workload = identityStore.remember({
      hostId: 7, providerType: 'xen', kind: 'virtualMachine',
      nativeRef: 'OpaqueRef:vm-secret', uuid: 'vm-uuid', stability: 'stable',
    }, database);
    const repositoryResult = catalog.normalizeRepositoryAndRemember({
      host: { id: 7 }, providerType: 'xen', database, observedAt: '2026-07-26T10:00:00Z',
      raw: { nativeRef: 'remote-secret-id', name: 'Off-site repository', type: 'xo', enabled: true },
    });
    const point = catalog.normalizeRecoveryPointAndRemember({
      host: { id: 7 }, providerType: 'xen', database, observedAt: '2026-07-26T10:00:00Z',
      repository: repositoryResult.repository,
      raw: {
        nativeRef: 'remote-secret-id/xo-vm-backups/vm-uuid/archive.json',
        repositoryRef: 'remote-secret-id', workloadRef: 'OpaqueRef:vm-secret',
        workloadUuid: 'vm-uuid', workloadName: 'Accounting', createdAt: 1785056400000,
        sizeBytes: 1024, mode: 'delta', verification: null,
      },
    });
    expect(repositoryResult.repository.id).toMatch(/^ddr_repo_[a-f0-9]{26}$/);
    expect(point.id).toMatch(/^ddr_rp_[a-f0-9]{26}$/);
    expect(point.workload.id).toBe(workload.id);
    expect(point.verification.state).toBe('unknown');
    const publicJson = JSON.stringify({ repository: repositoryResult.repository, point });
    expect(publicJson).not.toContain('remote-secret-id');
    expect(publicJson).not.toContain('OpaqueRef');
    const stored = database.prepare('SELECT native_ref_enc, workload_ref_enc FROM provider_recovery_points').get();
    expect(stored.native_ref_enc).not.toContain('remote-secret-id');
    expect(stored.workload_ref_enc).not.toContain('OpaqueRef');
  });

  it('uses stable opaque IDs and conservative verification states', () => {
    const context = {
      host: { id: 7 }, providerType: 'xen', database, observedAt: '2026-07-26T10:00:00Z',
      raw: { nativeRef: 'repo-a', name: 'Repository A', type: 'xo' },
    };
    const first = catalog.normalizeRepositoryAndRemember(context);
    const second = catalog.normalizeRepositoryAndRemember({ ...context, raw: { ...context.raw, name: 'Repository renamed' } });
    expect(second.repository.id).toBe(first.repository.id);
    expect(second.repository.displayName).toBe('Repository renamed');
    expect(catalog._internals._verification('success')).toEqual({ state: 'verified', checkedAt: null });
    expect(catalog._internals._verification(true).state).toBe('verified');
    expect(catalog._internals._verification(false).state).toBe('unverified');
    expect(catalog._internals._verification('corrupt').state).toBe('failed');
    expect(catalog._internals._verification(undefined).state).toBe('unknown');
    expect(() => catalog.validateRecoveryPoint({ schemaVersion: '1.0', kind: 'recoveryPoint', id: 'native-ref' }))
      .toThrow(/Invalid normalized recovery point/);
  });
});
