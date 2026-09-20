'use strict';

// Service-layer tests for src/services/registry.js — post-v8.2.0 audit.
//
// Why this file exists:
//   The v8.1.0 "registry hygiene pack" (provenance + retention + remote/virtual
//   typing) made registry.js the structural core of how Docker Dash reasons
//   about images. registry-provenance.test.js and retention.test.js cover the
//   pure-function evaluators; registry-push.test.js + registry-repos.test.js
//   touch a few entry points but don't exercise the SERVICE layer end-to-end.
//
//   This file fills the gap: DB CRUD round-trips, dockerode wrappers, and the
//   _apiCall-based HTTP layer (manifest / deleteTag) — all with mocked I/O so
//   no real Docker engine and no real network are needed.
//
// Boundary notes:
//   - dockerode is replaced with a hand-rolled fake docker service (matches
//     pattern in registry-push.test.js).
//   - Outbound HTTP is mocked by spying on the singleton's _apiCall so we
//     can test manifest() and deleteTag() without listening on a port.
//   - DB lives in-memory (DB_PATH=':memory:') and migrations 010 + 063 run
//     automatically on getDb() — the same path production uses.

process.env.APP_SECRET = 'test-secret-key-for-jest-tests-only';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

jest.resetModules();

describe('registry service — service layer (v8.2.0 audit)', () => {
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
    db.prepare('DELETE FROM retention_policies').run();
    db.prepare('DELETE FROM registry_repos').run();
    db.prepare('DELETE FROM registries').run();
  });

  // ── helpers ──────────────────────────────────────────────────────────

  function makeRegistry(overrides = {}) {
    return registryService.create({
      name: 'reg',
      url: 'http://registry.local:5000',
      username: 'alice',
      password: 's3cret',
      createdBy: 1,
      ...overrides,
    });
  }

  function makeFakeDockerService(opts = {}) {
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

  // ── _authConfigForRegistry ───────────────────────────────────────────

  describe('_authConfigForRegistry', () => {
    it('returns dockerode-shaped authconfig with decrypted password (encrypted roundtrip)', () => {
      const id = makeRegistry({ username: 'alice', password: 's3cret' });
      const reg = registryService.get(id);
      // Sanity: password is stored encrypted in DB, not plaintext.
      expect(reg.password_encrypted).toBeTruthy();
      expect(reg.password_encrypted).not.toContain('s3cret');
      expect(reg.password_encrypted).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);

      const auth = registryService._authConfigForRegistry(reg);
      expect(auth).toEqual({
        username: 'alice',
        password: 's3cret',
        serveraddress: 'http://registry.local:5000',
      });
    });

    it('returns empty username + password when registry has no credentials', () => {
      const id = makeRegistry({ username: undefined, password: undefined });
      const reg = registryService.get(id);
      const auth = registryService._authConfigForRegistry(reg);
      expect(auth).toEqual({
        username: '',
        password: '',
        serveraddress: 'http://registry.local:5000',
      });
    });
  });

  // ── pushImage ────────────────────────────────────────────────────────

  describe('pushImage', () => {
    it('calls dockerode tag + push with correct args (mocked dockerode)', async () => {
      const fake = makeFakeDockerService();
      const id = makeRegistry({ url: 'http://registry.local:5000', username: 'u', password: 'p' });

      const result = await registryService.pushImage(
        fake, 0, id, 'myapp:latest', 'team/myapp', 'v1.2.3'
      );

      expect(result.fullImage).toBe('registry.local:5000/team/myapp:v1.2.3');
      expect(result.stream).toBe(fake._fakeStream);

      // Tag step
      expect(fake._calls.tag).toEqual([{
        name: 'myapp:latest',
        tagOpts: { repo: 'registry.local:5000/team/myapp', tag: 'v1.2.3' },
      }]);

      // Push step — uses full registry-prefixed image name + decrypted authconfig
      expect(fake._calls.push).toHaveLength(1);
      expect(fake._calls.push[0].name).toBe('registry.local:5000/team/myapp:v1.2.3');
      expect(fake._calls.push[0].pushOpts.authconfig).toEqual({
        username: 'u',
        password: 'p',
        serveraddress: 'http://registry.local:5000',
      });
    });

    it('propagates dockerode errors (tag step → wrapped error)', async () => {
      const fake = makeFakeDockerService({ tagFails: true });
      const id = makeRegistry();
      await expect(
        registryService.pushImage(fake, 0, id, 'src:latest', 'repo', 'tag')
      ).rejects.toThrow(/Tag failed: tag-broke/);
    });

    it('propagates dockerode errors (push step → wrapped error)', async () => {
      const fake = makeFakeDockerService({ pushFails: true });
      const id = makeRegistry();
      await expect(
        registryService.pushImage(fake, 0, id, 'src:latest', 'repo', 'tag')
      ).rejects.toThrow(/Push init failed: push-broke/);
    });

    it('updates last_used_at on the registry row after a successful push', async () => {
      const fake = makeFakeDockerService();
      const id = makeRegistry();
      const before = registryService.get(id);
      expect(before.last_used_at).toBeFalsy();

      await registryService.pushImage(fake, 0, id, 'src:latest', 'repo', 'tag');

      const after = registryService.get(id);
      expect(after.last_used_at).toBeTruthy();
      // Format is SQLite datetime('now') — 'YYYY-MM-DD HH:MM:SS'
      expect(after.last_used_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });
  });

  // ── manifest ─────────────────────────────────────────────────────────

  describe('manifest', () => {
    it('fetches V2 manifest with the multi-format Accept header (mock _apiCall)', async () => {
      const id = makeRegistry();
      const v2Body = {
        schemaVersion: 2,
        mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
        config: { digest: 'sha256:cfg', size: 1234 },
        layers: [{ digest: 'sha256:l1', size: 100 }],
      };
      const spy = jest.spyOn(registryService, '_apiCall').mockResolvedValue({
        status: 200,
        headers: {
          'docker-content-digest': 'sha256:abc',
          'content-type': 'application/vnd.docker.distribution.manifest.v2+json',
          'content-length': '1500',
        },
        body: v2Body,
      });

      try {
        const out = await registryService.manifest(id, 'library/nginx', 'latest');
        expect(out.manifest).toEqual(v2Body);
        expect(out.digest).toBe('sha256:abc');
        expect(out.contentType).toBe('application/vnd.docker.distribution.manifest.v2+json');
        expect(out.size).toBe(1500);

        expect(spy).toHaveBeenCalledTimes(1);
        const [regArg, pathArg, optsArg] = spy.mock.calls[0];
        expect(regArg.id).toBe(id);
        expect(pathArg).toBe('/v2/library/nginx/manifests/latest');
        // Accept header must include both Docker v2 and OCI variants for index/manifest.
        expect(optsArg.accept).toMatch(/application\/vnd\.docker\.distribution\.manifest\.v2\+json/);
        expect(optsArg.accept).toMatch(/application\/vnd\.oci\.image\.manifest\.v1\+json/);
        expect(optsArg.accept).toMatch(/application\/vnd\.docker\.distribution\.manifest\.list\.v2\+json/);
        expect(optsArg.accept).toMatch(/application\/vnd\.oci\.image\.index\.v1\+json/);
      } finally {
        spy.mockRestore();
      }
    });

    it('handles a multi-arch manifest list response (returns body untouched)', async () => {
      const id = makeRegistry();
      const indexBody = {
        schemaVersion: 2,
        mediaType: 'application/vnd.docker.distribution.manifest.list.v2+json',
        manifests: [
          { digest: 'sha256:amd', platform: { architecture: 'amd64', os: 'linux' } },
          { digest: 'sha256:arm', platform: { architecture: 'arm64', os: 'linux' } },
        ],
      };
      const spy = jest.spyOn(registryService, '_apiCall').mockResolvedValue({
        status: 200,
        headers: {
          'docker-content-digest': 'sha256:listdigest',
          'content-type': 'application/vnd.docker.distribution.manifest.list.v2+json',
          // Note: no content-length header on this response.
        },
        body: indexBody,
      });

      try {
        const out = await registryService.manifest(id, 'team/app', 'v2');
        expect(out.manifest.manifests).toHaveLength(2);
        expect(out.manifest.manifests[0].platform.architecture).toBe('amd64');
        expect(out.manifest.manifests[1].platform.architecture).toBe('arm64');
        expect(out.digest).toBe('sha256:listdigest');
        // Missing content-length → size is null (not NaN)
        expect(out.size).toBeNull();
      } finally {
        spy.mockRestore();
      }
    });
  });

  // ── deleteTag ────────────────────────────────────────────────────────

  describe('deleteTag', () => {
    it('refuses to delete a tag retargeted after a retention plan', async () => {
      const id = makeRegistry();
      const spy = jest.spyOn(registryService, '_apiCall').mockResolvedValue({
        status: 200, headers: { 'docker-content-digest': 'sha256:new' },
      });
      try {
        await expect(registryService.deleteTag(id, 'team/app', 'nightly', { expectedDigest: 'sha256:old' }))
          .rejects.toThrow(/Manifest changed/);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][2].method).toBe('HEAD');
      } finally { spy.mockRestore(); }
    });

    it('resolves tag→digest via HEAD then DELETEs by digest', async () => {
      const id = makeRegistry();
      const spy = jest.spyOn(registryService, '_apiCall').mockImplementation(async (reg, path, opts) => {
        if (opts && opts.method === 'HEAD') {
          return { status: 200, headers: { 'docker-content-digest': 'sha256:deadbeef' } };
        }
        if (opts && opts.method === 'DELETE') {
          return { status: 202, headers: {} };
        }
        throw new Error(`unexpected call: ${path} ${JSON.stringify(opts)}`);
      });

      try {
        const result = await registryService.deleteTag(id, 'team/app', 'v1.0.0');
        expect(result).toEqual({ ok: true, digest: 'sha256:deadbeef' });

        expect(spy).toHaveBeenCalledTimes(2);
        const [, headPath, headOpts] = spy.mock.calls[0];
        expect(headPath).toBe('/v2/team/app/manifests/v1.0.0');
        expect(headOpts.method).toBe('HEAD');

        const [, delPath, delOpts] = spy.mock.calls[1];
        expect(delPath).toBe('/v2/team/app/manifests/sha256:deadbeef');
        expect(delOpts.method).toBe('DELETE');
      } finally {
        spy.mockRestore();
      }
    });

    it('propagates HTTP error when the registry has deletion disabled (405)', async () => {
      const id = makeRegistry();
      const spy = jest.spyOn(registryService, '_apiCall').mockImplementation(async (reg, path, opts) => {
        if (opts && opts.method === 'HEAD') {
          return { status: 200, headers: { 'docker-content-digest': 'sha256:abc' } };
        }
        if (opts && opts.method === 'DELETE') {
          return { status: 405, headers: {} };
        }
        throw new Error('unexpected');
      });

      try {
        await expect(registryService.deleteTag(id, 'team/app', 'v1.0.0'))
          .rejects.toThrow(/deletion disabled/i);
      } finally {
        spy.mockRestore();
      }
    });

    it('throws "Tag not found" when HEAD returns 404', async () => {
      const id = makeRegistry();
      const spy = jest.spyOn(registryService, '_apiCall').mockResolvedValue({
        status: 404, headers: {},
      });
      try {
        await expect(registryService.deleteTag(id, 'team/app', 'never-existed'))
          .rejects.toThrow(/Tag not found/);
      } finally {
        spy.mockRestore();
      }
    });

    it('treats DELETE 404 as idempotent success (already gone)', async () => {
      const id = makeRegistry();
      const spy = jest.spyOn(registryService, '_apiCall').mockImplementation(async (reg, path, opts) => {
        if (opts && opts.method === 'HEAD') {
          return { status: 200, headers: { 'docker-content-digest': 'sha256:gone' } };
        }
        if (opts && opts.method === 'DELETE') {
          return { status: 404, headers: {} };
        }
        throw new Error('unexpected');
      });
      try {
        const result = await registryService.deleteTag(id, 'team/app', 'old');
        expect(result).toEqual({ ok: true, digest: 'sha256:gone' });
      } finally {
        spy.mockRestore();
      }
    });
  });

  // ── listRepos ────────────────────────────────────────────────────────

  describe('listRepos', () => {
    it('returns rows for a registry id, ordered by repo_path', () => {
      const regId = makeRegistry();
      // Insert in non-alphabetical order to confirm ORDER BY repo_path.
      registryService.upsertRepo({ registryId: regId, repoPath: 'zeta', type: 'local' }, 1);
      registryService.upsertRepo({ registryId: regId, repoPath: 'alpha', type: 'local' }, 1);
      registryService.upsertRepo({ registryId: regId, repoPath: 'mike',  type: 'local' }, 1);

      const rows = registryService.listRepos(regId);
      expect(rows.map(r => r.repoPath)).toEqual(['alpha', 'mike', 'zeta']);
    });

    it('returns [] for a registry id with no repo entries', () => {
      const regId = makeRegistry();
      expect(registryService.listRepos(regId)).toEqual([]);
    });

    it('isolates rows per registry id (does NOT leak across registries)', () => {
      const regA = makeRegistry({ name: 'a', url: 'http://a.local:5000' });
      const regB = makeRegistry({ name: 'b', url: 'http://b.local:5000' });
      registryService.upsertRepo({ registryId: regA, repoPath: 'in-a', type: 'local' }, 1);
      registryService.upsertRepo({ registryId: regB, repoPath: 'in-b', type: 'local' }, 1);

      const rowsA = registryService.listRepos(regA);
      const rowsB = registryService.listRepos(regB);
      expect(rowsA).toHaveLength(1);
      expect(rowsB).toHaveLength(1);
      expect(rowsA[0].repoPath).toBe('in-a');
      expect(rowsB[0].repoPath).toBe('in-b');
    });
  });

  // ── upsertRepo ───────────────────────────────────────────────────────

  describe('upsertRepo', () => {
    it('creates a new row when none exists (returns lastInsertRowid > 0)', () => {
      const regId = makeRegistry();
      const id = registryService.upsertRepo({
        registryId: regId, repoPath: 'team/svc', type: 'local',
      }, 1);
      expect(id).toBeGreaterThan(0);

      const rows = registryService.listRepos(regId);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(id);
      expect(rows[0].type).toBe('local');
    });

    it('updates an existing row idempotently (same id returned)', () => {
      const regId = makeRegistry();
      const id1 = registryService.upsertRepo({
        registryId: regId, repoPath: 'shared', type: 'local',
      }, 1);
      const id2 = registryService.upsertRepo({
        registryId: regId, repoPath: 'shared', type: 'remote', upstreamUrl: 'https://docker.io',
      }, 1);
      expect(id2).toBe(id1);

      const rows = registryService.listRepos(regId);
      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe('remote');
      expect(rows[0].upstreamUrl).toBe('https://docker.io');
    });

    it('with type=remote encrypts upstream_password (AES-GCM iv:tag:data, never plaintext)', () => {
      const regId = makeRegistry();
      const id = registryService.upsertRepo({
        registryId: regId,
        repoPath: 'remote-mirror',
        type: 'remote',
        upstreamUrl: 'https://docker.io',
        upstreamUsername: 'mirror',
        upstreamPassword: 'super-secret-pw',
      }, 1);

      const raw = db.prepare(
        'SELECT upstream_password_encrypted FROM registry_repos WHERE id = ?'
      ).get(id);
      expect(raw.upstream_password_encrypted).toBeTruthy();
      expect(raw.upstream_password_encrypted).not.toContain('super-secret-pw');
      expect(raw.upstream_password_encrypted).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);

      // The list shape must NOT expose any encrypted/password keys.
      const rows = registryService.listRepos(regId);
      expect(rows).toHaveLength(1);
      const keys = Object.keys(rows[0]);
      for (const k of keys) {
        expect(k.toLowerCase()).not.toContain('password');
        expect(k.toLowerCase()).not.toContain('encrypted');
      }
    });
  });

  // ── deleteRepo ───────────────────────────────────────────────────────

  describe('deleteRepo', () => {
    it('cascades to retention_policies (FK ON DELETE CASCADE)', () => {
      const regId = makeRegistry();
      const repoId = registryService.upsertRepo({
        registryId: regId, repoPath: 'cascade-target', type: 'local',
      }, 1);
      registryService.upsertRetentionPolicy({
        registryRepoId: repoId,
        rule: { keepLastN: 5, minTagsToKeep: 1 },
        enabled: true,
        scheduleCron: '0 3 * * *',
      }, 1);
      expect(registryService.getRetentionPolicy(repoId)).not.toBeNull();

      registryService.deleteRepo(repoId);

      const orphan = db.prepare(
        'SELECT COUNT(*) AS c FROM retention_policies WHERE registry_repo_id = ?'
      ).get(repoId);
      expect(orphan.c).toBe(0);
      expect(registryService.listRepos(regId)).toHaveLength(0);
    });
  });

  // ── resolveVirtual ───────────────────────────────────────────────────

  describe('resolveVirtual', () => {
    it('returns the member rows for a virtual repo (covers ordered/full set)', () => {
      const regId = makeRegistry();
      const m1 = registryService.upsertRepo({ registryId: regId, repoPath: 'team-a/*', type: 'local' }, 1);
      const m2 = registryService.upsertRepo({ registryId: regId, repoPath: 'team-b/*', type: 'local' }, 1);
      const m3 = registryService.upsertRepo({ registryId: regId, repoPath: 'team-c/*', type: 'local' }, 1);

      const vId = registryService.upsertRepo({
        registryId: regId,
        repoPath: 'all-teams',
        type: 'virtual',
        virtualMemberIds: [m1, m2, m3],
      }, 1);

      const members = registryService.resolveVirtual(vId);
      expect(Array.isArray(members)).toBe(true);
      expect(members).toHaveLength(3);
      const ids = members.map(m => m.id).sort((a, b) => a - b);
      expect(ids).toEqual([m1, m2, m3].sort((a, b) => a - b));
      expect(members.every(m => typeof m.repo_path === 'string' && m.repo_path.length > 0)).toBe(true);
    });
  });

  // ── retention CRUD round-trip ────────────────────────────────────────

  describe('retention policies CRUD round-trip', () => {
    it('getRetentionPolicy / upsertRetentionPolicy / deleteRetentionPolicy full round-trip', () => {
      const regId = makeRegistry();
      const repoId = registryService.upsertRepo({
        registryId: regId, repoPath: 'crud-roundtrip', type: 'local',
      }, 1);

      // 1) initial GET → null
      expect(registryService.getRetentionPolicy(repoId)).toBeNull();

      // 2) upsert (insert path)
      const rule1 = { keepLastN: 10, minTagsToKeep: 2, deleteTagPatterns: ['nightly-*'] };
      registryService.upsertRetentionPolicy({
        registryRepoId: repoId,
        rule: rule1,
        enabled: true,
        scheduleCron: '17 3 * * *',
      }, 1);

      let p = registryService.getRetentionPolicy(repoId);
      expect(p).not.toBeNull();
      expect(p.registryRepoId).toBe(repoId);
      expect(p.rule).toEqual(rule1);
      expect(typeof p.enabled).toBe('boolean');
      expect(p.enabled).toBe(true);
      expect(p.scheduleCron).toBe('17 3 * * *');

      // 3) upsert (update / ON CONFLICT path) — only one row should exist
      const rule2 = { keepLastN: 25, minTagsToKeep: 3, protectTagPatterns: ['prod-*'] };
      registryService.upsertRetentionPolicy({
        registryRepoId: repoId,
        rule: rule2,
        enabled: false,
        scheduleCron: '0 4 * * *',
      }, 1);

      const count = db.prepare(
        'SELECT COUNT(*) AS c FROM retention_policies WHERE registry_repo_id = ?'
      ).get(repoId);
      expect(count.c).toBe(1);

      p = registryService.getRetentionPolicy(repoId);
      expect(p.rule).toEqual(rule2);
      expect(p.enabled).toBe(false);
      expect(p.scheduleCron).toBe('0 4 * * *');

      // 4) delete
      registryService.deleteRetentionPolicy(repoId);
      expect(registryService.getRetentionPolicy(repoId)).toBeNull();
    });
  });
});
