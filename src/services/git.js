'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
// child_process used via _execFile method (execFileSync)
const simpleGit = require('simple-git');
const { getDb } = require('../db');
const { encrypt, decrypt, generateToken } = require('../utils/crypto');
const { now } = require('../utils/helpers');
const log = require('../utils/logger')('git');
const dockerService = require('./docker');
const gitTargets = require('./git-multi-host');

const REPOS_BASE = path.join(process.env.DATA_DIR || '/data', 'repos');
const PREVIEWS_BASE = path.join(process.env.DATA_DIR || '/data', 'previews');
const DEFAULT_ROLLOUT_POLICY = Object.freeze({
  enabled: false,
  strategy: 'fixed',
  initialWave: 1,
  multiplier: 2,
  maxParallel: 3,
  delaySeconds: 0,
  healthGate: true,
  healthTimeoutSeconds: 120,
  onFailure: 'pause',
});

// v8.7.10 — Per-operation timeouts for simple-git. Without these, a slow or
// hung git remote (dead TLS handshake, rate-limited, broken DNS) blocks the
// underlying child process FOREVER, with these consequences:
//   - gitPolling cron's `_checking` Set guard stays held → that stack stops
//     being polled, silently, until process restart.
//   - Interactive endpoints (/git/stacks/:id/{check,deploy,rollback}) tie up
//     an express worker for the same forever.
//   - Initial clone hangs leave the stack in `deploying` status indefinitely.
// simple-git 3.x honors `timeout: { block: <ms> }` on the constructor.
const GIT_FETCH_TIMEOUT_MS = 120_000;       // 2 min — fetch / pull / log / checkForUpdates
const GIT_CLONE_TIMEOUT_MS = 300_000;       // 5 min — initial clone (large repos)
const GIT_REMOTE_PROBE_TIMEOUT_MS = 30_000; // 30 sec — listRemote (credential test)
const _gitOpts = (ms = GIT_FETCH_TIMEOUT_MS) => ({ timeout: { block: ms } });

class GitService {
  constructor() {
    fs.mkdirSync(REPOS_BASE, { recursive: true });
    fs.mkdirSync(PREVIEWS_BASE, { recursive: true });
    // Cleanup stale SSH keys on startup (H9 fix)
    this._cleanupSshKeys();
  }

