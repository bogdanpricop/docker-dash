'use strict';

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const simpleGit = require('simple-git');
const { getDb } = require('../db');
const { encrypt, decrypt, generateToken, hmacSign } = require('../utils/crypto');
const { now } = require('../utils/helpers');
const log = require('../utils/logger')('git');

const REPOS_BASE = path.join(process.env.DATA_DIR || '/data', 'repos');

class GitService {
  constructor() {
    fs.mkdirSync(REPOS_BASE, { recursive: true });
  }

  // ─── Credential Operations ──────────────────────────────

  listCredentials() {
    const db = getDb();
    const rows = db.prepare(`
      SELECT gc.*,
        (SELECT COUNT(*) FROM git_stacks gs WHERE gs.credential_id = gc.id) AS usage_count
      FROM git_credentials gc
      ORDER BY gc.name
    `).all();

    return rows.map(r => ({
      id: r.id,
      name: r.name,
      auth_type: r.auth_type,
      username: r.username,
      has_password: !!r.password_encrypted,
      has_ssh_key: !!r.ssh_private_key_encrypted,
      ssh_public_key: r.ssh_public_key,
      usage_count: r.usage_count,
      created_by: r.created_by,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
  }

  getCredential(id) {
    return getDb().prepare('SELECT * FROM git_credentials WHERE id = ?').get(id);
  }

  createCredential({ name, auth_type, username, password, ssh_private_key, created_by }) {
    const db = getDb();
    const encrypted_password = password ? encrypt(password) : null;
    let encrypted_ssh_key = null;
    let ssh_public_key = null;

    if (auth_type === 'ssh_key' && ssh_private_key) {
      encrypted_ssh_key = encrypt(ssh_private_key);
      ssh_public_key = this._extractPublicKey(ssh_private_key);
    }

    const r = db.prepare(`
      INSERT INTO git_credentials (name, auth_type, username, password_encrypted,
        ssh_private_key_encrypted, ssh_public_key, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(name, auth_type, username || null, encrypted_password,
      encrypted_ssh_key, ssh_public_key, created_by);

    log.info('Credential created', { id: Number(r.lastInsertRowid), name, auth_type });
    return { id: Number(r.lastInsertRowid), name, auth_type };
  }

  updateCredential(id, data) {
    const db = getDb();
    const existing = this.getCredential(id);
    if (!existing) throw Object.assign(new Error('Credential not found'), { status: 404 });

    const sets = [];
    const params = [];

    if (data.name !== undefined) { sets.push('name = ?'); params.push(data.name); }
    if (data.username !== undefined) { sets.push('username = ?'); params.push(data.username); }
    if (data.password !== undefined) {
      sets.push('password_encrypted = ?');
      params.push(encrypt(data.password));
    }
    if (data.ssh_private_key !== undefined) {
      sets.push('ssh_private_key_encrypted = ?');
      params.push(encrypt(data.ssh_private_key));
      sets.push('ssh_public_key = ?');
      params.push(this._extractPublicKey(data.ssh_private_key));
    }

    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    params.push(now());
    params.push(id);

    db.prepare(`UPDATE git_credentials SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    log.info('Credential updated', { id });
  }

  deleteCredential(id) {
    const db = getDb();
    const usage = db.prepare(
      'SELECT COUNT(*) AS cnt FROM git_stacks WHERE credential_id = ?'
    ).get(id);
    if (usage.cnt > 0) {
      throw Object.assign(
        new Error(`Credential is in use by ${usage.cnt} stack(s). Remove or reassign them first.`),
        { status: 409 }
      );
    }
    db.prepare('DELETE FROM git_credentials WHERE id = ?').run(id);
    log.info('Credential deleted', { id });
  }

  // ─── Stack Operations ──────────────────────────────────

  listStacks(hostId) {
    const db = getDb();
    let sql = `
      SELECT gs.*, gc.name AS credential_name
      FROM git_stacks gs
      LEFT JOIN git_credentials gc ON gs.credential_id = gc.id
    `;
    const params = [];
    if (hostId !== undefined && hostId !== null) {
      sql += ' WHERE gs.host_id = ?';
      params.push(hostId);
    }
    sql += ' ORDER BY gs.stack_name';

    return db.prepare(sql).all(...params).map(r => ({
      ...r,
      env_overrides: r.env_overrides ? JSON.parse(r.env_overrides) : null,
      force_redeploy: !!r.force_redeploy,
      re_pull_images: !!r.re_pull_images,
      tls_skip_verify: !!r.tls_skip_verify,
    }));
  }

  getStack(id) {
    const db = getDb();
    const r = db.prepare(`
      SELECT gs.*, gc.name AS credential_name
      FROM git_stacks gs
      LEFT JOIN git_credentials gc ON gs.credential_id = gc.id
      WHERE gs.id = ?
    `).get(id);
    if (!r) return null;
    return {
      ...r,
      env_overrides: r.env_overrides ? JSON.parse(r.env_overrides) : null,
      force_redeploy: !!r.force_redeploy,
      re_pull_images: !!r.re_pull_images,
      tls_skip_verify: !!r.tls_skip_verify,
    };
  }

  createStack(data) {
    const db = getDb();
    this._validateStackName(data.stack_name);
    this._validateRepoUrl(data.repo_url);
    if (data.compose_path) this._validateComposePath(data.compose_path);

    const existing = db.prepare('SELECT id FROM git_stacks WHERE stack_name = ?').get(data.stack_name);
    if (existing) {
      throw Object.assign(
        new Error(`Stack name '${data.stack_name}' is already in use`),
        { status: 409 }
      );
    }

    if (data.credential_id) {
      const cred = this.getCredential(data.credential_id);
      if (!cred) throw Object.assign(new Error('Credential not found'), { status: 400 });
    }

    const r = db.prepare(`
      INSERT INTO git_stacks (stack_name, host_id, repo_url, branch, compose_path,
        credential_id, env_overrides, force_redeploy, re_pull_images, tls_skip_verify,
        status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cloning', ?)
    `).run(
      data.stack_name,
      data.host_id || 0,
      data.repo_url,
      data.branch || 'main',
      data.compose_path || 'docker-compose.yml',
      data.credential_id || null,
      data.env_overrides ? JSON.stringify(data.env_overrides) : null,
      data.force_redeploy !== false ? 1 : 0,
      data.re_pull_images ? 1 : 0,
      data.tls_skip_verify ? 1 : 0,
      data.created_by,
    );

    const id = Number(r.lastInsertRowid);
    log.info('Git stack created', { id, stack_name: data.stack_name, repo_url: data.repo_url });

    // Trigger clone + deploy in background
    this._cloneAndDeploy(id).catch(err => {
      log.error('Initial clone+deploy failed', { stackId: id, error: err.message });
    });

    return { id, stack_name: data.stack_name, status: 'cloning' };
  }

  updateStack(id, data) {
    const db = getDb();
    const existing = this.getStack(id);
    if (!existing) throw Object.assign(new Error('Git stack not found'), { status: 404 });

    if (data.compose_path) this._validateComposePath(data.compose_path);

    const sets = [];
    const params = [];
    const allowed = ['branch', 'compose_path', 'credential_id', 'env_overrides',
      'force_redeploy', 're_pull_images', 'tls_skip_verify', 'additional_files'];

    for (const key of allowed) {
      if (data[key] !== undefined) {
        sets.push(`${key} = ?`);
        if (key === 'env_overrides' || key === 'additional_files')
          params.push(typeof data[key] === 'string' ? data[key] : JSON.stringify(data[key]));
        else if (['force_redeploy', 're_pull_images', 'tls_skip_verify'].includes(key))
          params.push(data[key] ? 1 : 0);
        else params.push(data[key]);
      }
    }

    // Validate additional_files paths
    if (data.additional_files) {
      const files = Array.isArray(data.additional_files) ? data.additional_files : JSON.parse(data.additional_files);
      for (const f of files) this._validateComposePath(f);
      if (files.length > 10) throw new Error('Maximum 10 compose files allowed');
    }

    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    params.push(now());
    params.push(id);
    db.prepare(`UPDATE git_stacks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    log.info('Git stack updated', { id });
  }

  async deleteStack(id, { removeContainers = false, removeVolumes = false } = {}) {
    const stack = this.getStack(id);
    if (!stack) throw Object.assign(new Error('Git stack not found'), { status: 404 });

    const repoDir = path.join(REPOS_BASE, String(id));

    if (removeContainers && fs.existsSync(repoDir)) {
      try {
        const composePath = path.join(repoDir, stack.compose_path);
        const flags = removeVolumes ? '--volumes' : '';
        this._exec(`docker compose -f "${composePath}" -p "${stack.stack_name}" down ${flags}`);
      } catch (err) {
        log.warn('compose down failed during delete', { stackId: id, error: err.message });
      }
    }

    if (fs.existsSync(repoDir)) {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }

    // Clean up SSH key
    const keyPath = path.join(REPOS_BASE, '.ssh-keys', `key-${id}`);
    if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);

    getDb().prepare('DELETE FROM git_stacks WHERE id = ?').run(id);
    log.info('Git stack deleted', { id, stack_name: stack.stack_name });
  }

  // ─── Deploy & Check ──────────────────────────────────

  async deployStack(id, { force = false } = {}) {
    const db = getDb();
    const stack = this.getStack(id);
    if (!stack) throw Object.assign(new Error('Git stack not found'), { status: 404 });
    if (stack.status === 'deploying' || stack.status === 'cloning') {
      throw Object.assign(new Error('Stack is already deploying'), { status: 409 });
    }

    db.prepare('UPDATE git_stacks SET status = ?, error_message = NULL, updated_at = ? WHERE id = ?')
      .run('deploying', now(), id);

    this._pullAndDeploy(id, { force }).catch(err => {
      log.error('Deploy failed', { stackId: id, error: err.message });
    });
  }

  async checkForUpdates(id) {
    const stack = this.getStack(id);
    if (!stack) throw Object.assign(new Error('Git stack not found'), { status: 404 });

    const repoDir = path.join(REPOS_BASE, String(id));
    if (!fs.existsSync(repoDir)) {
      throw new Error('Repository not cloned yet. Deploy first.');
    }

    const git = this._getGit(repoDir, stack);
    await git.fetch('origin', stack.branch);

    const localHash = (await git.revparse(['HEAD'])).trim().substring(0, 7);
    const remoteHash = (await git.revparse([`origin/${stack.branch}`])).trim().substring(0, 7);

    let newCommits = [];
    if (localHash !== remoteHash) {
      const logResult = await git.log({ from: 'HEAD', to: `origin/${stack.branch}` });
      newCommits = logResult.all.map(c => ({
        hash: c.hash.substring(0, 7),
        message: c.message,
        author: c.author_name,
        date: c.date,
      }));
    }

    getDb().prepare('UPDATE git_stacks SET last_check_at = ? WHERE id = ?').run(now(), id);

    return {
      has_updates: localHash !== remoteHash,
      local_commit: localHash,
      remote_commit: remoteHash,
      commits_behind: newCommits.length,
      new_commits: newCommits,
    };
  }

  async testConnection({ repo_url, credential_id, auth_type, username, password }) {
    try {
      this._validateRepoUrl(repo_url);
      const env = {};
      let url = repo_url;

      if (repo_url.startsWith('git@') || repo_url.startsWith('ssh://')) {
        // SSH — need key from credential
        if (credential_id) {
          const cred = this.getCredential(credential_id);
          if (cred?.auth_type === 'ssh_key' && cred.ssh_private_key_encrypted) {
            const keyPath = this._writeTempKey('test', cred);
            env.GIT_SSH_COMMAND = `ssh -i "${keyPath}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;
          }
        }
      } else {
        // HTTPS
        url = this._buildAuthUrl(repo_url, { credential_id, auth_type, username, password });
      }

      const result = await simpleGit().env(env).listRemote(['--heads', url]);
      const branches = result.split('\n')
        .filter(line => line.trim())
        .map(line => {
          const ref = line.split('\t')[1] || '';
          return ref.replace('refs/heads/', '');
        })
        .filter(Boolean);

      return { ok: true, branches };
    } catch (err) {
      return { ok: false, error: this._sanitizeGitError(err.message) };
    }
  }

  // ─── Deployment History ──────────────────────────────

  listDeployments(stackId, { page = 1, limit = 20, status, trigger_type } = {}) {
    const db = getDb();
    let sql = 'SELECT * FROM git_deployments WHERE git_stack_id = ?';
    const params = [stackId];
    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (trigger_type) { sql += ' AND trigger_type = ?'; params.push(trigger_type); }

    const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) AS cnt');
    const total = db.prepare(countSql).get(...params)?.cnt || 0;

    sql += ' ORDER BY started_at DESC LIMIT ? OFFSET ?';
    params.push(Math.min(limit, 100), (page - 1) * limit);
    const rows = db.prepare(sql).all(...params);
    return { rows, total, page, limit };
  }

