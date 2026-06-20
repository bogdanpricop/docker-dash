'use strict';

const { getDb } = require('../db');
const https = require('https');
const http = require('http');
const config = require('../config');
const log = require('../utils/logger')('registry');
const { encrypt, decrypt } = require('../utils/crypto');

class RegistryService {
  constructor() {
    // v8.7.22 — was: setImmediate(() => this._rewrapLegacy()).
    // The fire-and-forget setImmediate had two problems:
    //   1. In Jest, the immediate fires AFTER test teardown, hitting a
    //      closed DB and producing a "Cannot log after tests are done"
    //      warning that confused every test report.
    //   2. In production, if the process received SIGTERM right after
    //      construction, the immediate would fire during shutdown,
    //      reopen the DB connection (via getDb singleton re-init), and
    //      run the migration runner during shutdown — leaking a
    //      connection and writing through a half-torn-down system.
    // Lazy-on-first-use via the `_rewrapped` flag eliminates both. The
    // rewrap fires on the first call to _decryptLegacyOrNew, which is
    // the only path that actually consumes an encrypted password
    // (_apiCall does Basic auth against a private registry).
    this._rewrapped = false;
  }

  _ensureRewrapped() {
    if (this._rewrapped) return;
    this._rewrapped = true;  // set BEFORE the call so failures don't loop
    try {
      this._rewrapLegacy();
    } catch { /* already swallowed inside _rewrapLegacy; double-safety */ }
  }

  list() {
    return getDb().prepare('SELECT id, name, url, username, is_default, created_at, last_used_at FROM registries ORDER BY name').all();
  }

  get(id) {
    return getDb().prepare('SELECT * FROM registries WHERE id = ?').get(id);
  }

  create({ name, url, username, password, createdBy }) {
    const encrypted = password ? encrypt(password) : null;
    const result = getDb().prepare(
      'INSERT INTO registries (name, url, username, password_encrypted, created_by) VALUES (?, ?, ?, ?, ?)'
    ).run(name, url.replace(/\/+$/, ''), username || null, encrypted, createdBy);
    return result.lastInsertRowid;
  }

  update(id, { name, url, username, password }) {
    const db = getDb();
    if (password) {
      db.prepare('UPDATE registries SET name=?, url=?, username=?, password_encrypted=?, last_used_at=NULL WHERE id=?')
        .run(name, url.replace(/\/+$/, ''), username || null, encrypt(password), id);
    } else {
      db.prepare('UPDATE registries SET name=?, url=?, username=? WHERE id=?')
        .run(name, url.replace(/\/+$/, ''), username || null, id);
    }
  }

  remove(id) {
    getDb().prepare('DELETE FROM registries WHERE id = ?').run(id);
  }

