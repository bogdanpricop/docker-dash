'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-dash-gitops-writeback-'));
process.env.APP_SECRET = 'gitops-writeback-test-secret';
process.env.ENCRYPTION_KEY = 'gitops-writeback-test-key-32';
process.env.DB_PATH = ':memory:';
process.env.DATA_DIR = testDataDir;

const { getDb, closeDb } = require('../db');
const git = require('../services/git');
const writeback = require('../services/gitops-writeback');

let managed;

beforeAll(() => {
  const db = getDb();
  const adminId = Number(db.prepare(
    "INSERT INTO users (username,password_hash,role) VALUES ('writeback-admin','hash','admin')"
  ).run().lastInsertRowid);
  const hostId = db.prepare('SELECT id FROM docker_hosts WHERE is_default=1').get().id;
  const stack = git.createStack({
    stack_name: 'fleet-config-repo', repo_url: 'https://example.test/fleet.git',
    compose_path: 'compose.yml', target_host_ids: [hostId], deploy_immediately: false, created_by: adminId,
  });
  managed = writeback.configure({
    git_stack_id: stack.id, file_path: '.docker-dash/fleet.yaml', enabled: true, auto_writeback: false,
  }, adminId);
});

beforeEach(() => {
  jest.spyOn(git, 'getRemoteStatus').mockResolvedValue({
    localHead: 'abcdef0', remoteHead: 'abcdef0', isUpToDate: true, localAhead: 0, localBehind: 0,
  });
  jest.spyOn(git, 'readComposeFile').mockImplementation(() => {
    throw Object.assign(new Error('Compose file not found'), { status: 404 });
  });
});

afterEach(() => jest.restoreAllMocks());
afterAll(() => { closeDb(); fs.rmSync(testDataDir, { recursive: true, force: true }); });

describe('managed GitOps write-back', () => {
  it('produces deterministic hash-bound plans without generated timestamps', async () => {
    const first = await writeback.plan(managed.id);
    const second = await writeback.plan(managed.id);
    expect(first.planHash).toBe(second.planHash);
    expect(first.document).not.toContain('exportedAt:');
    expect(first.diff).toContain('.docker-dash/fleet.yaml');
  });

  it('rejects stale hashes and pushes without force after review', async () => {
    const reviewed = await writeback.plan(managed.id);
    await expect(writeback.apply(managed.id, { planHash: 'stale' }))
      .rejects.toMatchObject({ code: 'STALE_PLAN' });
    const push = jest.spyOn(git, 'pushToGit').mockResolvedValue({ ok: true, commitHash: '1234567' });
    const result = await writeback.apply(managed.id, {
      planHash: reviewed.planHash, actor: { author: 'Admin <admin@example.test>' },
    });
    expect(result).toMatchObject({ changed: true, commitHash: '1234567' });
    expect(push).toHaveBeenCalledWith(managed.git_stack_id, expect.objectContaining({
      forcePush: false,
      files: expect.objectContaining({ '.docker-dash/fleet.yaml': expect.stringContaining('FleetConfiguration') }),
    }));
  });

  it('fails closed when the managed branch differs from remote', async () => {
    git.getRemoteStatus.mockResolvedValue({ localHead: 'aaaaaaa', remoteHead: 'bbbbbbb', isUpToDate: false });
    await expect(writeback.plan(managed.id)).rejects.toMatchObject({ code: 'REMOTE_CONFLICT' });
  });
});