  _recordDeployment(stackId, commitInfo, triggerType, userId = null) {
    const db = getDb();
    const r = db.prepare(`
      INSERT INTO git_deployments (git_stack_id, commit_hash, commit_message, commit_author, trigger_type, status, deployed_by)
      VALUES (?, ?, ?, ?, ?, 'deploying', ?)
    `).run(stackId, commitInfo.hash || '', commitInfo.message || '', commitInfo.author || '', triggerType, userId);
    return Number(r.lastInsertRowid);
  }

  _completeDeployment(deploymentId, status, errorMessage = null) {
    const db = getDb();
    const deployment = db.prepare('SELECT started_at FROM git_deployments WHERE id = ?').get(deploymentId);
    const durationMs = deployment ? Date.now() - new Date(deployment.started_at + 'Z').getTime() : null;
    db.prepare(`
      UPDATE git_deployments SET status = ?, error_message = ?, finished_at = datetime('now'), duration_ms = ?
      WHERE id = ?
    `).run(status, errorMessage, durationMs, deploymentId);
  }

  // ─── Webhook / Auto-Deploy ────────────────────────────

  generateWebhookConfig(stackId) {
    const db = getDb();
    const token = generateToken(24);
    const secret = generateToken(16);
    db.prepare('UPDATE git_stacks SET webhook_token = ?, webhook_secret = ?, updated_at = ? WHERE id = ?')
      .run(token, secret, now(), stackId);
    return { token, secret };
  }

