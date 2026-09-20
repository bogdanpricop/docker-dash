'use strict';

const Database = require('better-sqlite3');
const YAML = require('yaml');
const migration = require('../db/migrations/172_compose_blueprint_catalog');
const { ComposeBlueprintService } = require('../services/compose-blueprints');

const admin = { id: 1, username: 'admin', role: 'admin' };
const operator = { id: 2, username: 'operator', role: 'operator' };
const digest = `sha256:${'a'.repeat(64)}`;

function database() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT);
    INSERT INTO users VALUES (1,'admin','admin'),(2,'operator','operator');
    CREATE TABLE governance_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      permission_key TEXT NOT NULL UNIQUE,
      resource_type TEXT NOT NULL,
      verb TEXT NOT NULL,
      description TEXT
    );
    CREATE TABLE registries (id INTEGER PRIMARY KEY, name TEXT, url TEXT);
    INSERT INTO registries VALUES (7,'Catalog registry','https://registry.example.test');
    CREATE TABLE docker_hosts (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      daemon_type TEXT NOT NULL DEFAULT 'docker'
    );
    INSERT INTO docker_hosts VALUES (11,'prod-docker',1,'docker'),(12,'lab-containerd',1,'containerd');
    CREATE TABLE oci_compose_artifacts (id INTEGER PRIMARY KEY, name TEXT);
  `);
  migration.up(db);
  return db;
}

function serviceFixture({ verified = true } = {}) {
  const db = database();
  const registry = {
    get: jest.fn(id => id === 7 ? { id: 7, name: 'Catalog registry' } : null),
    manifest: jest.fn(async () => ({ digest, manifest: { schemaVersion: 2, annotations: {
      'org.opencontainers.image.source': 'https://github.com/acme/compose-blueprints',
      'org.opencontainers.image.revision': 'abc123',
    } } })),
  };
  const artifacts = new Map();
  const ociCompose = {
    _internals: {
      _validateName: value => {
        const normalized = String(value || '');
        if (!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(normalized)) throw Object.assign(new Error('invalid name'), { status: 400 });
        return normalized;
      },
      _validateRepository: value => {
        const normalized = String(value || '');
        if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,254}$/.test(normalized)) throw Object.assign(new Error('invalid repository'), { status: 400 });
        return normalized;
      },
      _validateReference: value => String(value || 'latest'),
      _validateOverride: value => {
        const document = YAML.parse(String(value || ''));
        if (document?.include) throw Object.assign(new Error('remote include rejected'), { status: 400 });
        if (Object.values(document?.services || {}).some(item => item?.build)) throw Object.assign(new Error('local build rejected'), { status: 400 });
        return value || null;
      },
    },
    verifyTrust: jest.fn(() => ({ policy: 'cosign', passed: verified, cryptographicallyVerified: verified,
      signer: 'https://github.com/acme/compose-blueprints/.github/workflows/release.yml@refs/heads/main' })),
    create: jest.fn(async input => {
      const artifactId = Number(db.prepare('INSERT INTO oci_compose_artifacts (name) VALUES (?)').run(input.name).lastInsertRowid);
      const artifact = { id: artifactId, name: input.name, source_ref: input.source_ref,
        digest: input.source_ref, project_name: input.project_name, override_yaml: input.override_yaml };
      artifacts.set(artifact.id, artifact); return artifact;
    }),
    get: jest.fn(id => artifacts.get(Number(id)) || null),
  };
  const provenanceParser = { parse: jest.fn(() => ({ hasProvenance: true, known: { source: 'https://github.com/acme/compose-blueprints' } })) };
  return { db, registry, ociCompose,
    service: new ComposeBlueprintService(() => db, { registry, ociCompose, provenanceParser }) };
}

const versionInput = (overrides = {}) => ({
  version: '1.0.0', registryId: 7, repository: 'platform/web-compose', sourceRef: 'stable',
  signaturePolicy: 'cosign', signerPattern: '^https://github\\.com/acme/',
  parameterSchema: { parameters: [
    { key: 'port', label: 'Public port', type: 'integer', required: true, minimum: 1, maximum: 65535 },
    { key: 'apiTokenRef', label: 'API token reference', type: 'secret_ref', required: true },
  ] },
  overrideTemplate: 'services:\n  web:\n    environment:\n      PORT: "{{parameter.port}}"\n      API_TOKEN: "{{parameter.apiTokenRef}}"\n',
  compatibility: { daemonTypes: ['docker'], architectures: ['amd64'], environments: ['development', 'production'],
    minimumComposeVersion: '2.34.0', requiresCosign: true },
  changelog: 'Initial signed release',
  ...overrides,
});

async function published(fixture) {
  const created = fixture.service.save(null, { slug: 'web-app', name: 'Web app', description: 'Signed application',
    category: 'application', owner: 'platform-team' }, admin);
  const version = await fixture.service.createVersion(created.blueprint.id, versionInput(), admin);
  fixture.service.transitionVersion(created.blueprint.id, version.version.id, 'published', admin);
  return { blueprintId: created.blueprint.id, versionId: version.version.id };
}

describe('Compose blueprint catalog migration', () => {
  test('is idempotent, seeds permissions and removes only its own objects', () => {
    const db = database();
    migration.up(db);
    expect(db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name LIKE 'compose_blueprint%'").get().count).toBe(3);
    expect(db.prepare("SELECT COUNT(*) count FROM governance_permissions WHERE permission_key LIKE 'compose_blueprint.%'").get().count).toBe(3);
    migration.down(db);
    expect(db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name LIKE 'compose_blueprint%'").get().count).toBe(0);
    db.close();
  });
});

describe('Compose blueprint service', () => {
  let fixture;
  afterEach(() => fixture?.db.close());

  test('creates immutable digest-pinned versions and publishes only verified Cosign evidence', async () => {
    fixture = serviceFixture();
    const ids = await published(fixture);
    const detail = fixture.service.get(ids.blueprintId, operator, true);
    expect(detail.blueprint).toMatchObject({ lifecycle: 'active', currentVersionId: ids.versionId });
    expect(detail.versions[0]).toMatchObject({ digest, state: 'published', signaturePolicy: 'cosign' });
    expect(detail.versions[0].versionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(fixture.registry.manifest).toHaveBeenCalledWith(7, 'platform/web-compose', 'stable');
  });

  test('rejects publishing without cryptographic trust and rejects inline secret template content', async () => {
    fixture = serviceFixture({ verified: false });
    const blueprint = fixture.service.save(null, { slug: 'blocked-app', name: 'Blocked app', description: '',
      category: 'application', owner: 'security' }, admin).blueprint;
    const created = await fixture.service.createVersion(blueprint.id, versionInput(), admin);
    expect(() => fixture.service.transitionVersion(blueprint.id, created.version.id, 'published', admin))
      .toThrow(expect.objectContaining({ code: 'VERIFIED_SIGNATURE_REQUIRED' }));
    await expect(fixture.service.createVersion(blueprint.id, versionInput({
      version: '1.0.1', parameterSchema: { parameters: [] },
      overrideTemplate: 'services:\n  web:\n    environment:\n      API_TOKEN: hard-coded-secret\n',
    }), admin)).rejects.toMatchObject({ code: 'SECRET_REFERENCE_ADMISSION_FAILED' });
  });

  test('renders deterministic previews and enforces typed parameters, host and environment compatibility', async () => {
    fixture = serviceFixture();
    const ids = await published(fixture);
    const input = { hostId: 11, instanceName: 'team-web', projectName: 'team-web', environment: 'production',
      parameters: { port: 8443, apiTokenRef: '${WEB_API_TOKEN}' } };
    const first = fixture.service.preview(ids.versionId, input, operator);
    const second = fixture.service.preview(ids.versionId, input, operator);
    expect(first).toMatchObject({ planHash: second.planHash, parametersHash: second.parametersHash,
      secretReferenceAdmission: { state: 'valid', referenceCount: 1, networkCallsStarted: 0 } });
    expect(first.renderedOverride).toContain('${WEB_API_TOKEN}');
    expect(() => fixture.service.preview(ids.versionId, { ...input,
      parameters: { port: 8443, apiTokenRef: 'inline-secret' } }, operator))
      .toThrow(expect.objectContaining({ code: 'PARAMETER_VALIDATION_FAILED' }));
    expect(() => fixture.service.preview(ids.versionId, { ...input, environment: 'staging' }, operator))
      .toThrow(expect.objectContaining({ code: 'ENVIRONMENT_NOT_COMPATIBLE' }));
    expect(() => fixture.service.preview(ids.versionId, { ...input, hostId: 12 }, operator))
      .toThrow(expect.objectContaining({ code: 'HOST_NOT_COMPATIBLE' }));
  });

  test('instantiates through the OCI boundary with stale-plan and idempotency protection', async () => {
    fixture = serviceFixture();
    const ids = await published(fixture);
    const input = { hostId: 11, instanceName: 'team-web', projectName: 'team-web', environment: 'production',
      parameters: { port: 8443, apiTokenRef: 'vault://apps/team-web/token' } };
    const preview = fixture.service.preview(ids.versionId, input, operator);
    await expect(fixture.service.instantiate(ids.versionId, { ...input, planHash: 'stale', idempotencyKey: 'request-1' }, operator))
      .rejects.toMatchObject({ code: 'STALE_BLUEPRINT_PLAN' });
    const created = await fixture.service.instantiate(ids.versionId, { ...input, planHash: preview.planHash, idempotencyKey: 'request-1' }, operator);
    expect(created).toMatchObject({ deduplicated: false, next: { deployRequiresReviewedPlan: true } });
    expect(fixture.ociCompose.create).toHaveBeenCalledWith(expect.objectContaining({ source_ref: digest,
      signature_policy: 'cosign', host_id: 11 }), operator.id);
    const replay = await fixture.service.instantiate(ids.versionId, { ...input, planHash: preview.planHash, idempotencyKey: 'request-1' }, operator);
    expect(replay.deduplicated).toBe(true);
    expect(fixture.ociCompose.create).toHaveBeenCalledTimes(1);
    const stored = fixture.db.prepare('SELECT * FROM compose_blueprint_instantiations WHERE id=?').get(created.instantiation.id);
    expect(stored.parameters_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain('vault://');
  });

  test('validates schema defaults and keeps arbitrary valid string patterns publishable', async () => {
    fixture = serviceFixture();
    const blueprint = fixture.service.save(null, { slug: 'pattern-app', name: 'Pattern app', description: '',
      category: 'application', owner: 'platform' }, admin).blueprint;
    await expect(fixture.service.createVersion(blueprint.id, versionInput({
      parameterSchema: { parameters: [{ key: 'code', type: 'string', required: true, pattern: '^\\d{4}$' }] },
      overrideTemplate: 'services:\n  web:\n    environment:\n      CODE: "{{parameter.code}}"\n',
    }), admin)).resolves.toMatchObject({ version: { version: '1.0.0' } });
    await expect(fixture.service.createVersion(blueprint.id, versionInput({ version: '1.0.1',
      parameterSchema: { parameters: [{ key: 'replicas', type: 'integer', default: 'many' }] },
      overrideTemplate: 'services:\n  web:\n    deploy:\n      replicas: "{{parameter.replicas}}"\n',
    }), admin)).rejects.toMatchObject({ code: 'PARAMETER_VALIDATION_FAILED' });
  });

  test('compares immutable versions and restores a prior verified catalog default without touching deployments', async () => {
    fixture = serviceFixture();
    const ids = await published(fixture);
    const second = await fixture.service.createVersion(ids.blueprintId, versionInput({ version: '2.0.0',
      operationalProfile: { healthcheck: { required: true, services: ['web'], timeoutSeconds: 90 },
        backupRestore: { mode: 'snapshot', volumeHints: ['app-data'], runbookUrl: 'https://runbooks.example.test/web' },
        resources: { cpuMillicores: 500, memoryMiB: 512, storageGiB: 10 } },
    }), admin);
    fixture.service.transitionVersion(ids.blueprintId, second.version.id, 'published', admin);
    const diff = fixture.service.diff(ids.blueprintId, second.version.id, ids.versionId, operator);
    expect(diff).toMatchObject({ fields: { operationalProfile: true },
      rollback: { catalogOnly: true, restoreVersionId: ids.versionId, deployedApplicationsChanged: false } });
    const restored = fixture.service.transitionVersion(ids.blueprintId, ids.versionId, 'published', admin);
    expect(restored.blueprint).toMatchObject({ currentVersionId: ids.versionId, lifecycle: 'active' });
    expect(restored.versions.find(item => item.id === second.version.id).state).toBe('deprecated');
    expect(fixture.ociCompose.verifyTrust).toHaveBeenCalledTimes(5);
  });
});
