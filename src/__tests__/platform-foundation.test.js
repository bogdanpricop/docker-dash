'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const migration124 = require('../db/migrations/124_governance_foundation');
const migration149 = require('../db/migrations/149_platform_foundation_content');
const { PlatformFoundationService } = require('../services/platform-foundation');

const admin = { id: 1, username: 'admin', role: 'admin' };
const sha = character => character.repeat(64);
function database() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY,username TEXT UNIQUE,email TEXT,password_hash TEXT,role TEXT,is_active INTEGER DEFAULT 1,display_name TEXT,auth_source TEXT DEFAULT 'local',must_change_password INTEGER DEFAULT 0,created_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE tenants (id INTEGER PRIMARY KEY,slug TEXT UNIQUE,name TEXT,kind TEXT DEFAULT 'internal',usage_mode TEXT DEFAULT 'production',status TEXT DEFAULT 'active',is_default INTEGER DEFAULT 0,trial_expires_at TEXT,created_by TEXT,created_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE user_tenants (user_id INTEGER,tenant_id INTEGER,role TEXT,is_owner INTEGER,created_at TEXT,PRIMARY KEY(user_id,tenant_id));
    CREATE TABLE teams (id INTEGER PRIMARY KEY,name TEXT UNIQUE,description TEXT,created_by INTEGER,created_at TEXT,updated_at TEXT);
    CREATE TABLE team_members (team_id INTEGER,user_id INTEGER,is_leader INTEGER,added_by INTEGER,added_at TEXT,PRIMARY KEY(team_id,user_id));
    INSERT INTO users (id,username,email,password_hash,role) VALUES (1,'admin','admin@test','x','admin');
    INSERT INTO tenants (id,slug,name) VALUES (1,'platform','Platform');
  `); migration124.up(db); migration149.up(db); return db;
}

describe('v8.75 platform foundation and content lifecycle', () => {
  let db; let service;
  beforeEach(() => { db = database(); service = new PlatformFoundationService(() => db); });
  afterEach(() => db.close());

  test('B011 normalizes severity/cursor evidence and deduplicates a native event', () => {
    const body = { providerHostId: 7, providerType: 'proxmox', cursor: 'cursor-1', nativeEventId: 'UPID-1', eventType: 'vm.powered_on', severity: 'info', resourceKey: 'vm:101', occurredAt: '2026-07-30T03:00:00Z', message: 'VM powered on', attributes: { source: 'task-stream' } };
    const first = service.recordEvent(body, admin); const duplicate = service.recordEvent({ ...body, cursor: 'cursor-2' }, admin);
    expect(first).toMatchObject({ duplicate: false, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) }); expect(duplicate).toMatchObject({ id: first.id, duplicate: true });
  });

  test('B012 accepts continuous inventory deltas and rejects cursor gaps', () => {
    const first = service.recordInventoryDelta({ providerHostId: 7, resourceType: 'vm', previousCursor: null, cursor: 'c1', added: [{ resourceKey: 'vm:1', version: '1', etag: 'a', payloadHash: sha('a') }], updated: [], removed: [] }, admin);
    expect(first).toMatchObject({ cursor: 'c1', added: [{ resourceKey: 'vm:1' }], duplicate: false });
    expect(() => service.recordInventoryDelta({ providerHostId: 7, resourceType: 'vm', previousCursor: 'wrong', cursor: 'c2', added: [], updated: [], removed: [] }, admin)).toThrow(expect.objectContaining({ code: 'CURSOR_GAP' }));
  });

  test('B016 evaluates dynamic tag/provider/regex collections against bounded resources', () => {
    const collection = service.saveCollection({ name: 'Production databases', selectors: [{ field: 'tag', operator: 'equals', value: 'production' }, { field: 'name', operator: 'regex', value: '^db-[0-9]+$' }] }, admin);
    const result = service.evaluateCollection(collection.id, { resources: [
      { resourceKey: 'vm:db1', kind: 'vm', name: 'db-01', providerType: 'proxmox', site: 'dc1', state: 'running', tags: ['production'] },
      { resourceKey: 'vm:web1', kind: 'vm', name: 'web-01', providerType: 'proxmox', site: 'dc1', state: 'running', tags: ['production'] },
    ] }, admin);
    expect(result).toMatchObject({ evaluatedResources: 2, members: ['vm:db1'] });
  });

  test('B017 versions typed metadata schemas and values with optimistic concurrency', () => {
    const schema = service.saveMetadataSchema({ schemaKey: 'business.criticality', label: 'Criticality', valueType: 'enum', resourceTypes: ['vm'], required: true, enumValues: ['low','high'], sensitivity: 'internal' }, admin);
    const value = service.setMetadata('vm:db1', schema.schemaKey, { resourceType: 'vm', value: 'high' }, admin);
    expect(value).toMatchObject({ value: 'high', version: 1, sensitivity: 'internal' });
    expect(() => service.setMetadata('vm:db1', schema.schemaKey, { resourceType: 'vm', value: 'low', expectedVersion: 2 }, admin)).toThrow(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
  });

  test('B019 records a canonical relationship graph and calculates downstream impact', () => {
    const graph = service.recordRelationshipGraph({ observedAt: '2026-07-30T03:00:00Z', resources: [
      { resourceKey: 'vm:db1', kind: 'vm', name: 'db-01' }, { resourceKey: 'disk:1', kind: 'disk', name: 'db-root' }, { resourceKey: 'store:1', kind: 'datastore', name: 'ceph' },
    ], edges: [{ source: 'vm:db1', target: 'disk:1', relationship: 'uses' }, { source: 'disk:1', target: 'store:1', relationship: 'backed_by' }] }, admin);
    expect(service.graphImpact(graph.id, 'vm:db1', admin).impacted).toEqual([{ resourceKey: 'disk:1', depth: 1, path: ['uses'] }, { resourceKey: 'store:1', depth: 2, path: ['uses','backed_by'] }]);
  });

  test('B020 detects ownerless, detached and unused resources without cleanup', () => {
    const scan = service.scanHygiene({ scopeKey: 'site:dc1', resources: [
      { resourceKey: 'disk:orphan', kind: 'disk', owner: null, attached: false, usageCount: 0, ageDays: 60 },
      { resourceKey: 'image:old', kind: 'image', owner: 'platform', attached: null, usageCount: 0, ageDays: 90 },
    ] }, admin);
    expect(scan).toMatchObject({ summary: { resources: 2, findings: 3, ownerMissing: 1, detachedDisks: 1, unusedImages: 1 }, cleanupStarted: false });
  });

  test('B023 derives adaptive endpoint concurrency and exhausts at zero remaining', () => {
    const budget = service.observeRateBudget('api.cluster.resources', { providerHostId: 7, limit: 1000, remaining: 0, resetAt: '2026-07-30T04:00:00Z', inFlight: 3, latencyMs: 250, errorRate: 0.02 }, admin);
    expect(budget).toMatchObject({ state: 'exhausted', recommendedConcurrency: 0, observation: { remainingRatio: 0 } });
  });

  test('B034 produces a capability/backing-chain-gated linked clone plan only', () => {
    const plan = service.planLinkedClone({ providerType: 'proxmox', sourceArtifactKey: 'dda_art_base', targetName: 'db-clone', currentStorage: 'ceph', targetStorage: 'ceph', backingDepth: 1, sourceSnapshotState: 'clean', capabilities: { linkedClone: true, sharedBacking: true, maxBackingDepth: 8, requiresSameStorage: true } }, admin);
    expect(plan).toMatchObject({ state: 'ready', backingDepth: 2, blockers: [], providerMutationsStarted: 0, executeEndpoint: null });
  });

  test('B036 saves immutable semantic guest profiles with secret references and rejects passwords', () => {
    const profile = service.saveCustomizationProfile({ name: 'linux-web', version: '1.0.0', osFamily: 'linux', settings: { hostnamePattern: 'web-{index}', timezone: 'Europe/Bucharest', network: { mode: 'dhcp' } }, secretRefs: ['vault://kv/ssh/web#public-key'] }, admin);
    expect(profile).toMatchObject({ version: '1.0.0', secretRefs: ['vault://kv/ssh/web#public-key'], duplicate: false });
    expect(() => service.saveCustomizationProfile({ name: 'bad', version: '1.0.0', osFamily: 'linux', settings: { password: 'secret' }, secretRefs: [] }, admin)).toThrow(expect.objectContaining({ code: 'SECRET_FIELD' }));
  });

  test('B038 ranks compatible provider offerings and selects the best fit', () => {
    const mapping = service.mapFlavor({ profileKey: 'web.medium', providerType: 'openstack', requirements: { cpu: 4, memoryBytes: 8589934592, diskBytes: 53687091200, gpus: 0, architecture: 'x86_64' }, offerings: [
      { offeringKey: 'm1.small', cpu: 2, memoryBytes: 4294967296, diskBytes: 53687091200, gpus: 0, architecture: 'x86_64', costScore: 10 },
      { offeringKey: 'm1.medium', cpu: 4, memoryBytes: 8589934592, diskBytes: 107374182400, gpus: 0, architecture: 'x86_64', costScore: 30 },
    ] }, admin);
    expect(mapping).toMatchObject({ state: 'ready', selectedOfferingKey: 'm1.medium' }); expect(mapping.candidates.find(item => item.offeringKey === 'm1.small').blockers).toContain('cpu_insufficient');
  });

  test('B039 aggregates digest provenance across providers without native references', () => {
    const result = service.recordImageObservations({ observedAt: '2026-07-30T03:00:00Z', observations: [
      { providerHostId: 7, providerType: 'proxmox', artifactKey: 'dda_art_pve', kind: 'diskImage', name: 'ubuntu-24', digestSha256: sha('d'), sizeBytes: 1024, format: 'qcow2', provenance: { library: 'golden' } },
      { providerHostId: 8, providerType: 'vsphere', artifactKey: 'dda_art_vc', kind: 'vmTemplate', name: 'ubuntu-24', digestSha256: sha('d'), sizeBytes: 1024, format: 'vmdk', provenance: { library: 'content-library' } },
    ] }, admin);
    expect(result).toMatchObject({ received: 2, inserted: 2, rawProviderReferencesStored: false }); expect(result.replicas[0].locations).toHaveLength(2);
  });

  test('B040 validates resumable chunk receipts, whole checksum and conversion contract without storing bytes or applying', () => {
    const session = service.createImageUploadSession({ providerHostId: 7, fileName: 'ubuntu.vmdk', totalBytes: 2097152, chunkSize: 1048576, expectedSha256: sha('e'), inputFormat: 'vmdk', targetFormat: 'qcow2', destinationRef: 'ceph.images' }, admin);
    service.recordImageChunk(session.id, { offsetBytes: 0, sizeBytes: 1048576, sha256: sha('1') }, admin);
    service.recordImageChunk(session.id, { offsetBytes: 1048576, sizeBytes: 1048576, sha256: sha('2') }, admin);
    const result = service.finalizeImageUpload(session.id, { observedSha256: sha('e') }, admin);
    expect(result).toMatchObject({ receiptCount: 2, receivedBytes: 2097152, state: 'ready', conversion: { tool: 'qemu-img', inputFormat: 'vmdk', targetFormat: 'qcow2', executor: 'approved-external-data-plane' }, dataBytesStored: 0, providerMutationsStarted: 0, executeEndpoint: null });
    const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'platform-foundation.js'), 'utf8'); expect(routes).not.toMatch(/router\.(?:post|put)\([^\n]*(?:execute|apply|start-import)/i);
  });

  test('migration 149 adds fourteen tables and three governance permissions', () => {
    const tables = db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE sqlite_master.type=? AND name IN ('normalized_provider_events','inventory_delta_syncs','dynamic_resource_collections','custom_metadata_schemas','custom_metadata_values','resource_relationship_graphs','resource_hygiene_scans','provider_rate_limit_budgets','linked_clone_plans','guest_customization_profiles','flavor_offering_mappings','image_library_observations','image_upload_sessions','image_upload_chunk_receipts')").get('table').count;
    const permissions = db.prepare("SELECT COUNT(*) count FROM governance_permissions WHERE permission_key IN ('platform_inventory.manage','platform_metadata.manage','platform_content.manage')").get().count;
    expect({ tables, permissions }).toEqual({ tables: 14, permissions: 3 });
  });
});