  getStackByWebhookToken(token) {
    if (!token) return null;
    const db = getDb();
    return db.prepare('SELECT * FROM git_stacks WHERE webhook_token = ?').get(token) || null;
  }

  updateAutoDeployConfig(stackId, data) {
    const db = getDb();
    const sets = [];
    const params = [];
    const allowed = ['webhook_provider', 'polling_enabled', 'polling_interval_seconds', 'deploy_on_push'];
    for (const key of allowed) {
      if (data[key] !== undefined) {
        sets.push(`${key} = ?`);
        params.push(key === 'polling_enabled' || key === 'deploy_on_push' ? (data[key] ? 1 : 0) : data[key]);
      }
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    params.push(now());
    params.push(stackId);
    db.prepare(`UPDATE git_stacks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  /**
   * Trigger a deployment — used by webhook receiver and polling manager.
   * Returns the deployment ID.
   */
  async triggerDeploy(stackId, triggerType, userId = null) {
    const stack = this.getStack(stackId);
    if (!stack) throw Object.assign(new Error('Git stack not found'), { status: 404 });
    if (stack.status === 'deploying' || stack.status === 'cloning') {
      throw Object.assign(new Error('Stack is already deploying'), { status: 409 });
    }

    const db = getDb();
    db.prepare('UPDATE git_stacks SET status = ?, error_message = NULL, updated_at = ? WHERE id = ?')
      .run('deploying', now(), stackId);

    // Record deployment with placeholder commit info (updated after pull)
    const deploymentId = this._recordDeployment(stackId, { hash: 'pending', message: '', author: '' }, triggerType, userId);

    this._broadcast('git:deploy:start', { stack_id: stackId, stack_name: stack.stack_name, deployment_id: deploymentId });

    this._pullAndDeploy(stackId, { force: stack.force_redeploy, deploymentId, triggerType }).catch(err => {
      log.error('Triggered deploy failed', { stackId, error: err.message });
    });

    return deploymentId;
  }

  // ─── Diff & Rollback ──────────────────────────────────

  async getRepoDiff(stackId) {
    const stack = this.getStack(stackId);
    if (!stack) throw Object.assign(new Error('Git stack not found'), { status: 404 });

    const repoDir = this._getRepoDir(stackId);
    if (!fs.existsSync(repoDir)) throw new Error('Repository not cloned yet');

    const git = this._getGit(repoDir, stack);
    await git.fetch('origin', stack.branch);

    const localHash = (await git.revparse(['HEAD'])).trim();
    const remoteHash = (await git.revparse([`origin/${stack.branch}`])).trim();

    if (localHash === remoteHash) {
      return { stackId, stackName: stack.stack_name, hasChanges: false, localCommit: localHash.substring(0, 7), remoteCommit: remoteHash.substring(0, 7) };
    }

    const diff = await git.diff([localHash, `origin/${stack.branch}`]);
    const diffStat = await git.diffSummary([localHash, `origin/${stack.branch}`]);
    const commitLog = await git.log({ from: localHash, to: `origin/${stack.branch}` });

    return {
      stackId, stackName: stack.stack_name, hasChanges: true,
      localCommit: localHash.substring(0, 7),
      remoteCommit: remoteHash.substring(0, 7),
      commitsBetween: commitLog.all.map(c => ({
        hash: c.hash.substring(0, 7), message: c.message, author: c.author_name, date: c.date,
      })),
      diff,
      filesChanged: diffStat.files.map(f => ({ path: f.file, additions: f.insertions, deletions: f.deletions })),
    };
  }

  async rollbackStack(stackId, deploymentId) {
    const db = getDb();
    const stack = this.getStack(stackId);
    if (!stack) throw Object.assign(new Error('Git stack not found'), { status: 404 });

    const deployment = db.prepare('SELECT * FROM git_deployments WHERE id = ? AND git_stack_id = ?').get(deploymentId, stackId);
    if (!deployment) throw Object.assign(new Error('Deployment not found'), { status: 404 });

    const repoDir = this._getRepoDir(stackId);
    if (!fs.existsSync(repoDir)) throw new Error('Repository not cloned yet');

    db.prepare('UPDATE git_stacks SET status = ?, error_message = NULL, updated_at = ? WHERE id = ?')
      .run('deploying', now(), stackId);

    const rollbackDeployId = this._recordDeployment(stackId, {
      hash: deployment.commit_hash, message: `Rollback to ${deployment.commit_hash.substring(0, 7)}`, author: 'system',
    }, 'manual');

    try {
      const git = this._getGit(repoDir, stack);
      await git.checkout(deployment.commit_hash);

      this._writeEnvOverrides(stackId, stack);
      await this._composeUp(stackId, stack);

      const shortHash = deployment.commit_hash.substring(0, 7);
      db.prepare(`
        UPDATE git_stacks SET status = 'running', error_message = NULL,
          last_commit_hash = ?, last_commit_message = ?, last_commit_author = ?,
          last_deployed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(shortHash, `Rollback to ${shortHash}`, 'system', now(), now(), stackId);

      this._completeDeployment(rollbackDeployId, 'success');
      // Mark original deployment as rolled back
      db.prepare('UPDATE git_deployments SET status = ? WHERE id = ?').run('rolled_back', deploymentId);

      this._broadcast('git:deploy:success', { stack_id: stackId, stack_name: stack.stack_name, commit_hash: shortHash, rollback: true });
      log.info('Stack rolled back', { stackId, toCommit: shortHash });
    } catch (err) {
      this._completeDeployment(rollbackDeployId, 'failed', this._sanitizeGitError(err.message));
      db.prepare('UPDATE git_stacks SET status = ?, error_message = ?, updated_at = ? WHERE id = ?')
        .run('error', this._sanitizeGitError(err.message), now(), stackId);
      this._broadcast('git:deploy:failed', { stack_id: stackId, error: this._sanitizeGitError(err.message) });
      throw err;
    }
  }

  // ─── Internal Helpers ────────────────────────────────

  _getRepoDir(stackId) {
    return path.join(REPOS_BASE, String(stackId));
  }

  _getGit(repoDir, stack) {
    const env = {};
    if (stack.tls_skip_verify) {
      env.GIT_SSL_NO_VERIFY = 'true';
    }
    if (stack.credential_id) {
      const cred = this.getCredential(stack.credential_id);
      if (cred?.auth_type === 'ssh_key' && cred.ssh_private_key_encrypted) {
        const keyPath = this._writeTempKey(stack.id, cred);
        env.GIT_SSH_COMMAND = `ssh -i "${keyPath}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;
      }
    }
    return simpleGit(repoDir).env(env);
  }

  _buildAuthUrl(repoUrl, { credential_id, auth_type, username, password }) {
    if (repoUrl.startsWith('git@') || repoUrl.startsWith('ssh://')) {
      return repoUrl;
    }

    let cred = null;
    if (credential_id) {
      cred = this.getCredential(credential_id);
      if (!cred) throw new Error('Credential not found');
      auth_type = cred.auth_type;
      username = cred.username;
      password = cred.password_encrypted ? decrypt(cred.password_encrypted) : null;
    }

    if (!auth_type || auth_type === 'ssh_key') return repoUrl;

    try {
      const url = new URL(repoUrl);
      if (username) url.username = encodeURIComponent(username);
      if (password) url.password = encodeURIComponent(password);
      return url.toString();
    } catch {
      return repoUrl;
    }
  }

  _writeTempKey(stackId, credential) {
    const keyDir = path.join(REPOS_BASE, '.ssh-keys');
    fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    const keyPath = path.join(keyDir, `key-${stackId}`);
    const decryptedKey = decrypt(credential.ssh_private_key_encrypted);
    fs.writeFileSync(keyPath, decryptedKey, { mode: 0o600 });
    return keyPath;
  }

  _extractPublicKey(privateKeyPem) {
    try {
      const { utils: sshUtils } = require('ssh2');
      const parsed = sshUtils.parseKey(privateKeyPem);
      if (parsed instanceof Error) return null;
      const key = Array.isArray(parsed) ? parsed[0] : parsed;
      return key.getPublicSSH
        ? `${key.type} ${key.getPublicSSH().toString('base64')}`
        : null;
    } catch {
      return null;
    }
  }

  async _cloneAndDeploy(stackId) {
    const db = getDb();
    const stack = this.getStack(stackId);
    const repoDir = this._getRepoDir(stackId);

    try {
      if (fs.existsSync(repoDir)) {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
      fs.mkdirSync(repoDir, { recursive: true });

      const authUrl = this._buildAuthUrl(stack.repo_url, { credential_id: stack.credential_id });

      const env = {};
      if (stack.tls_skip_verify) env.GIT_SSL_NO_VERIFY = 'true';
      if (stack.credential_id) {
        const cred = this.getCredential(stack.credential_id);
        if (cred?.auth_type === 'ssh_key' && cred.ssh_private_key_encrypted) {
          const keyPath = this._writeTempKey(stackId, cred);
          env.GIT_SSH_COMMAND = `ssh -i "${keyPath}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;
        }
      }

      await simpleGit().env(env).clone(authUrl, repoDir, [
        '--branch', stack.branch,
        '--single-branch',
        '--depth', '50',
      ]);

      const composeFull = path.join(repoDir, stack.compose_path);
      if (!fs.existsSync(composeFull)) {
        throw new Error(`Compose file not found at '${stack.compose_path}' in repository`);
      }

      db.prepare('UPDATE git_stacks SET status = ? WHERE id = ?').run('deploying', stackId);

      this._writeEnvOverrides(stackId, stack);
      await this._composeUp(stackId, stack);

      const git = simpleGit(repoDir);
      const logResult = await git.log({ n: 1 });
      const latest = logResult.latest;

      db.prepare(`
        UPDATE git_stacks SET status = 'running', error_message = NULL,
          last_commit_hash = ?, last_commit_message = ?, last_commit_author = ?,
          last_deployed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        latest.hash.substring(0, 7),
        latest.message.substring(0, 200),
        latest.author_name,
        now(), now(), stackId
      );

      log.info('Stack cloned and deployed', { stackId, commit: latest.hash.substring(0, 7) });
      this._broadcast('git_stack_deployed', {
        stack_id: stackId, stack_name: stack.stack_name,
        commit_hash: latest.hash.substring(0, 7),
      });

    } catch (err) {
      db.prepare(
        'UPDATE git_stacks SET status = ?, error_message = ?, updated_at = ? WHERE id = ?'
      ).run('error', this._sanitizeGitError(err.message), now(), stackId);

      log.error('Clone+deploy failed', { stackId, error: err.message });
      this._broadcast('git_stack_error', {
        stack_id: stackId, stack_name: stack?.stack_name,
        error: this._sanitizeGitError(err.message),
      });
    }
  }

  async _pullAndDeploy(stackId, { force = false, deploymentId = null, triggerType = 'manual' } = {}) {
    const db = getDb();
    const stack = this.getStack(stackId);
    const repoDir = this._getRepoDir(stackId);

    try {
      if (!fs.existsSync(repoDir)) {
        return this._cloneAndDeploy(stackId);
      }

      const git = this._getGit(repoDir, stack);
      await git.fetch('origin', stack.branch);

      if (stack.force_redeploy || force) {
        await git.reset(['--hard', `origin/${stack.branch}`]);
      } else {
        await git.pull('origin', stack.branch);
      }

      const composeFull = path.join(repoDir, stack.compose_path);
      if (!fs.existsSync(composeFull)) {
        throw new Error(`Compose file not found at '${stack.compose_path}' in repository`);
      }

      this._writeEnvOverrides(stackId, stack);
      await this._composeUp(stackId, stack);

      const logResult = await git.log({ n: 1 });
      const latest = logResult.latest;
      const shortHash = latest.hash.substring(0, 7);

      // Update deployment record
      if (deploymentId) {
        db.prepare('UPDATE git_deployments SET commit_hash = ?, commit_message = ?, commit_author = ? WHERE id = ?')
          .run(latest.hash, latest.message.substring(0, 200), latest.author_name, deploymentId);
        this._completeDeployment(deploymentId, 'success');
      }

      db.prepare(`
        UPDATE git_stacks SET status = 'running', error_message = NULL,
          last_commit_hash = ?, last_commit_message = ?, last_commit_author = ?,
          last_deployed_at = ?, deployment_count = deployment_count + 1,
          ${deploymentId ? 'last_deployment_id = ?,' : ''} updated_at = ?
        WHERE id = ?
      `).run(
        ...[shortHash, latest.message.substring(0, 200), latest.author_name, now()],
        ...(deploymentId ? [deploymentId] : []),
        now(), stackId
      );

      log.info('Stack redeployed', { stackId, commit: shortHash, trigger: triggerType });
      this._broadcast('git:deploy:success', {
        stack_id: stackId, stack_name: stack.stack_name, commit_hash: shortHash,
      });

    } catch (err) {
      if (deploymentId) {
        this._completeDeployment(deploymentId, 'failed', this._sanitizeGitError(err.message));
      }

      db.prepare(
        'UPDATE git_stacks SET status = ?, error_message = ?, updated_at = ? WHERE id = ?'
      ).run('error', this._sanitizeGitError(err.message), now(), stackId);

      log.error('Pull+deploy failed', { stackId, error: err.message });
      this._broadcast('git:deploy:failed', {
        stack_id: stackId, stack_name: stack?.stack_name,
        error: this._sanitizeGitError(err.message),
      });
    }
  }

  _writeEnvOverrides(stackId, stack) {
    if (!stack.env_overrides) return;
    const overrides = typeof stack.env_overrides === 'string'
      ? JSON.parse(stack.env_overrides)
      : stack.env_overrides;
    if (!overrides || Object.keys(overrides).length === 0) return;

    const repoDir = this._getRepoDir(stackId);
    const envPath = path.join(repoDir, '.env.override');
    const lines = [];
    for (const [k, v] of Object.entries(overrides)) {
      if (typeof v === 'object' && v !== null) {
        // Structured format: decrypt sensitive values
        const val = v.sensitive ? decrypt(v.value) : v.value;
        lines.push(`${k}=${val}`);
      } else {
        lines.push(`${k}=${v}`);
      }
    }
    fs.writeFileSync(envPath, lines.join('\n') + '\n', 'utf8');
  }

  async _composeUp(stackId, stack) {
    const repoDir = this._getRepoDir(stackId);
    const envFile = path.join(repoDir, '.env.override');
    const hasEnvOverride = fs.existsSync(envFile);

    // Build compose file flags (multi-file support)
    let composeFiles = [];
    if (stack.additional_files) {
      const parsed = typeof stack.additional_files === 'string'
        ? JSON.parse(stack.additional_files) : stack.additional_files;
      if (Array.isArray(parsed) && parsed.length > 0) composeFiles = parsed;
    }
    if (composeFiles.length === 0) composeFiles = [stack.compose_path];

    // Validate all files exist
    for (const f of composeFiles) {
      const full = path.join(repoDir, f);
      if (!fs.existsSync(full)) throw new Error(`Compose file not found: ${f}`);
    }

    const fileFlags = composeFiles.map(f => `-f "${path.join(repoDir, f)}"`).join(' ');

    let cmd = `cd "${repoDir}"`;
    if (stack.re_pull_images) {
      cmd += ` && docker compose ${fileFlags} -p "${stack.stack_name}" pull`;
    }
    cmd += ` && docker compose ${fileFlags} -p "${stack.stack_name}"`;
    if (hasEnvOverride) {
      cmd += ` --env-file "${envFile}"`;
    }
    cmd += ' up -d --remove-orphans';

    this._exec(cmd);
  }

  // ─── Env Var Management ──────────────────────────────

  getEnvOverrides(stackId) {
    const stack = this.getStack(stackId);
    if (!stack) throw Object.assign(new Error('Git stack not found'), { status: 404 });

    const overrides = stack.env_overrides || {};
    const result = [];
    for (const [key, val] of Object.entries(overrides)) {
      if (typeof val === 'object' && val !== null) {
        // Structured format: { value, sensitive }
        result.push({
          key,
          value: val.sensitive ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' : val.value,
          sensitive: !!val.sensitive,
          source: 'override',
        });
      } else {
        // Simple key=value (legacy format)
        result.push({ key, value: String(val), sensitive: false, source: 'override' });
      }
    }
    return { variables: result };
  }

  updateEnvOverrides(stackId, variables) {
    const db = getDb();
    const stack = this.getStack(stackId);
    if (!stack) throw Object.assign(new Error('Git stack not found'), { status: 404 });

    const overrides = {};
    for (const v of variables) {
      if (!v.key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.key)) continue;
      if (v.sensitive) {
        overrides[v.key] = { value: encrypt(v.value), sensitive: true };
      } else {
        overrides[v.key] = { value: v.value, sensitive: false };
      }
    }

    db.prepare('UPDATE git_stacks SET env_overrides = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(overrides), now(), stackId);
  }

  importEnvFile(stackId, content, sensitiveKeys = []) {
    const variables = [];
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.substring(0, eqIdx).trim();
      let value = trimmed.substring(eqIdx + 1).trim();
      // Remove surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        variables.push({ key, value, sensitive: sensitiveKeys.includes(key) });
      }
    }
    return variables;
  }

  _exec(cmd) {
    return execSync(cmd, { timeout: 120000, encoding: 'utf8', stdio: 'pipe' });
  }

  _validateStackName(name) {
    if (!name || typeof name !== 'string') throw new Error('Stack name is required');
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
      throw new Error('Stack name must be lowercase alphanumeric with hyphens/underscores only');
    }
    if (name.length > 100) throw new Error('Stack name too long (max 100)');
  }

  _validateRepoUrl(url) {
    if (!url || typeof url !== 'string') throw new Error('Repository URL is required');
    if (!/^(https?:\/\/|git@|ssh:\/\/)/.test(url)) {
      throw new Error('Invalid Git URL. Must start with https://, http://, git@, or ssh://');
    }
    const dangerous = /[;&|`$(){}!#<>\\]/;
    if (dangerous.test(url)) {
      throw new Error('Invalid characters in Git URL');
    }
    if (url.length > 500) throw new Error('Git URL too long');
  }

  _validateComposePath(composePath) {
    const normalized = path.normalize(composePath);
    if (normalized.startsWith('..') || path.isAbsolute(normalized) || normalized.includes('..')) {
      throw new Error('Invalid compose path: must be relative to repository root');
    }
    if (!normalized.endsWith('.yml') && !normalized.endsWith('.yaml')) {
      throw new Error('Compose path must end with .yml or .yaml');
    }
  }

  _sanitizeGitError(message) {
    return message
      .replace(/https?:\/\/[^@\s]+@/g, 'https://***@')
      .replace(/password_encrypted.*$/gm, '[redacted]')
      .substring(0, 500);
  }

  _broadcast(event, data) {
    try {
      const wsServer = require('../ws');
      if (wsServer?.broadcastAll) wsServer.broadcastAll(event, data);
    } catch { /* WS not available */ }
  }
}

module.exports = new GitService();
