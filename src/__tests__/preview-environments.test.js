'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-dash-previews-'));
process.env.APP_SECRET = 'preview-test-secret';
process.env.ENCRYPTION_KEY = 'preview-test-encryption-key-32';
process.env.DB_PATH = ':memory:';
process.env.DATA_DIR = testDataDir;

const { getDb, closeDb } = require('../db');
const git = require('../services/git');
const previews = require('../services/preview-environments');

let stack;
let hostId;

beforeAll(() => {
  const db = getDb();
  const adminId = Number(db.prepare(
    "INSERT INTO users (username,password_hash,role) VALUES ('preview-admin','hash','admin')"
  ).run().lastInsertRowid);
  hostId = db.prepare("SELECT id FROM docker_hosts WHERE is_default=1").get().id;
  const created = git.createStack({
    stack_name: 'preview-app', repo_url: 'https://github.com/acme/preview-app.git',
    branch: 'main', compose_path: 'compose.yml', target_host_ids: [hostId],
    deploy_immediately: false, created_by: adminId,
  });
  stack = git.getStack(created.id);
});

afterEach(() => jest.restoreAllMocks());
afterAll(() => { closeDb(); fs.rmSync(testDataDir, { recursive: true, force: true }); });

function payload(overrides = {}) {
  return {
    number: 42,
    repository: {
      full_name: 'acme/preview-app',
      clone_url: 'https://github.com/acme/preview-app.git',
    },
    pull_request: {
      head: {
        ref: 'feature/safe-preview', sha: 'a'.repeat(40),
        repo: { clone_url: 'https://github.com/acme/preview-app.git' },
      },
    },
    ...overrides,
  };
}

describe('pull-request preview environments', () => {
  it('stores an isolated preview-only environment and masks sensitive values', () => {
    const config = previews.updateConfig(stack.id, {
      enabled: true, host_id: hostId, ttl_minutes: 60,
      cpu_limit: 0.5, memory_limit_mb: 256,
      url_template: 'https://pr-{pr}.{stack}.example.test',
      variables: [
        { key: 'PREVIEW_MODE', value: 'true', sensitive: false },
        { key: 'PREVIEW_TOKEN', value: 'preview-secret', sensitive: true },
      ],
    });
    expect(config.variables).toEqual([
      { key: 'PREVIEW_MODE', value: 'true', sensitive: false },
      { key: 'PREVIEW_TOKEN', value: '••••••••', sensitive: true },
    ]);
    expect(getDb().prepare('SELECT env_encrypted FROM git_preview_configs WHERE stack_id=?').get(stack.id).env_encrypted)
      .not.toContain('preview-secret');
  });

  it('fails closed for forks and repository mismatches', () => {
    const config = previews.getConfig(stack.id, { includeValues: true });
    expect(() => previews.validatePullRequest(stack, config, payload({
      pull_request: {
        head: { ref: 'fork', sha: 'b'.repeat(40), repo: { clone_url: 'https://github.com/other/fork.git' } },
      },
    }))).toThrow('forks are disabled');
    expect(() => previews.validatePullRequest(stack, config, payload({
      repository: { full_name: 'evil/repo', clone_url: 'https://github.com/evil/repo.git' },
    }))).toThrow('does not match');
    previews.updateConfig(stack.id, { allow_forks: true });
    const allowed = previews.validatePullRequest(stack, previews.getConfig(stack.id, { includeValues: true }), payload({
      pull_request: {
        head: { ref: 'fork', sha: 'b'.repeat(40), repo: { clone_url: 'https://github.com/contributor/fork.git' } },
      },
    }));
    expect(allowed).toMatchObject({ fork: true, headRepositoryUrl: 'https://github.com/contributor/fork.git' });
    previews.updateConfig(stack.id, { allow_forks: false });
  });

  it('deploys with resource guardrails and never copies production stack overrides', async () => {
    git.updateStack(stack.id, { env_overrides: { PROD_SECRET: { value: 'encrypted-prod', sensitive: true } } });
    const previewDir = path.join(testDataDir, 'fake-preview');
    fs.mkdirSync(previewDir, { recursive: true });
    fs.writeFileSync(path.join(previewDir, 'compose.yml'), 'services:\n  web:\n    image: nginx:alpine\n');
    jest.spyOn(git, 'preparePreviewCheckout').mockResolvedValue({
      directory: previewDir, commit: 'a'.repeat(40), stack: git.getStack(stack.id),
    });
    jest.spyOn(git, 'getPreviewDirectory').mockReturnValue(previewDir);
    const cleanup = jest.fn();
    jest.spyOn(git, 'getDockerCliEnvironment').mockReturnValue({ env: {}, cleanup });
    const execute = jest.spyOn(git, '_execFile').mockReturnValue('');

    const queued = previews.queuePullRequest(git.getStack(stack.id), payload());
    const deployed = await queued.completion;
    expect(deployed.status).toBe('running');
    expect(execute).toHaveBeenCalledWith('docker', expect.arrayContaining([
      'compose', '--env-file', path.join(previewDir, '.env.preview'), '-p', 'ddp-preview-app-pr42', 'up', '-d', '--remove-orphans',
    ]), expect.any(Object));
    const envFile = fs.readFileSync(path.join(previewDir, '.env.preview'), 'utf8');
    expect(envFile).toContain('PREVIEW_TOKEN="preview-secret"');
    expect(envFile).not.toContain('PROD_SECRET');
    const override = fs.readFileSync(path.join(previewDir, '.docker-dash-preview.yml'), 'utf8');
    expect(override).toContain('docker-dash.protect');
    expect(override).toContain('mem_limit: 256m');
    expect(override).toContain('pids_limit: 256');
    expect(execute.mock.calls[0][2].env.APP_SECRET).toBeUndefined();
    expect(execute.mock.calls[0][2].env.COMPOSE_DISABLE_ENV_FILE).toBe('1');
    expect(cleanup).toHaveBeenCalled();
  });

  it('rejects host escape options and applies guardrails to services from every Compose file', () => {
    const root = fs.mkdtempSync(path.join(testDataDir, 'compose-policy-'));
    const primary = path.join(root, 'compose.yml');
    const extra = path.join(root, 'compose.extra.yml');
    fs.writeFileSync(primary, 'services:\n  web:\n    image: nginx:alpine\n');
    fs.writeFileSync(extra, 'services:\n  worker:\n    image: alpine\n');
    const override = previews._internals._guardrailOverride(
      [primary, extra], { id: 9, pr_number: 7 }, { cpu_limit: 1, memory_limit_mb: 128 }, root
    );
    expect(override).toContain('web:');
    expect(override).toContain('worker:');
    expect(override.match(/pids_limit: 256/g)).toHaveLength(2);

    fs.writeFileSync(primary, 'services:\n  escape:\n    image: alpine\n    privileged: true\n');
    expect(() => previews._internals._validatePreviewCompose([primary], root))
      .toThrow('cannot use privileged');
    fs.writeFileSync(primary, 'services:\n  escape:\n    image: alpine\n    volumes:\n      - /:/host\n');
    expect(() => previews._internals._validatePreviewCompose([primary], root))
      .toThrow('cannot use bind mounts');
  });
});