  async testConnection(id) {
    const reg = this.get(id);
    if (!reg) throw new Error('Registry not found');
    try {
      const result = await this._apiCall(reg, '/v2/');
      return { ok: true, status: result.status };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async catalog(id, limit = 100) {
    const reg = this.get(id);
    if (!reg) throw new Error('Registry not found');
    const data = await this._apiCall(reg, `/v2/_catalog?n=${limit}`);
    getDb().prepare("UPDATE registries SET last_used_at = datetime('now') WHERE id = ?").run(id);
    return data.body?.repositories || [];
  }

  async tags(id, repo) {
    const reg = this.get(id);
    if (!reg) throw new Error('Registry not found');
    const data = await this._apiCall(reg, `/v2/${repo}/tags/list`);
    return data.body?.tags || [];
  }

  /**
   * Inspect a manifest. Returns the raw manifest object + size + digest from headers.
   * Uses the V2 manifest accept header to handle both v1, v2, and OCI manifests
   * (registries return whichever format the manifest was pushed as).
   *
   * @param {number} id  registry id
   * @param {string} repo  e.g. "library/nginx"
   * @param {string} ref  tag (e.g. "latest") or digest (e.g. "sha256:...")
   */
  async manifest(id, repo, ref) {
    const reg = this.get(id);
    if (!reg) throw new Error('Registry not found');
    const data = await this._apiCall(reg, `/v2/${repo}/manifests/${ref}`, {
      accept: 'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.index.v1+json',
    });
    return {
      manifest: data.body,
      digest: data.headers?.['docker-content-digest'] || null,
      contentType: data.headers?.['content-type'] || null,
      size: data.headers?.['content-length'] ? parseInt(data.headers['content-length'], 10) : null,
    };
  }

  /**
   * Delete a tag from a remote registry.
   *
   * Distribution's V2 API only supports DELETE by digest, not by tag — so we
   * first HEAD the manifest to resolve the tag → digest, then DELETE the
   * digest. The registry must have `REGISTRY_STORAGE_DELETE_ENABLED=true`
   * (our shipped template sets this); otherwise the DELETE returns 405.
   *
   * Note that this only deletes the manifest. The blobs (layers) are not
   * reclaimed until the operator runs `registry garbage-collect`. We don't
   * trigger GC automatically — it requires the registry to be read-only or
   * risks data loss. Operators run it manually on a schedule.
   *
   * @param {number} id  registry id
   * @param {string} repo  e.g. "team/myapp"
   * @param {string} tag  e.g. "v1.2.3"
   * @returns {Promise<{ok: true, digest: string}>}
   */
  async deleteTag(id, repo, tag) {
    const reg = this.get(id);
    if (!reg) throw new Error('Registry not found');
    if (!repo) throw new Error('repo required');
    if (!tag) throw new Error('tag required');

    // Step 1: HEAD the manifest to resolve the digest. We use HEAD (not GET)
    // because we don't need the body and HEAD is cheap; the registry returns
    // the same Docker-Content-Digest header either way.
    const head = await this._apiCall(reg, `/v2/${repo}/manifests/${tag}`, {
      method: 'HEAD',
      accept: 'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.index.v1+json',
    });
    if (head.status === 404) throw new Error(`Tag not found: ${repo}:${tag}`);
    if (head.status >= 400) throw new Error(`Manifest lookup failed (HTTP ${head.status})`);
    const digest = head.headers?.['docker-content-digest'];
    if (!digest) throw new Error('Registry did not return a digest — refusing to guess');

    // Step 2: DELETE by digest.
    const del = await this._apiCall(reg, `/v2/${repo}/manifests/${digest}`, { method: 'DELETE' });
    if (del.status === 405 || del.status === 501) {
      throw new Error('Registry has deletion disabled. Set REGISTRY_STORAGE_DELETE_ENABLED=true and restart it.');
    }
    if (del.status === 404) {
      // Already gone — treat as success (idempotent delete)
    } else if (del.status >= 400) {
      throw new Error(`Delete failed (HTTP ${del.status})`);
    }
    return { ok: true, digest };
  }

  /**
   * Build the X-Registry-Auth header value for dockerode.push().
   * Returns the dockerode `authconfig` object (NOT the encoded header).
   * Dockerode handles the base64-of-JSON encoding internally.
   */
  _authConfigForRegistry(reg) {
    return {
      username: reg.username || '',
      password: reg.password_encrypted ? this._decryptLegacyOrNew(reg.password_encrypted) : '',
      serveraddress: reg.url,
    };
  }

  /**
   * Push a local image to a configured registry. Tags `sourceImage` (e.g.
   * "myapp:latest") under the registry's host as `<host>/<repo>:<tag>` and
   * pushes it. Returns the dockerode push stream so the caller can pipe
   * progress events to SSE/WS.
   *
   * Multi-arch manifest lists are NOT supported — dockerode pushes whatever
   * the local engine has tagged (typically single-arch). Documented limitation.
   *
   * @param {object} dockerService  the docker service singleton
   * @param {number} hostId         multi-host context (0 = local)
   * @param {number} registryId
   * @param {string} sourceImage    e.g. "myapp:1.2.3" or full ID
   * @param {string} targetRepo     e.g. "team/myapp"
   * @param {string} targetTag      e.g. "1.2.3"
   * @returns {Promise<{stream: NodeJS.ReadableStream, fullImage: string, registry: string}>}
   */
  async pushImage(dockerService, hostId, registryId, sourceImage, targetRepo, targetTag) {
    const reg = this.get(registryId);
    if (!reg) throw new Error('Registry not found');
    if (!sourceImage) throw new Error('sourceImage required');
    if (!targetRepo) throw new Error('targetRepo required');
    if (!targetTag) throw new Error('targetTag required');

    const docker = dockerService.getDocker(hostId);
    const registryHost = new URL(reg.url).host;
    const fullImage = `${registryHost}/${targetRepo}:${targetTag}`;

    // 1. Tag the source under the registry host (idempotent — Docker engine
    //    is fine with re-tagging the same source repeatedly).
    const sourceImg = docker.getImage(sourceImage);
    await new Promise((resolve, reject) => {
      sourceImg.tag({ repo: `${registryHost}/${targetRepo}`, tag: targetTag }, (err) => {
        if (err) return reject(new Error(`Tag failed: ${err.message}`));
        resolve();
      });
    });

    // 2. Push the newly-tagged image. The stream emits NDJSON events that
    //    the caller forwards to SSE.
    const targetImg = docker.getImage(fullImage);
    const authconfig = this._authConfigForRegistry(reg);
    const stream = await new Promise((resolve, reject) => {
      targetImg.push({ authconfig }, (err, s) => {
        if (err) return reject(new Error(`Push init failed: ${err.message}`));
        resolve(s);
      });
    });

    // Update last_used_at so operators see this registry was hit recently.
    getDb().prepare("UPDATE registries SET last_used_at = datetime('now') WHERE id = ?").run(registryId);

    return { stream, fullImage, registry: reg.name };
  }

  getAuthForImage(imageName) {
    const db = getDb();
    // Match registry URL from image name
    const registries = db.prepare('SELECT * FROM registries').all();
    for (const reg of registries) {
      const host = new URL(reg.url).hostname;
      if (imageName.startsWith(host + '/') || imageName.startsWith(host + ':')) {
        return {
          username: reg.username,
          password: reg.password_encrypted ? this._decryptLegacyOrNew(reg.password_encrypted) : '',
          serveraddress: reg.url,
        };
      }
    }
    return null;
  }

  /**
   * Decrypt a stored password — handles both new AES-GCM format and legacy XOR/base64 format.
   * Legacy format: starts with 'x:' (XOR encrypted) or is plain base64 (no key was set).
   */
  _decryptLegacyOrNew(stored) {
    // v8.7.22 — opportunistic rewrap trigger. Runs once per process the
    // first time any registry password is decrypted, replacing the
    // constructor's setImmediate side-effect. Safe to call from inside
    // the decrypt path because _rewrapLegacy itself uses prepared
    // statements + try/catch and is idempotent (already-AES-GCM rows
    // are detected and skipped).
    if (!this._rewrapped) this._ensureRewrapped();
    if (!stored) return '';
    // Try new AES-GCM first (format: iv:tag:data — three hex segments separated by colons)
    // AES-GCM ciphertext has exactly 3 colon-delimited hex parts
    const parts = stored.split(':');
    if (parts.length === 3 && /^[0-9a-f]+$/i.test(parts[0])) {
      try {
        return decrypt(stored);
      } catch {
        // Fall through to legacy handling
      }
    }
    // Legacy XOR format: 'x:<base64>'
    if (stored.startsWith('x:')) {
      const key = config.security.encryptionKey;
      if (!key) return '';
      const encBuf = Buffer.from(stored.slice(2), 'base64');
      const keyBuf = Buffer.from(key, 'utf8');
      const decrypted = Buffer.alloc(encBuf.length);
      for (let i = 0; i < encBuf.length; i++) {
        decrypted[i] = encBuf[i] ^ keyBuf[i % keyBuf.length];
      }
      return decrypted.toString('utf8');
    }
    // Legacy plain base64 (no key was configured at save time)
    try {
      return Buffer.from(stored, 'base64').toString('utf8');
    } catch {
      return '';
    }
  }

  // ─── v8.1.0 — Registry repos (typing) + retention policies ──────────

  /**
   * List all registry_repos rows for a given registry credential, ordered
   * by repo_path. Excludes encrypted upstream password.
   */
  listRepos(registryId) {
    const rows = getDb().prepare(`
      SELECT id, registry_id AS registryId, repo_path AS repoPath, type,
             upstream_url AS upstreamUrl, upstream_username AS upstreamUsername,
             virtual_member_ids AS virtualMemberIdsJson,
             created_at, updated_at
        FROM registry_repos
       WHERE registry_id = ?
       ORDER BY repo_path
    `).all(registryId);
    return rows.map(r => ({
      ...r,
      virtualMemberIds: r.virtualMemberIdsJson ? JSON.parse(r.virtualMemberIdsJson) : null,
      virtualMemberIdsJson: undefined,
    }));
  }

  /**
   * Insert or update a registry_repos row by (registryId, repoPath).
   * Encrypts upstreamPassword if provided.
   * Returns the row's id.
   */
  upsertRepo({ registryId, repoPath, type, upstreamUrl, upstreamUsername, upstreamPassword, virtualMemberIds }, userId) {
    const enc = upstreamPassword ? encrypt(upstreamPassword) : null;
    const memberJson = Array.isArray(virtualMemberIds) ? JSON.stringify(virtualMemberIds) : null;
    const db = getDb();
    const result = db.prepare(`
      INSERT INTO registry_repos
        (registry_id, repo_path, type, upstream_url, upstream_username,
         upstream_password_encrypted, virtual_member_ids, created_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(registry_id, repo_path) DO UPDATE SET
        type = excluded.type,
        upstream_url = excluded.upstream_url,
        upstream_username = excluded.upstream_username,
        upstream_password_encrypted = COALESCE(excluded.upstream_password_encrypted, registry_repos.upstream_password_encrypted),
        virtual_member_ids = excluded.virtual_member_ids,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      registryId, repoPath, type,
      upstreamUrl || null, upstreamUsername || null,
      enc, memberJson, userId,
    );
    if (result.lastInsertRowid > 0) return result.lastInsertRowid;
    // ON CONFLICT path — fetch the existing id
    const row = db.prepare('SELECT id FROM registry_repos WHERE registry_id = ? AND repo_path = ?').get(registryId, repoPath);
    return row.id;
  }

  deleteRepo(repoId) {
    getDb().prepare('DELETE FROM registry_repos WHERE id = ?').run(repoId);
  }

  /**
   * Resolve a virtual repo to its underlying member registry_repos rows.
   */
  resolveVirtual(repoId) {
    const db = getDb();
    const repo = db.prepare('SELECT * FROM registry_repos WHERE id = ?').get(repoId);
    if (!repo || repo.type !== 'virtual') return null;
    const memberIds = JSON.parse(repo.virtual_member_ids || '[]');
    if (memberIds.length === 0) return [];
    const placeholders = memberIds.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM registry_repos WHERE id IN (${placeholders})`).all(...memberIds);
  }

  // Retention policies

  getRetentionPolicy(registryRepoId) {
    const row = getDb().prepare(`
      SELECT id, registry_repo_id AS registryRepoId, rule_json AS ruleJson,
             enabled, schedule_cron AS scheduleCron,
             last_run_at AS lastRunAt, last_run_summary AS lastRunSummaryJson,
             created_at, updated_at
        FROM retention_policies WHERE registry_repo_id = ?
    `).get(registryRepoId);
    if (!row) return null;
    return {
      ...row,
      rule: JSON.parse(row.ruleJson),
      enabled: row.enabled === 1,
      lastRunSummary: row.lastRunSummaryJson ? JSON.parse(row.lastRunSummaryJson) : null,
      ruleJson: undefined,
      lastRunSummaryJson: undefined,
    };
  }

  upsertRetentionPolicy({ registryRepoId, rule, enabled, scheduleCron }, userId) {
    getDb().prepare(`
      INSERT INTO retention_policies
        (registry_repo_id, rule_json, enabled, schedule_cron, created_by, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(registry_repo_id) DO UPDATE SET
        rule_json = excluded.rule_json,
        enabled = excluded.enabled,
        schedule_cron = COALESCE(excluded.schedule_cron, retention_policies.schedule_cron),
        updated_at = CURRENT_TIMESTAMP
    `).run(
      registryRepoId, JSON.stringify(rule),
      enabled ? 1 : 0, scheduleCron || '17 3 * * *', userId,
    );
  }

  deleteRetentionPolicy(registryRepoId) {
    getDb().prepare('DELETE FROM retention_policies WHERE registry_repo_id = ?').run(registryRepoId);
  }

  /**
   * One-time migration: re-encrypt any legacy XOR/base64 passwords with AES-GCM.
   * Safe to call on startup — skips rows already in AES-GCM format.
   */
  _rewrapLegacy() {
    try {
      const db = getDb();
      const rows = db.prepare('SELECT id, password_encrypted FROM registries WHERE password_encrypted IS NOT NULL').all();
      let rewrapped = 0;
      for (const row of rows) {
        const stored = row.password_encrypted;
        if (!stored) continue;
        // Check if already AES-GCM format (3 hex parts separated by colons)
        const parts = stored.split(':');
        if (parts.length === 3 && /^[0-9a-f]+$/i.test(parts[0])) {
          // Already new format — try decrypting to confirm
          try { decrypt(stored); continue; } catch { /* corrupted, try rewrap */ }
        }
        // Legacy format — decode and re-encrypt
        try {
          const plaintext = this._decryptLegacyOrNew(stored);
          if (plaintext) {
            const newEncrypted = encrypt(plaintext);
            db.prepare('UPDATE registries SET password_encrypted = ? WHERE id = ?').run(newEncrypted, row.id);
            rewrapped++;
          }
        } catch (err) {
          log.warn(`Failed to rewrap registry password for id=${row.id}: ${err.message}`);
        }
      }
      if (rewrapped > 0) {
        log.info(`Registry legacy password migration: rewrapped ${rewrapped} row(s) to AES-GCM`);
      }
    } catch (err) {
      log.warn(`Registry legacy rewrap skipped: ${err.message}`);
    }
  }

  _apiCall(reg, path, opts = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, reg.url);
      const mod = url.protocol === 'https:' ? https : http;
      const method = opts.method || 'GET';
      const headers = { 'Accept': opts.accept || 'application/json' };

      if (reg.username && reg.password_encrypted) {
        const pass = this._decryptLegacyOrNew(reg.password_encrypted);
        headers['Authorization'] = 'Basic ' + Buffer.from(`${reg.username}:${pass}`).toString('base64');
      }

      const req = mod.request(url, {
        method,
        headers,
        timeout: 10000,
        rejectUnauthorized: false,
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          const result = { status: res.statusCode, headers: res.headers };
          try {
            result.body = data ? JSON.parse(data) : null;
          } catch {
            result.body = data;
          }
          resolve(result);
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.end();
    });
  }
}

module.exports = new RegistryService();
