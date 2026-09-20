'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.APP_SECRET = 'git-compose-file-test';
process.env.ENCRYPTION_KEY = 'git-compose-file-key-32-characters';
process.env.DB_PATH = ':memory:';

const gitService = require('../services/git');

describe('Git stack Compose file reads', () => {
  let sandbox;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-git-file-'));
    jest.spyOn(gitService, 'getStack').mockReturnValue({
      id: 17, compose_path: 'deploy/compose.yml',
    });
    jest.spyOn(gitService, '_getRepoDir').mockReturnValue(sandbox);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  test('reads the configured YAML file inside the cloned repository', () => {
    fs.mkdirSync(path.join(sandbox, 'deploy'));
    fs.writeFileSync(path.join(sandbox, 'deploy', 'compose.yml'), 'services:\n  web:\n    image: nginx\n');
    expect(gitService.readComposeFile(17)).toEqual({
      path: 'deploy/compose.yml', content: 'services:\n  web:\n    image: nginx\n',
    });
  });

  test('rejects traversal and oversized files', () => {
    expect(() => gitService.readComposeFile(17, '../outside.yml')).toThrow('relative');
    fs.writeFileSync(path.join(sandbox, 'large.yml'), Buffer.alloc(2 * 1024 * 1024 + 1));
    expect(() => gitService.readComposeFile(17, 'large.yml')).toThrow('2 MB');
  });

  test('rejects a Compose file symlink that escapes the repository', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-git-file-outside-'));
    const outsideFile = path.join(outside, 'compose.yml');
    fs.writeFileSync(outsideFile, 'services: {}\n');
    try {
      fs.symlinkSync(outsideFile, path.join(sandbox, 'linked.yml'), 'file');
    } catch (err) {
      fs.rmSync(outside, { recursive: true, force: true });
      if (err.code === 'EPERM' || err.code === 'EACCES') return;
      throw err;
    }
    try {
      expect(() => gitService.readComposeFile(17, 'linked.yml')).toThrow('symbolic link');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
