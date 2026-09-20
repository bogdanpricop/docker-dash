'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('child_process', () => ({ execFileSync: jest.fn() }));

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-dash-oci-compose-'));
process.env.APP_SECRET = 'oci-compose-test-secret';
process.env.ENCRYPTION_KEY = 'oci-compose-test-key-32-chars';
process.env.DB_PATH = ':memory:';
process.env.DATA_DIR = testDataDir;

const { execFileSync } = require('child_process');
const { getDb, closeDb } = require('../db');
const registry = require('../services/registry');
const git = require('../services/git');
const oci = require('../services/oci-compose');

let registryId;
let hostId;
let adminId;
const digest = `sha256:${'b'.repeat(64)}`;

beforeAll(() => {
  const db = getDb();
  adminId = Number(db.prepare(
    "INSERT INTO users (username,password_hash,role) VALUES ('oci-admin','hash','admin')"
  ).run().lastInsertRowid);
  hostId = db.prepare('SELECT id FROM docker_hosts WHERE is_default=1').get().id;
  registryId = Number(registry.create({
    name: 'OCI Registry', url: 'https://registry.example.test', username: 'robot', password: 'secret', createdBy: adminId,
  }));
});

beforeEach(() => {
  execFileSync.mockReset();
  jest.spyOn(registry, 'manifest').mockResolvedValue({
    digest, contentType: 'application/vnd.oci.image.manifest.v1+json',
    manifest: { schemaVersion: 2, layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip' }] },
  });
  jest.spyOn(git, 'getDockerCliEnvironment').mockReturnValue({ env: {}, cleanup: jest.fn() });
});

afterEach(() => jest.restoreAllMocks());
afterAll(() => { closeDb(); fs.rmSync(testDataDir, { recursive: true, force: true }); });

describe('OCI Compose artifacts', () => {
  it('does not expose Docker Dash process secrets to Compose interpolation', () => {
    const env = oci._internals._composeCliEnvironment({
      PATH: '/bin', DOCKER_HOST: 'tcp://daemon:2375', APP_SECRET: 'must-not-leak',
    });
    expect(env).toMatchObject({ PATH: '/bin', DOCKER_HOST: 'tcp://daemon:2375', COMPOSE_DISABLE_ENV_FILE: '1' });
    expect(env.APP_SECRET).toBeUndefined();
  });

  it('resolves tags once and stores an immutable digest with provenance', async () => {
    const artifact = await oci.create({
      name: 'billing-oci', registry_id: registryId, repository: 'platform/billing-compose',
      source_ref: 'stable', host_id: hostId, project_name: 'billing-preview', signature_policy: 'none',
    }, adminId);
    expect(artifact.digest).toBe(digest);
    expect(oci._internals._artifactUri(artifact)).toBe(`oci://registry.example.test/platform/billing-compose@${digest}`);
  });

  it('requires a dry-run plan hash before deployment and uses the pinned URI', async () => {
    const artifact = oci.list().find(item => item.name === 'billing-oci');
    execFileSync.mockImplementation((_bin, args) => {
      if (args.includes('version')) return '2.34.2\n';
      if (args.includes('--dry-run')) return '{"status":"planned"}\n';
      return 'started\n';
    });
    const reviewed = oci.plan(artifact.id, adminId);
    expect(reviewed.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(() => oci.deploy(artifact.id, 'bad-hash', adminId)).toThrow('stale');
    const result = oci.deploy(artifact.id, reviewed.planHash, adminId);
    expect(result.artifact.status).toBe('running');
    expect(execFileSync.mock.calls.some(([, args]) => args.includes(`oci://registry.example.test/platform/billing-compose@${digest}`)))
      .toBe(true);
  });

  it('rejects local builds, bind mounts, and unsigned annotation policies', async () => {
    expect(() => oci._internals._validateOverride('services:\n  api:\n    build: .\n')).toThrow('local build');
    expect(() => oci._internals._validateOverride('services:\n  api:\n    image: api\n    volumes:\n      - ./src:/app\n')).toThrow('bind mount');
    await expect(oci.create({
      name: 'unsigned-oci', registry_id: registryId, repository: 'platform/unsigned',
      source_ref: 'latest', host_id: hostId, signature_policy: 'annotation',
    }, adminId)).rejects.toMatchObject({ code: 'SIGNATURE_REQUIRED' });
  });
});
