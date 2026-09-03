'use strict';

process.env.ENCRYPTION_KEY = 'provider-artifact-test-key-32-characters';

const Database = require('better-sqlite3');
const migration = require('../db/migrations/112_provider_artifact_catalog');
const catalog = require('../services/provider-sdk/artifact-catalog');

describe('Provider artifact catalog', () => {
  let database;
  beforeEach(() => {
    database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    database.exec(`CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY, name TEXT);
      INSERT INTO docker_hosts (id, name) VALUES (7, 'xcp-a')`);
    migration.up(database);
  });
  afterEach(() => database.close());

  it('persists an opaque stable identity while keeping native references private', () => {
    const context = {
      host: { id: 7 }, providerType: 'xen', observedAt: '2026-07-26T12:00:00.000Z', database,
      raw: { kind: 'vmTemplate', nativeRef: 'OpaqueRef:secret-template', uuid: 'template-uuid', name: 'Debian 13', cpuCount: 2, memoryBytes: 2147483648 },
    };
    const first = catalog.normalizeAndRemember(context);
    const second = catalog.normalizeAndRemember({ ...context, raw: { ...context.raw, name: 'Debian 13 updated' } });
    expect(first.id).toMatch(/^dda_art_[a-f0-9]{26}$/);
    expect(second.id).toBe(first.id);
    expect(second.displayName).toBe('Debian 13 updated');
    expect(JSON.stringify(second)).not.toContain('OpaqueRef');
    const row = database.prepare('SELECT * FROM provider_artifact_catalog').get();
    expect(row.native_ref_enc).not.toContain('OpaqueRef');
    expect(row.native_ref_hash).toHaveLength(64);
    expect(database.prepare('SELECT COUNT(*) AS count FROM provider_artifact_catalog').get().count).toBe(1);
    const resolved = catalog.resolveArtifact(first.id, { hostId: 7 }, database);
    expect(resolved).toEqual(expect.objectContaining({
      nativeRef: 'OpaqueRef:secret-template', providerUuid: 'template-uuid',
      artifact: expect.objectContaining({ id: first.id, displayName: 'Debian 13 updated' }),
    }));
    expect(catalog.resolveArtifact(first.id, { hostId: 8 }, database)).toBeNull();
  });

  it('rejects unknown artifact kinds and invalid public envelopes', () => {
    expect(() => catalog.normalizeAndRemember({
      host: { id: 7 }, providerType: 'xen', observedAt: new Date().toISOString(), database,
      raw: { kind: 'secretBlob', nativeRef: 'x', name: 'x' },
    })).toThrow(/invalid/);
    expect(() => catalog.validateArtifact({ schemaVersion: '1.0', kind: 'iso', id: 'native-path' }))
      .toThrow(/Invalid normalized artifact/);
  });
});
