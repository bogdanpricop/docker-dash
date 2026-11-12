'use strict';

// Tests for v7.5.0 registry push + manifest extensions in
// src/services/registry.js. Uses an in-memory SQLite + a hand-rolled
// dockerService stub (we don't need real Docker to verify the call shape).

process.env.APP_SECRET = 'test-secret-key-for-jest-tests-only';
process.env.DB_PATH = ':memory:';
// Encryption key required by the registry service to encrypt/decrypt the
// stored password.
process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef';

jest.resetModules();

describe('registry service — push + manifest (v7.5.0)', () => {
  let db, registryService;

  beforeAll(() => {
    const { getDb } = require('../db');
    db = getDb();
    registryService = require('../services/registry');
    db.prepare(
      `INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')`
    ).run();
  });

  afterAll(() => {
    const { closeDb } = require('../db');
    closeDb();
  });

  beforeEach(() => {
    db.prepare('DELETE FROM registries').run();
  });

  describe('_authConfigForRegistry', () => {
    it('returns dockerode-shaped authconfig with decrypted password', () => {
      const id = registryService.create({
        name: 'local',
        url: 'http://registry.local:5000',
        username: 'alice',
        password: 's3cret',
        createdBy: 1,
      });
      const reg = registryService.get(id);
      const auth = registryService._authConfigForRegistry(reg);
      expect(auth).toEqual({
        username: 'alice',
        password: 's3cret',
        serveraddress: 'http://registry.local:5000',
      });
    });

    it('returns empty username + password when registry has no creds', () => {
      const id = registryService.create({
        name: 'public',
        url: 'http://registry.local:5000',
        createdBy: 1,
      });
      const reg = registryService.get(id);
      const auth = registryService._authConfigForRegistry(reg);
      expect(auth).toEqual({
        username: '',
        password: '',
        serveraddress: 'http://registry.local:5000',
      });
    });
  });

  describe('pushImage', () => {
    function _makeFakeDockerService(opts = {}) {
      const tagCalls = [];
      const pushCalls = [];
      const fakeStream = { _fake: true };
      const docker = {
        getImage: (name) => ({
          tag: (tagOpts, cb) => {
            tagCalls.push({ name, tagOpts });
            if (opts.tagFails) return cb(new Error('tag-broke'));
            cb(null);
          },
          push: (pushOpts, cb) => {
            pushCalls.push({ name, pushOpts });
            if (opts.pushFails) return cb(new Error('push-broke'));
            cb(null, fakeStream);
          },
        }),
      };
      return {
        getDocker: () => docker,
        _calls: { tag: tagCalls, push: pushCalls },
        _fakeStream: fakeStream,
      };
    }

    it('throws when registry id is unknown', async () => {
      const fake = _makeFakeDockerService();
      await expect(
        registryService.pushImage(fake, 0, 99999, 'src:latest', 'team/app', 'v1')
      ).rejects.toThrow(/Registry not found/);
    });

    it('throws on missing required arguments', async () => {
      const fake = _makeFakeDockerService();
      const id = registryService.create({ name: 'r', url: 'http://r:5000', createdBy: 1 });
      await expect(registryService.pushImage(fake, 0, id, '', 'team/app', 'v1'))
        .rejects.toThrow(/sourceImage required/);
      await expect(registryService.pushImage(fake, 0, id, 'src', '', 'v1'))
        .rejects.toThrow(/targetRepo required/);
      await expect(registryService.pushImage(fake, 0, id, 'src', 'repo', ''))
        .rejects.toThrow(/targetTag required/);
    });

    it('tags + pushes with the registry host and full image name', async () => {
      const fake = _makeFakeDockerService();
      const id = registryService.create({
        name: 'r', url: 'http://registry.local:5000',
        username: 'u', password: 'p', createdBy: 1,
      });
      const result = await registryService.pushImage(fake, 0, id, 'myapp:latest', 'team/myapp', 'v1.2.3');
      expect(result.fullImage).toBe('registry.local:5000/team/myapp:v1.2.3');
      expect(result.registry).toBe('r');
      expect(result.stream).toBe(fake._fakeStream);

      // Tag was called on the source with the registry-prefixed repo
      expect(fake._calls.tag).toEqual([{
        name: 'myapp:latest',
        tagOpts: { repo: 'registry.local:5000/team/myapp', tag: 'v1.2.3' },
      }]);

      // Push was called on the new full name with the right authconfig
      expect(fake._calls.push).toHaveLength(1);
      expect(fake._calls.push[0].name).toBe('registry.local:5000/team/myapp:v1.2.3');
      expect(fake._calls.push[0].pushOpts.authconfig).toEqual({
        username: 'u',
        password: 'p',
        serveraddress: 'http://registry.local:5000',
      });
    });

    it('surfaces a clear error when the tag step fails', async () => {
      const fake = _makeFakeDockerService({ tagFails: true });
      const id = registryService.create({ name: 'r', url: 'http://r:5000', createdBy: 1 });
      await expect(
        registryService.pushImage(fake, 0, id, 'src:latest', 'repo', 'tag')
      ).rejects.toThrow(/Tag failed: tag-broke/);
    });

    it('surfaces a clear error when the push init fails', async () => {
      const fake = _makeFakeDockerService({ pushFails: true });
      const id = registryService.create({ name: 'r', url: 'http://r:5000', createdBy: 1 });
      await expect(
        registryService.pushImage(fake, 0, id, 'src:latest', 'repo', 'tag')
      ).rejects.toThrow(/Push init failed: push-broke/);
    });

    it('updates last_used_at on success', async () => {
      const fake = _makeFakeDockerService();
      const id = registryService.create({ name: 'r', url: 'http://r:5000', createdBy: 1 });
      await registryService.pushImage(fake, 0, id, 'src:latest', 'repo', 'tag');
      const reg = registryService.get(id);
      expect(reg.last_used_at).toBeTruthy();
    });
  });

  // v7.6.0 — deleteTag uses _apiCall under the hood. We can't easily mock
  // _apiCall without restructuring the service, so these tests cover the
  // input-validation paths only (the HTTP path is exercised manually on
  // staging with the deployed Distribution registry).
  describe('deleteTag — argument validation (v7.6.0)', () => {
    it('throws when registry id is unknown', async () => {
      await expect(registryService.deleteTag(99999, 'repo', 'tag'))
        .rejects.toThrow(/Registry not found/);
    });

    it('throws when repo missing', async () => {
      const id = registryService.create({ name: 'r', url: 'http://r:5000', createdBy: 1 });
      await expect(registryService.deleteTag(id, '', 'tag')).rejects.toThrow(/repository and tag required/);
    });

    it('throws when tag missing', async () => {
      const id = registryService.create({ name: 'r', url: 'http://r:5000', createdBy: 1 });
      await expect(registryService.deleteTag(id, 'repo', '')).rejects.toThrow(/tag required/);
    });
  });
});