  _cleanupSshKeys() {
    const keyDir = path.join(REPOS_BASE, '.ssh-keys');
    if (!fs.existsSync(keyDir)) return;
    try {
      const files = fs.readdirSync(keyDir);
      for (const file of files) {
        const keyPath = path.join(keyDir, file);
        const stat = fs.statSync(keyPath);
        // Remove keys older than 24h (stale from crashed processes)
        if (Date.now() - stat.mtimeMs > 86400000) {
          fs.unlinkSync(keyPath);
          log.debug('Cleaned up stale SSH key', { file });
        }
      }
    } catch { /* cleanup is best-effort */ }
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

  _decorateStackRow(row) {
    if (!row) return null;
    const targets = gitTargets.listTargets(row.id);
    let rolloutPolicy;
    try {
      rolloutPolicy = this._validateRolloutPolicy(row.rollout_policy, { allowDisabled: true });
    } catch (err) {
      log.warn('Ignoring invalid stored rollout policy', { stackId: row.id, error: err.message });
      rolloutPolicy = { ...DEFAULT_ROLLOUT_POLICY, enabled: false };
    }
    return {
      ...row,
      env_overrides: row.env_overrides ? JSON.parse(row.env_overrides) : null,
      force_redeploy: !!row.force_redeploy,
      re_pull_images: !!row.re_pull_images,
      tls_skip_verify: !!row.tls_skip_verify,
      rollout_policy: rolloutPolicy,
      targets,
      target_host_ids: targets.map(target => target.host_id),
    };
  }

  listStacks(hostId) {
    const db = getDb();
    let sql = `
      SELECT gs.*, gc.name AS credential_name
      FROM git_stacks gs
      LEFT JOIN git_credentials gc ON gs.credential_id = gc.id
    `;
    const params = [];
    if (hostId !== undefined && hostId !== null) {
      const normalizedHostId = require('./host-permissions').normalizeHostId(hostId);
      sql += ` WHERE EXISTS (
        SELECT 1 FROM git_stack_targets target
        WHERE target.stack_id = gs.id AND target.host_id = ?
      ) OR (NOT EXISTS (
        SELECT 1 FROM git_stack_targets target WHERE target.stack_id = gs.id
      ) AND gs.host_id = ?)`;
      params.push(normalizedHostId, normalizedHostId);
    }
    sql += ' ORDER BY gs.stack_name';

    return db.prepare(sql).all(...params).map(row => this._decorateStackRow(row));
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
    return this._decorateStackRow(r);
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

    const targetHostIds = gitTargets.normalizeTargetHostIds(
      data.target_host_ids || data.hostIds || [data.host_id ?? 0]
    );
    const rolloutPolicy = this._validateRolloutPolicy(
      data.rollout_policy || data.rolloutPolicy,
      { allowDisabled: true }
    );
    const deployImmediately = data.deploy_immediately !== false;

    const r = db.prepare(`
      INSERT INTO git_stacks (stack_name, host_id, repo_url, branch, compose_path,
        credential_id, env_overrides, force_redeploy, re_pull_images, tls_skip_verify,
        rollout_policy, status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.stack_name,
      targetHostIds[0],
      data.repo_url,
      data.branch || 'main',
      data.compose_path || 'docker-compose.yml',
      data.credential_id || null,
      data.env_overrides ? JSON.stringify(data.env_overrides) : null,
      data.force_redeploy !== false ? 1 : 0,
      data.re_pull_images ? 1 : 0,
      data.tls_skip_verify ? 1 : 0,
      JSON.stringify(rolloutPolicy),
      deployImmediately ? 'cloning' : 'pending',
      data.created_by,
    );

    const id = Number(r.lastInsertRowid);
    gitTargets.setTargets(id, targetHostIds);
    log.info('Git stack created', { id, stack_name: data.stack_name, repo_url: data.repo_url });

    // Declarative GitOps apply creates desired configuration without an
    // implicit production mutation. Interactive creation keeps the original
    // clone-and-deploy behavior.
    if (deployImmediately) {
      this._cloneAndDeploy(id).catch(err => {
        log.error('Initial clone+deploy failed', { stackId: id, error: err.message });
      });
    }

    return { id, stack_name: data.stack_name, status: deployImmediately ? 'cloning' : 'pending' };
  }

  updateStack(id, data) {
    const db = getDb();
    const existing = this.getStack(id);
    if (!existing) throw Object.assign(new Error('Git stack not found'), { status: 404 });
    const changesTargets = data.target_host_ids !== undefined || data.hostIds !== undefined;
    if (changesTargets && (existing.status === 'deploying' || existing.status === 'cloning')) {
      throw Object.assign(new Error('Deployment targets cannot be changed while the stack is deploying'), { status: 409 });
    }

    if (data.compose_path) this._validateComposePath(data.compose_path);

    if (data.rolloutPolicy !== undefined && data.rollout_policy === undefined) {
      data.rollout_policy = data.rolloutPolicy;
    }

    const sets = [];
    const params = [];
    const allowed = ['branch', 'compose_path', 'credential_id', 'env_overrides',
      'force_redeploy', 're_pull_images', 'tls_skip_verify', 'additional_files', 'custom_ca_cert',
      'rollout_policy'];

    for (const key of allowed) {
      if (data[key] !== undefined) {
        sets.push(`${key} = ?`);
        if (key === 'rollout_policy')
          params.push(JSON.stringify(this._validateRolloutPolicy(data[key], { allowDisabled: true })));
        else if (key === 'env_overrides' || key === 'additional_files')
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

    if (sets.length > 0) {
      sets.push('updated_at = ?');
      params.push(now());
      params.push(id);
      db.prepare(`UPDATE git_stacks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    }
    if (changesTargets) {
      gitTargets.setTargets(id, data.target_host_ids || data.hostIds);
    }
    if (sets.length === 0 && data.target_host_ids === undefined && data.hostIds === undefined) return;
    log.info('Git stack updated', { id });
  }

  async deleteStack(id, { removeContainers = false, removeVolumes = false } = {}) {
    const stack = this.getStack(id);
    if (!stack) throw Object.assign(new Error('Git stack not found'), { status: 404 });

    const repoDir = path.join(REPOS_BASE, String(id));

    if (removeContainers && fs.existsSync(repoDir)) {
      for (const target of this._deploymentTargets(stack)) {
        try {
          await this._composeDown(id, stack, target.host_id, { removeVolumes });
        } catch (err) {
          log.warn('compose down failed during delete', {
            stackId: id, hostId: target.host_id, error: err.message,
          });
        }
      }
    }

    if (fs.existsSync(repoDir)) {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }

    // Clean up SSH key and CA cert
    const keyPath = path.join(REPOS_BASE, '.ssh-keys', `key-${id}`);
    if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
    const certPath = path.join(REPOS_BASE, `ca-${id}.pem`);
    if (fs.existsSync(certPath)) fs.unlinkSync(certPath);

    getDb().prepare('DELETE FROM git_stacks WHERE id = ?').run(id);
    log.info('Git stack deleted', { id, stack_name: stack.stack_name });
  }

  // ─── Deploy & Check ──────────────────────────────────

  async deployStack(id, { force = false, actor = null } = {}) {
    const db = getDb();
    const stack = this.getStack(id);
    if (!stack) throw Object.assign(new Error('Git stack not found'), { status: 404 });
    if (stack.status === 'deploying' || stack.status === 'cloning') {
      throw Object.assign(new Error('Stack is already deploying'), { status: 409 });
    }

    db.prepare('UPDATE git_stacks SET status = ?, error_message = NULL, updated_at = ? WHERE id = ?')
      .run('deploying', now(), id);

    const deploymentId = this._recordDeployment(
      id, { hash: 'pending', message: '', author: '' }, 'manual', actor?.userId || null
    );
    this._broadcast('git:deploy:start', {
      stack_id: id, stack_name: stack.stack_name, deployment_id: deploymentId,
    });

    this._pullAndDeploy(id, { force, deploymentId, triggerType: 'manual', actor }).catch(err => {
      log.error('Deploy failed', { stackId: id, error: err.message });
    });
    return deploymentId;
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

      const result = await simpleGit(undefined, _gitOpts(GIT_REMOTE_PROBE_TIMEOUT_MS)).env(env).listRemote(['--heads', url]);
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
    const rows = db.prepare(sql).all(...params).map(row => ({
      ...row,
      rollout_policy: this._parseJson(row.rollout_policy_json, null),
      target_results: this._parseJson(row.target_results_json, []),
    }));
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
    const startedAt = deployment?.started_at;
    const durationMs = startedAt ? Date.now() - new Date(startedAt.endsWith('Z') ? startedAt : startedAt + 'Z').getTime() : null;
    db.prepare(`
      UPDATE git_deployments SET status = ?, error_message = ?, finished_at = datetime('now'), duration_ms = ?
      WHERE id = ?
    `).run(status, errorMessage, durationMs, deploymentId);
  }

  _storeDeploymentRollout(deploymentId, policy, results) {
    if (!deploymentId) return;
    getDb().prepare(`
      UPDATE git_deployments SET rollout_policy_json = ?, target_results_json = ? WHERE id = ?
    `).run(JSON.stringify(policy), JSON.stringify(results || []), deploymentId);
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
  async triggerDeploy(stackId, triggerType, userId = null, actor = null) {
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

    this._pullAndDeploy(stackId, {
      force: stack.force_redeploy, deploymentId, triggerType,
      actor: actor || (userId ? { userId } : null),
    }).catch(err => {
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

  async rollbackStack(stackId, deploymentId, actor = null) {
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
      const shortHash = deployment.commit_hash.substring(0, 7);
      const targetResults = await this._deployComposeToTargets(stackId, stack, {
        commit: shortHash, triggerType: 'rollback', actor,
        deploymentId: rollbackDeployId, rolloutPolicy: { enabled: false },
      });
      db.prepare(`
        UPDATE git_stacks SET status = 'running', error_message = NULL,
          last_commit_hash = ?, last_commit_message = ?, last_commit_author = ?,
          last_deployed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(shortHash, `Rollback to ${shortHash}`, 'system', now(), now(), stackId);

      this._completeDeployment(rollbackDeployId, 'success');
      // Mark original deployment as rolled back
      db.prepare('UPDATE git_deployments SET status = ? WHERE id = ?').run('rolled_back', deploymentId);

      this._broadcast('git:deploy:success', {
        stack_id: stackId, stack_name: stack.stack_name, commit_hash: shortHash,
        rollback: true, targets: targetResults,
      });
      log.info('Stack rolled back', { stackId, toCommit: shortHash, targets: targetResults.length });
    } catch (err) {
      this._completeDeployment(rollbackDeployId, 'failed', this._sanitizeGitError(err.message));
      db.prepare('UPDATE git_stacks SET status = ?, error_message = ?, updated_at = ? WHERE id = ?')
        .run('error', this._sanitizeGitError(err.message), now(), stackId);
      this._broadcast('git:deploy:failed', { stack_id: stackId, error: this._sanitizeGitError(err.message) });
      throw err;
    }
  }

  // ─── Push to Git ───────────────────────────────────

  async getRemoteStatus(stackId) {
    const stack = this.getStack(stackId);
    if (!stack) throw Object.assign(new Error('Git stack not found'), { status: 404 });

    const repoDir = this._getRepoDir(stackId);
    if (!fs.existsSync(repoDir)) throw new Error('Repository not cloned yet');

    const git = this._getGit(repoDir, stack);
    await git.fetch('origin', stack.branch);

    const localHead = (await git.revparse(['HEAD'])).trim();
    const remoteHead = (await git.revparse([`origin/${stack.branch}`])).trim();

    let localAhead = 0, localBehind = 0, remoteCommits = [];

    if (localHead !== remoteHead) {
      try {
        const behindLog = await git.log({ from: 'HEAD', to: `origin/${stack.branch}` });
        localBehind = behindLog.all.length;
        remoteCommits = behindLog.all.map(c => ({
          hash: c.hash.substring(0, 7), message: c.message, author: c.author_name, date: c.date,
        }));
      } catch {}
      try {
        const aheadLog = await git.log({ from: `origin/${stack.branch}`, to: 'HEAD' });
        localAhead = aheadLog.all.length;
      } catch {}
    }

    return {
      localHead: localHead.substring(0, 7),
      remoteHead: remoteHead.substring(0, 7),
      isUpToDate: localHead === remoteHead,
      localAhead, localBehind, remoteCommits,
    };
  }

  async pushToGit(stackId, { commitMessage, files, author, forcePush = false }) {
    const stack = this.getStack(stackId);
    if (!stack) throw Object.assign(new Error('Git stack not found'), { status: 404 });

    const repoPath = this._getRepoDir(stackId);
    if (!fs.existsSync(repoPath)) throw new Error('Repository not cloned yet');
    const repoDir = fs.realpathSync(repoPath);

    const git = this._getGit(repoDir, stack);

    // Check remote status
    if (!forcePush) {
      await git.fetch('origin', stack.branch);
      const localHead = (await git.revparse(['HEAD'])).trim();
      const remoteHead = (await git.revparse([`origin/${stack.branch}`])).trim();

      if (localHead !== remoteHead) {
        // Check if remote is ahead
        try {
          const behindLog = await git.log({ from: localHead, to: remoteHead });
          if (behindLog.all.length > 0) {
            throw Object.assign(new Error('Remote has newer changes. Pull first or force push.'), { status: 409 });
          }
        } catch (err) {
          if (err.status === 409) throw err;
        }
      }
    }

    // Write files
    const writtenFiles = [];
    for (const [filePath, content] of Object.entries(files)) {
      this._validateComposePath(filePath);
      const fullPath = this._resolveRepoFile(repoDir, filePath);
      const dir = path.dirname(fullPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf8');
      writtenFiles.push(filePath);
    }

    // Stage, commit, push
    await git.add(writtenFiles);
    const authorStr = author || 'Docker Dash <noreply@docker-dash.local>';
    await git.commit(commitMessage || 'Update from Docker Dash', writtenFiles, { '--author': authorStr });

    if (forcePush) {
      await git.push('origin', stack.branch, ['--force-with-lease']);
    } else {
      await git.push('origin', stack.branch);
    }

    // Update stack commit info
    const logResult = await git.log({ n: 1 });
    const latest = logResult.latest;
    const db = getDb();
    db.prepare(`
      UPDATE git_stacks SET last_commit_hash = ?, last_commit_message = ?, last_commit_author = ?, updated_at = ?
      WHERE id = ?
    `).run(latest.hash.substring(0, 7), latest.message.substring(0, 200), latest.author_name, now(), stackId);

    log.info('Pushed to Git', { stackId, commit: latest.hash.substring(0, 7) });
    return { ok: true, commitHash: latest.hash.substring(0, 7) };
  }

  readComposeFile(stackId, filePath) {
    const stack = this.getStack(stackId);
    if (!stack) throw Object.assign(new Error('Git stack not found'), { status: 404 });
    const relativePath = filePath || stack.compose_path || 'docker-compose.yml';
    this._validateComposePath(relativePath);

    const repoPath = this._getRepoDir(stackId);
    if (!fs.existsSync(repoPath)) {
      throw Object.assign(new Error('Compose file not found'), { status: 404 });
    }
    const repoDir = fs.realpathSync(repoPath);
    let fullPath;
    try { fullPath = this._resolveRepoFile(repoDir, relativePath, { mustExist: true }); }
    catch (err) {
      if (err.code === 'ENOENT') throw Object.assign(new Error('Compose file not found'), { status: 404 });
      throw err;
    }
    let stat;
    try { stat = fs.statSync(fullPath); }
    catch { throw Object.assign(new Error('Compose file not found'), { status: 404 }); }
    if (!stat.isFile()) throw Object.assign(new Error('Compose path is not a file'), { status: 400 });
    if (stat.size > 2 * 1024 * 1024) {
      throw Object.assign(new Error('Compose file exceeds 2 MB'), { status: 413 });
    }
    return { path: relativePath, content: fs.readFileSync(fullPath, 'utf8') };
  }

  /**
   * Prepare a checkout dedicated to a pull-request preview. The destination
   * is derived from a numeric database id and can never escape PREVIEWS_BASE.
   * Production env overrides are intentionally not copied here.
   */
  async preparePreviewCheckout(stackId, previewId, { ref, sha, repositoryUrl = null, useStackCredentials = true } = {}) {
    const stack = this.getStack(stackId);
    if (!stack) throw Object.assign(new Error('Git stack not found'), { status: 404 });
    if (!Number.isInteger(Number(previewId)) || Number(previewId) <= 0) {
      throw Object.assign(new Error('Invalid preview id'), { status: 400 });
    }
    if (!ref || !/^[A-Za-z0-9._\/-]{1,240}$/.test(ref) || ref.includes('..')) {
      throw Object.assign(new Error('Invalid preview Git ref'), { status: 400 });
    }
    if (sha && !/^[a-f0-9]{7,64}$/i.test(sha)) {
      throw Object.assign(new Error('Invalid preview commit SHA'), { status: 400 });
    }

    const previewDir = path.join(PREVIEWS_BASE, String(Number(previewId)));
    if (fs.existsSync(previewDir)) fs.rmSync(previewDir, { recursive: true, force: true });
    fs.mkdirSync(previewDir, { recursive: true });

    const sourceUrl = repositoryUrl || stack.repo_url;
    this._validateRepoUrl(sourceUrl);
    const authUrl = useStackCredentials
      ? this._buildAuthUrl(sourceUrl, { credential_id: stack.credential_id })
      : sourceUrl;
    const env = {};
    let caPath = null;
    if (stack.tls_skip_verify) env.GIT_SSL_NO_VERIFY = 'true';
    else if (stack.custom_ca_cert) {
      caPath = path.join(REPOS_BASE, `ca-preview-${Number(previewId)}.pem`);
      fs.writeFileSync(caPath, stack.custom_ca_cert, { mode: 0o600 });
      env.GIT_SSL_CAINFO = caPath;
    }
    if (useStackCredentials && stack.credential_id) {
      const cred = this.getCredential(stack.credential_id);
      if (cred?.auth_type === 'ssh_key' && cred.ssh_private_key_encrypted) {
        const keyPath = this._writeTempKey(stack.id, cred);
        env.GIT_SSH_COMMAND = `ssh -i "${keyPath}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;
      }
    }

    try {
      await simpleGit(undefined, _gitOpts(GIT_CLONE_TIMEOUT_MS)).env(env).clone(authUrl, previewDir, [
        '--branch', ref, '--single-branch', '--depth', '50',
      ]);
      const checkout = simpleGit(previewDir, _gitOpts()).env(env);
      if (sha) await checkout.checkout(sha);
      const resolvedSha = (await checkout.revparse(['HEAD'])).trim();
      if (sha && !resolvedSha.toLowerCase().startsWith(sha.toLowerCase())) {
        throw new Error('Checked-out commit does not match webhook head SHA');
      }
      return { directory: previewDir, commit: resolvedSha, stack };
    } catch (err) {
      if (fs.existsSync(previewDir)) fs.rmSync(previewDir, { recursive: true, force: true });
      throw err;
    } finally {
      if (caPath && fs.existsSync(caPath)) fs.unlinkSync(caPath);
    }
  }

  getPreviewDirectory(previewId) {
    const id = Number(previewId);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid preview id');
    return path.join(PREVIEWS_BASE, String(id));
  }

  getDockerCliEnvironment(hostId) {
    return this._dockerCliEnvForHost(hostId);
  }

  // ─── Internal Helpers ────────────────────────────────

  _getRepoDir(stackId) {
    return path.join(REPOS_BASE, String(stackId));
  }

  _getGit(repoDir, stack) {
    const env = {};
    if (stack.tls_skip_verify) {
      env.GIT_SSL_NO_VERIFY = 'true';
    } else if (stack.custom_ca_cert) {
      // Write CA cert to temp file and point Git to it
      const certPath = path.join(REPOS_BASE, `ca-${stack.id}.pem`);
      fs.writeFileSync(certPath, stack.custom_ca_cert, 'utf8');
      env.GIT_SSL_CAINFO = certPath;
    }
    if (stack.credential_id) {
      const cred = this.getCredential(stack.credential_id);
      if (cred?.auth_type === 'ssh_key' && cred.ssh_private_key_encrypted) {
        const keyPath = this._writeTempKey(stack.id, cred);
        env.GIT_SSH_COMMAND = `ssh -i "${keyPath}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;
      }
    }
    return simpleGit(repoDir, _gitOpts()).env(env);
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

  async _cloneAndDeploy(stackId, { deploymentId = null, triggerType = 'manual', actor = null } = {}) {
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

      await simpleGit(undefined, _gitOpts(GIT_CLONE_TIMEOUT_MS)).env(env).clone(authUrl, repoDir, [
        '--branch', stack.branch,
        '--single-branch',
        '--depth', '50',
      ]);

      const composeFull = path.join(repoDir, stack.compose_path);
      if (!fs.existsSync(composeFull)) {
        throw new Error(`Compose file not found at '${stack.compose_path}' in repository`);
      }

      db.prepare('UPDATE git_stacks SET status = ? WHERE id = ?').run('deploying', stackId);

      const git = simpleGit(repoDir, _gitOpts());
      const logResult = await git.log({ n: 1 });
      const latest = logResult.latest;
      const shortHash = latest.hash.substring(0, 7);

      if (deploymentId) {
        db.prepare('UPDATE git_deployments SET commit_hash = ?, commit_message = ?, commit_author = ? WHERE id = ?')
          .run(latest.hash, latest.message.substring(0, 200), latest.author_name, deploymentId);
      }

      this._writeEnvOverrides(stackId, stack);
      const targetResults = await this._deployComposeToTargets(stackId, stack, {
        commit: shortHash, triggerType, actor, deploymentId,
      });

      db.prepare(`
        UPDATE git_stacks SET status = 'running', error_message = NULL,
          last_commit_hash = ?, last_commit_message = ?, last_commit_author = ?,
          last_deployed_at = ?, deployment_count = deployment_count + 1,
          ${deploymentId ? 'last_deployment_id = ?,' : ''} updated_at = ?
        WHERE id = ?
      `).run(
        shortHash,
        latest.message.substring(0, 200),
        latest.author_name,
        now(), ...(deploymentId ? [deploymentId] : []), now(), stackId
      );
      if (deploymentId) this._completeDeployment(deploymentId, 'success');

      log.info('Stack cloned and deployed', { stackId, commit: shortHash, targets: targetResults.length });
      this._broadcast('git_stack_deployed', {
        stack_id: stackId, stack_name: stack.stack_name,
        commit_hash: shortHash, targets: targetResults,
      });

    } catch (err) {
      if (deploymentId) {
        this._completeDeployment(deploymentId, 'failed', this._sanitizeGitError(err.message));
      }
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

  async _pullAndDeploy(stackId, {
    force = false, deploymentId = null, triggerType = 'manual', actor = null,
  } = {}) {
    const db = getDb();
    const stack = this.getStack(stackId);
    const repoDir = this._getRepoDir(stackId);

    try {
      if (!fs.existsSync(repoDir)) {
        return this._cloneAndDeploy(stackId, { deploymentId, triggerType, actor });
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

      const logResult = await git.log({ n: 1 });
      const latest = logResult.latest;
      const shortHash = latest.hash.substring(0, 7);

      if (deploymentId) {
        db.prepare('UPDATE git_deployments SET commit_hash = ?, commit_message = ?, commit_author = ? WHERE id = ?')
          .run(latest.hash, latest.message.substring(0, 200), latest.author_name, deploymentId);
      }

      this._writeEnvOverrides(stackId, stack);
      const targetResults = await this._deployComposeToTargets(stackId, stack, {
        commit: shortHash, triggerType, actor, deploymentId,
      });
      if (deploymentId) this._completeDeployment(deploymentId, 'success');

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

      log.info('Stack redeployed', {
        stackId, commit: shortHash, trigger: triggerType, targets: targetResults.length,
      });
      this._broadcast('git:deploy:success', {
        stack_id: stackId, stack_name: stack.stack_name, commit_hash: shortHash,
        targets: targetResults,
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

  _deploymentTargets(stack) {
    if (Array.isArray(stack.targets) && stack.targets.length > 0) return stack.targets;
    const hostIds = gitTargets.normalizeTargetHostIds([stack.host_id ?? 0]);
    return gitTargets.setTargets(stack.id, hostIds);
  }

  _dockerCliEnvForHost(hostId) {
    const host = dockerService._getHostConfig(hostId);
    const env = { ...process.env, COMPOSE_ANSI: 'never' };
    delete env.DOCKER_CONTEXT;
    delete env.DOCKER_HOST;
    delete env.DOCKER_TLS_VERIFY;
    delete env.DOCKER_CERT_PATH;

    let certDir = null;
    if (host.connectionType === 'socket') {
      const socketPath = host.socketPath || '/var/run/docker.sock';
      env.DOCKER_HOST = socketPath.startsWith('npipe://')
        ? socketPath
        : `unix://${socketPath}`;
    } else if (host.connectionType === 'ssh') {
      const tunnel = require('./ssh-tunnel').getTunnel(host.id);
      if (!tunnel?.localPort) {
        throw new Error(`SSH tunnel for host "${host.name}" is not ready`);
      }
      env.DOCKER_HOST = `tcp://127.0.0.1:${tunnel.localPort}`;
    } else if (host.connectionType === 'tcp') {
      env.DOCKER_HOST = `tcp://${host.host}:${host.port || (host.tlsConfig ? 2376 : 2375)}`;
      if (host.tlsConfig) {
        const certFiles = [
          ['ca.pem', host.tlsConfig.ca],
          ['cert.pem', host.tlsConfig.cert],
          ['key.pem', host.tlsConfig.key],
        ];
        for (const [filename, contents] of certFiles) {
          if (!contents) throw new Error(`TLS ${filename} is missing for host "${host.name}"`);
        }
        certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-dash-compose-tls-'));
        try {
          for (const [filename, contents] of certFiles) {
            fs.writeFileSync(path.join(certDir, filename), contents, { mode: 0o600 });
          }
        } catch (err) {
          fs.rmSync(certDir, { recursive: true, force: true });
          certDir = null;
          throw err;
        }
        env.DOCKER_TLS_VERIFY = '1';
        env.DOCKER_CERT_PATH = certDir;
      }
    } else {
      throw new Error(`Unsupported connection type "${host.connectionType}" for host "${host.name}"`);
    }

    return {
      env,
      cleanup: () => {
        if (certDir && fs.existsSync(certDir)) {
          fs.rmSync(certDir, { recursive: true, force: true });
        }
      },
    };
  }

  async _deployComposeToTargets(stackId, stack, {
    commit, triggerType = 'manual', actor = null, deploymentId = null, rolloutPolicy = null,
  } = {}) {
    const targets = this._deploymentTargets(stack);
    gitTargets.markTargetsPending(stackId);
    const policy = this._validateRolloutPolicy(
      rolloutPolicy || stack.rollout_policy,
      { allowDisabled: true }
    );

    if (!policy.enabled || targets.length <= 1) {
      return this._deployTargetsLegacy(stackId, stack, targets, {
        commit, triggerType, actor, deploymentId, policy,
      });
    }

    const results = [];
    let cursor = 0;
    let waveNumber = 0;
    let waveSize = Math.min(policy.initialWave, policy.maxParallel, targets.length);

    while (cursor < targets.length) {
      waveNumber++;
      const wave = targets.slice(cursor, cursor + waveSize);
      const waveResults = await Promise.all(wave.map(target => this._deployOneTarget(
        stackId, stack, target,
        { commit, triggerType, actor, policy, wave: waveNumber }
      )));
      results.push(...waveResults);
      cursor += wave.length;
      this._storeDeploymentRollout(deploymentId, policy, results);

      const failed = waveResults.filter(result => result.status === 'failed');
      if (failed.length && policy.onFailure !== 'continue') {
        for (const untouched of targets.slice(cursor)) {
          results.push({
            hostId: untouched.host_id, hostName: untouched.host_name,
            wave: null, status: 'untouched', changed: false,
          });
        }
        if (policy.onFailure === 'rollback') {
          await this._rollbackRolloutTargets(stackId, stack, commit, results, { triggerType, actor });
        }
        this._storeDeploymentRollout(deploymentId, policy, results);
        const verb = policy.onFailure === 'pause' ? 'paused' : 'rolled back';
        const err = new Error(`Rollout ${verb} after wave ${waveNumber} failed on ${failed.length} target(s)`);
        err.targetResults = results;
        err.rolloutPolicy = policy;
        err.rolloutPaused = policy.onFailure === 'pause';
        throw err;
      }

      if (cursor < targets.length && policy.delaySeconds > 0) {
        await this._sleep(policy.delaySeconds * 1000);
      }
      const remaining = targets.length - cursor;
      if (remaining > 0) {
        waveSize = policy.strategy === 'exponential'
          ? Math.min(waveSize * policy.multiplier, policy.maxParallel, remaining)
          : Math.min(policy.initialWave, policy.maxParallel, remaining);
      }
    }

    const failed = results.filter(result => result.status === 'failed');
    this._storeDeploymentRollout(deploymentId, policy, results);
    if (failed.length) {
      const err = new Error(`Deployment failed on ${failed.length} of ${results.length} target hosts`);
      err.targetResults = results;
      err.rolloutPolicy = policy;
      throw err;
    }
    return results;
  }

  async _deployTargetsLegacy(stackId, stack, targets, {
    commit, triggerType, actor, deploymentId, policy,
  }) {
    const results = [];
    for (const target of targets) {
      results.push(await this._deployOneTarget(stackId, stack, target, {
        commit, triggerType, actor,
        policy: { ...policy, healthGate: false }, wave: results.length + 1,
      }));
    }
    this._storeDeploymentRollout(deploymentId, policy, results);
    const failed = results.filter(result => result.status === 'failed');
    if (failed.length) {
      const err = new Error(`Deployment failed on ${failed.length} of ${results.length} target hosts`);
      err.targetResults = results;
      throw err;
    }
    return results;
  }

  async _deployOneTarget(stackId, stack, target, { commit, triggerType, actor, policy, wave }) {
    const baseResult = {
      hostId: target.host_id, hostName: target.host_name, wave,
      previousCommit: target.last_deployed_commit || null, changed: true,
    };
    try {
      await this._composeUp(stackId, stack, target.host_id);
      let health = null;
      if (policy.healthGate) {
        health = await this._waitForTargetHealth(stack, target.host_id, policy.healthTimeoutSeconds);
      }
      gitTargets.updateTargetStatus(stackId, target.host_id, {
        commit, status: 'success', error: null,
      });
      this._auditTargetDeploy(stackId, target, {
        commit, triggerType, status: 'success', actor, wave,
      });
      return { ...baseResult, status: 'success', health };
    } catch (err) {
      const error = this._sanitizeGitError(err.message || String(err));
      gitTargets.updateTargetStatus(stackId, target.host_id, {
        commit, status: 'failed', error,
      });
      this._auditTargetDeploy(stackId, target, {
        commit, triggerType, status: 'failed', error, actor, wave,
      });
      return { ...baseResult, status: 'failed', error };
    }
  }

  async _waitForTargetHealth(stack, hostId, timeoutSeconds) {
    const deadline = Date.now() + timeoutSeconds * 1000;
    let lastReason = 'no containers discovered';
    do {
      const containers = (await dockerService.listContainers(hostId))
        .filter(container => container.stack === stack.stack_name
          || container.labels?.['com.docker.compose.project'] === stack.stack_name);
      if (containers.length) {
        const inspections = await Promise.all(
          containers.map(container => dockerService.inspectContainer(container.id, hostId))
        );
        const unhealthy = inspections.find(container => container.healthcheck?.Status === 'unhealthy');
        if (unhealthy) throw new Error(`Health gate failed: ${unhealthy.name || unhealthy.id} is unhealthy`);
        const terminal = inspections.find(container => ['dead', 'exited'].includes(container.state?.Status));
        if (terminal) throw new Error(`Health gate failed: ${terminal.name || terminal.id} is ${terminal.state.Status}`);
        const pending = inspections.filter(container => container.state?.Status !== 'running'
          || container.healthcheck?.Status === 'starting');
        if (!pending.length) return { status: 'healthy', containers: inspections.length };
        lastReason = `${pending.length} container(s) still starting`;
      }
      if (Date.now() < deadline) await this._sleep(Math.min(1000, deadline - Date.now()));
    } while (Date.now() < deadline);
    throw new Error(`Health gate timed out after ${timeoutSeconds}s: ${lastReason}`);
  }

  async _rollbackRolloutTargets(stackId, stack, newCommit, results, { triggerType, actor }) {
    const repoDir = this._getRepoDir(stackId);
    const git = this._getGit(repoDir, stack);
    const currentRef = (await git.revparse(['HEAD'])).trim();
    const changed = results
      .filter(result => result.changed && ['success', 'failed'].includes(result.status))
      .reverse();
    try {
      for (const result of changed) {
        const target = { host_id: result.hostId, host_name: result.hostName };
        try {
          if (result.previousCommit) {
            await git.checkout(result.previousCommit);
            this._writeEnvOverrides(stackId, stack);
            await this._composeUp(stackId, stack, result.hostId);
            gitTargets.restoreTargetState(stackId, result.hostId, {
              commit: result.previousCommit, previousCommit: newCommit,
              status: 'success', error: null,
            });
          } else {
            await git.checkout(currentRef);
            await this._composeDown(stackId, stack, result.hostId, { removeVolumes: false });
            gitTargets.restoreTargetState(stackId, result.hostId, {
              commit: null, previousCommit: newCommit, status: 'never', error: null,
            });
          }
          result.originalStatus = result.status;
          result.status = 'rolled_back';
          result.rollbackCommit = result.previousCommit;
          this._auditTargetDeploy(stackId, target, {
            commit: result.previousCommit, triggerType: `${triggerType}_auto_rollback`,
            status: 'rolled_back', actor, wave: result.wave,
          });
        } catch (err) {
          const error = this._sanitizeGitError(err.message || String(err));
          result.originalStatus = result.status;
          result.status = 'rollback_failed';
          result.rollbackError = error;
          gitTargets.restoreTargetState(stackId, result.hostId, {
            commit: result.previousCommit, previousCommit: newCommit,
            status: 'failed', error,
          });
        }
      }
    } finally {
      await git.checkout(currentRef);
      this._writeEnvOverrides(stackId, stack);
    }
    return results;
  }

  _auditTargetDeploy(stackId, target, {
    commit, triggerType, status, error = null, actor = null, wave = null,
  }) {
    try {
      require('./audit').log({
        userId: actor?.userId || null,
        username: actor?.username || (actor?.userId ? null : 'system'),
        action: 'git_stack_deploy_target',
        targetType: 'git_stack_target',
        targetId: `${stackId}:${target.host_id}`,
        details: {
          stack_id: stackId, target_host_id: target.host_id,
          target_host_name: target.host_name, commit, trigger: triggerType,
          status, error, wave,
        },
        ip: actor?.ip || null,
      });
    } catch (err) {
      log.warn('Could not write per-target deploy audit entry', {
        stackId, hostId: target.host_id, error: err.message,
      });
    }
  }

  async _composeUp(stackId, stack, hostId = stack.host_id) {
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

    // Build args array for execFileSync (no shell injection)
    const buildArgs = (extra = []) => {
      const args = ['compose'];
      for (const f of composeFiles) args.push('-f', path.join(repoDir, f));
      args.push('-p', stack.stack_name);
      args.push(...extra);
      return args;
    };

    const dockerEnv = this._dockerCliEnvForHost(hostId);
    const opts = {
      cwd: repoDir, timeout: 120000, encoding: 'utf8', stdio: 'pipe', env: dockerEnv.env,
    };

    try {
      if (stack.re_pull_images) {
        this._execFile('docker', buildArgs(['pull']), opts);
      }

      const upArgs = hasEnvOverride
        ? buildArgs(['--env-file', envFile, 'up', '-d', '--remove-orphans'])
        : buildArgs(['up', '-d', '--remove-orphans']);
      this._execFile('docker', upArgs, opts);
    } finally {
      dockerEnv.cleanup();
    }
  }

  async _composeDown(stackId, stack, hostId = stack.host_id, { removeVolumes = false } = {}) {
    const repoDir = this._getRepoDir(stackId);
    const composeFiles = stack.additional_files
      ? (typeof stack.additional_files === 'string'
        ? JSON.parse(stack.additional_files) : stack.additional_files)
      : [stack.compose_path];
    const files = Array.isArray(composeFiles) && composeFiles.length > 0
      ? composeFiles : [stack.compose_path];
    const args = ['compose'];
    for (const file of files) args.push('-f', path.join(repoDir, file));
    args.push('-p', stack.stack_name, 'down');
    if (removeVolumes) args.push('--volumes');

    const dockerEnv = this._dockerCliEnvForHost(hostId);
    try {
      this._execFile('docker', args, {
        cwd: repoDir, timeout: 60000, encoding: 'utf8', stdio: 'pipe', env: dockerEnv.env,
      });
    } finally {
      dockerEnv.cleanup();
    }
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

  _validateRolloutPolicy(input, { allowDisabled = false } = {}) {
    let raw = input;
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw); } catch { throw new Error('Invalid rollout policy JSON'); }
    }
    if (!raw || raw.enabled === false) {
      if (allowDisabled) return { ...DEFAULT_ROLLOUT_POLICY, enabled: false };
      throw new Error('Rollout policy must be enabled');
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Rollout policy must be an object');
    }
    const policy = { ...DEFAULT_ROLLOUT_POLICY, ...raw, enabled: true };
    if (!['fixed', 'exponential'].includes(policy.strategy)) {
      throw new Error('Rollout strategy must be fixed or exponential');
    }
    if (!['pause', 'continue', 'rollback'].includes(policy.onFailure)) {
      throw new Error('Rollout failure action must be pause, continue, or rollback');
    }
    const integer = (key, min, max) => {
      const value = Number(policy[key]);
      if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`Rollout ${key} must be an integer between ${min} and ${max}`);
      }
      policy[key] = value;
    };
    integer('initialWave', 1, 50);
    integer('multiplier', 2, 10);
    integer('maxParallel', 1, 10);
    integer('delaySeconds', 0, 3600);
    integer('healthTimeoutSeconds', 1, 900);
    policy.healthGate = policy.healthGate !== false;
    return policy;
  }

  _parseJson(value, fallback) {
    if (!value) return fallback;
    try { return JSON.parse(value); } catch { return fallback; }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
  }

  _execFile(bin, args, opts = {}) {
    const { execFileSync } = require('child_process');
    return execFileSync(bin, args, { timeout: 120000, encoding: 'utf8', stdio: 'pipe', ...opts });
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

  _resolveRepoFile(repoDir, relativePath, { mustExist = false } = {}) {
    const root = fs.realpathSync(repoDir);
    const candidate = path.resolve(root, relativePath);
    const isInside = target => {
      const rel = path.relative(root, target);
      return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
    };
    if (!isInside(candidate)) {
      throw Object.assign(new Error('File path escapes repository root'), { status: 400 });
    }

    if (mustExist || fs.existsSync(candidate)) {
      const canonical = fs.realpathSync(candidate);
      if (!isInside(canonical)) {
        throw Object.assign(new Error('File path escapes repository root through a symbolic link'), { status: 400 });
      }
      return canonical;
    }

    // For a new file, canonicalize the nearest existing parent so an
    // intermediate directory symlink cannot redirect the write outside.
    let existingParent = path.dirname(candidate);
    while (!fs.existsSync(existingParent) && existingParent !== root) {
      existingParent = path.dirname(existingParent);
    }
    const canonicalParent = fs.realpathSync(existingParent);
    const canonicalTarget = path.resolve(canonicalParent, path.relative(existingParent, candidate));
    if (!isInside(canonicalTarget)) {
      throw Object.assign(new Error('File path escapes repository root through a symbolic link'), { status: 400 });
    }
    return canonicalTarget;
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
// v8.7.10 — exposed for tests pinning the timeout contract.
module.exports._gitTimeouts = {
  fetch: GIT_FETCH_TIMEOUT_MS,
  clone: GIT_CLONE_TIMEOUT_MS,
  remoteProbe: GIT_REMOTE_PROBE_TIMEOUT_MS,
  build: _gitOpts,
};
module.exports.DEFAULT_ROLLOUT_POLICY = DEFAULT_ROLLOUT_POLICY;
