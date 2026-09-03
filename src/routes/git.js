'use strict';

const { Router } = require('express');
const gitService = require('../services/git');
const gitDrift = require('../services/git-drift');
const dockerService = require('../services/docker');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const { rateLimit } = require('../middleware/rateLimit');
const hostPermissions = require('../services/host-permissions');

const router = Router();

// Stricter rate limit for git deploy/push operations (5 per minute per IP)
const gitDeployLimiter = rateLimit(5, 60 * 1000);
const ACCESS_RANK = { view: 1, operate: 2, admin: 3 };

function _isAdmin(user) {
  return user?.role === 'admin' || (Array.isArray(user?.roles) && user.roles.includes('admin'));
}

function _hasStackAccess(user, stack, required = 'view') {
  if (_isAdmin(user)) return true;
  const targetIds = stack?.target_host_ids?.length
    ? stack.target_host_ids : [stack?.host_id ?? 0];
  return targetIds.every(hostId => {
    const permission = hostPermissions.resolveEffectivePermission(user?.id, hostId, false);
    return (ACCESS_RANK[permission] || 0) >= ACCESS_RANK[required];
  });
}

function _assertStackAccess(req, stack, required = 'view') {
  if (!_hasStackAccess(req.user, stack, required)) {
    throw Object.assign(new Error(`Insufficient ${required} access on one or more deployment targets`), { status: 403 });
  }
}

// ─── Git Credentials CRUD ──────────────────────────────

router.get('/credentials', requireAuth, requireRole('admin'), (req, res) => {
  res.json(gitService.listCredentials());
});

router.post('/credentials', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const { name, auth_type, username, password, ssh_private_key } = req.body;
    if (!name || !auth_type) return res.status(400).json({ error: 'name and auth_type are required' });
    if (!['token', 'basic', 'ssh_key'].includes(auth_type)) {
      return res.status(400).json({ error: 'auth_type must be token, basic, or ssh_key' });
    }
    if ((auth_type === 'token' || auth_type === 'basic') && !password) {
      return res.status(400).json({ error: 'password/token is required for this auth type' });
    }
    if (auth_type === 'ssh_key' && !ssh_private_key) {
      return res.status(400).json({ error: 'ssh_private_key is required for SSH key auth' });
    }

    const result = gitService.createCredential({
      name: name.trim(), auth_type, username, password, ssh_private_key,
      created_by: req.user.id,
    });

    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'git_credential_create', targetType: 'git_credential',
      targetId: String(result.id), details: JSON.stringify({ name, auth_type }),
      ip: getClientIp(req),
    });

    res.status(201).json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.put('/credentials/:id', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    gitService.updateCredential(parseInt(req.params.id), req.body);
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'git_credential_update', targetType: 'git_credential',
      targetId: req.params.id, ip: getClientIp(req),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.delete('/credentials/:id', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    gitService.deleteCredential(parseInt(req.params.id));
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'git_credential_delete', targetType: 'git_credential',
      targetId: req.params.id, ip: getClientIp(req),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── Git Stacks CRUD ──────────────────────────────────

router.get('/stacks', requireAuth, (req, res) => {
  const hostId = req.query.hostId !== undefined ? parseInt(req.query.hostId) : undefined;
  res.json(gitService.listStacks(hostId).filter(stack => _hasStackAccess(req.user, stack, 'view')));
});

// Drift summary for ALL git stacks (for list-page badges). MUST be registered
// before '/stacks/:id' or Express matches "drift" as the :id param.
router.get('/stacks/drift', requireAuth, (req, res) => {
  try {
    const allowedIds = new Set(gitService.listStacks()
      .filter(stack => _hasStackAccess(req.user, stack, 'view'))
      .map(stack => String(stack.id)));
    const visible = Object.fromEntries(Object.entries(gitDrift.getAllStoredDrift())
      .filter(([stackId]) => allowedIds.has(String(stackId))));
    res.json(visible);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/stacks/:id', requireAuth, (req, res) => {
  const stack = gitService.getStack(parseInt(req.params.id));
  if (!stack) return res.status(404).json({ error: 'Git stack not found' });
  if (!_hasStackAccess(req.user, stack, 'view')) return res.status(403).json({ error: 'Insufficient view access on one or more deployment targets' });
  res.json(stack);
});

router.get('/stacks/:id/file', requireAuth, (req, res) => {
  try {
    const stack = gitService.getStack(parseInt(req.params.id));
    if (!stack) return res.status(404).json({ error: 'Git stack not found' });
    _assertStackAccess(req, stack, 'view');
    res.json(gitService.readComposeFile(parseInt(req.params.id), req.query.path));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/stacks', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const result = gitService.createStack({ ...req.body, created_by: req.user.id });
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'git_stack_create', targetType: 'git_stack',
      targetId: String(result.id),
      details: JSON.stringify({
        stack_name: req.body.stack_name, repo_url: req.body.repo_url,
        branch: req.body.branch, target_host_ids: req.body.target_host_ids,
      }),
      ip: getClientIp(req),
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.put('/stacks/:id', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    gitService.updateStack(parseInt(req.params.id), req.body);
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'git_stack_update', targetType: 'git_stack',
      targetId: req.params.id,
      details: req.body.target_host_ids ? JSON.stringify({ target_host_ids: req.body.target_host_ids }) : null,
      ip: getClientIp(req),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.put('/stacks/:id/rollout', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const stack = gitService.getStack(id);
    if (!stack) return res.status(404).json({ error: 'Git stack not found' });
    _assertStackAccess(req, stack, 'admin');
    gitService.updateStack(id, { rollout_policy: req.body });
    const updated = gitService.getStack(id);
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'git_stack_rollout_policy_update', targetType: 'git_stack',
      targetId: req.params.id,
      details: JSON.stringify({ rollout_policy: updated.rollout_policy }),
      ip: getClientIp(req),
    });
    res.json({ ok: true, rollout_policy: updated.rollout_policy });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.delete('/stacks/:id', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  try {
    const stack = gitService.getStack(parseInt(req.params.id));
    await gitService.deleteStack(parseInt(req.params.id), {
      removeContainers: req.query.removeContainers === 'true',
      removeVolumes: req.query.removeVolumes === 'true',
    });
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'git_stack_delete', targetType: 'git_stack',
      targetId: req.params.id,
      details: JSON.stringify({ stack_name: stack?.stack_name }),
      ip: getClientIp(req),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── Deploy & Check ──────────────────────────────────

router.post('/stacks/:id/deploy', requireAuth, requireRole('admin', 'operator'), writeable, gitDeployLimiter, async (req, res) => {
  try {
    const stackId = parseInt(req.params.id);
    const stack = gitService.getStack(stackId);
    if (!stack) return res.status(404).json({ error: 'Git stack not found' });
    _assertStackAccess(req, stack, 'operate');
    const deploymentId = await gitService.deployStack(stackId, {
      force: req.body?.force,
      actor: { userId: req.user.id, username: req.user.username, ip: getClientIp(req) },
    });
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'git_stack_deploy', targetType: 'git_stack',
      targetId: req.params.id,
      details: JSON.stringify({ trigger: 'manual' }),
      ip: getClientIp(req),
    });
    res.json({
      ok: true, message: 'Deployment started', stack_id: parseInt(req.params.id),
      deployment_id: deploymentId,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/stacks/:id/check', requireAuth, async (req, res) => {
  try {
    const stackId = parseInt(req.params.id);
    const stack = gitService.getStack(stackId);
    if (!stack) return res.status(404).json({ error: 'Git stack not found' });
    _assertStackAccess(req, stack, 'view');
    const result = await gitService.checkForUpdates(stackId);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── GitOps Drift Detection (read-only, v8.3.0) ──────────────
// "Does the RUNNING state match the git-checked-out compose?" — complementary
// to /check (which is git-ahead detection). Detection only; never acts.

// Latest stored drift result for one stack
router.get('/stacks/:id/drift', requireAuth, (req, res) => {
  try {
    const stack = gitService.getStack(parseInt(req.params.id));
    if (!stack) return res.status(404).json({ error: 'Git stack not found' });
    _assertStackAccess(req, stack, 'view');
    res.json(gitDrift.getStoredDrift(parseInt(req.params.id)));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal server error' });
  }
});

// Run a fresh scan now (read-only, but triggers work → operator+)
router.post('/stacks/:id/drift-scan', requireAuth, requireRole('admin', 'operator'), async (req, res) => {
  try {
    const stack = gitService.getStack(parseInt(req.params.id));
    if (!stack) return res.status(404).json({ error: 'Git stack not found' });
    _assertStackAccess(req, stack, 'operate');
    const result = await gitDrift.scanAndStore(stack, dockerService);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── Deployment History ──────────────────────────────

router.get('/stacks/:id/deployments', requireAuth, (req, res) => {
  try {
    // v8.7.33 — cap user-supplied limit at 200 (deployments are richer rows
    // than typical paginated lists; lower cap matches the practical UI use).
    const stack = gitService.getStack(parseInt(req.params.id));
    if (!stack) return res.status(404).json({ error: 'Git stack not found' });
    _assertStackAccess(req, stack, 'view');
    const { page, limit, status, trigger_type } = req.query;
    const safeLimit = Math.min(Math.max(parseInt(limit) || 20, 1), 200);
    const result = gitService.listDeployments(parseInt(req.params.id), {
      page: parseInt(page) || 1, limit: safeLimit, status, trigger_type,
    });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── Webhook & Auto-Deploy Config ────────────────────

router.post('/stacks/:id/webhook/regenerate', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const stack = gitService.getStack(id);
    if (!stack) return res.status(404).json({ error: 'Git stack not found' });

    const { token, secret } = gitService.generateWebhookConfig(id);
    const baseUrl = req.headers['x-forwarded-proto']
      ? `${req.headers['x-forwarded-proto']}://${req.headers.host}`
      : `${req.protocol}://${req.headers.host}`;
    const webhookUrl = `${baseUrl}/api/git/webhook/${token}`;

    res.json({ webhookToken: token, webhookSecret: secret, webhookUrl });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/stacks/:id/webhook-url', requireAuth, (req, res) => {
  const stack = gitService.getStack(parseInt(req.params.id));
  if (!stack) return res.status(404).json({ error: 'Git stack not found' });
  if (!stack.webhook_token) return res.json({ configured: false });

  const baseUrl = req.headers['x-forwarded-proto']
    ? `${req.headers['x-forwarded-proto']}://${req.headers.host}`
    : `${req.protocol}://${req.headers.host}`;
  res.json({
    configured: true,
    webhookUrl: `${baseUrl}/api/git/webhook/${stack.webhook_token}`,
    webhookSecret: stack.webhook_secret,
    provider: stack.webhook_provider,
  });
});

router.put('/stacks/:id/auto-deploy', requireAuth, requireRole('admin'), writeable, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const stack = gitService.getStack(id);
    if (!stack) return res.status(404).json({ error: 'Git stack not found' });
    gitService.updateAutoDeployConfig(id, req.body);

    // v8.7.23 — apply the change immediately. Before this, the DB row was
    // updated but gitPolling._intervals was untouched, so toggling
    // polling_enabled or changing the interval only took effect after a
    // server restart. Worse in HA: if the API call landed on a reader,
    // the leader (which owns the intervals) never heard about it.
    // reconcileStack() leader-gates locally (no-op on readers), and
    // cluster.publish() fans out to the actual leader.
    try {
      const gitPolling = require('../services/gitPolling');
      await gitPolling.reconcileStack(id);
    } catch (e) {
      require('../utils/logger')('git-route').warn('reconcileStack failed (DB updated successfully)', { stackId: id, error: e.message });
    }
    try {
      const cluster = require('../services/cluster');
      await cluster.publish('git-polling:reconcile', { stackId: id });
    } catch { /* best-effort HA fanout */ }

    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── Diff & Rollback ─────────────────────────────────

router.get('/stacks/:id/diff', requireAuth, async (req, res) => {
  try {
    const stackId = parseInt(req.params.id);
    const stack = gitService.getStack(stackId);
    if (!stack) return res.status(404).json({ error: 'Git stack not found' });
    _assertStackAccess(req, stack, 'view');
    const result = await gitService.getRepoDiff(stackId);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/stacks/:id/rollback/:deploymentId', requireAuth, requireRole('admin', 'operator'), writeable, async (req, res) => {
  try {
    const stack = gitService.getStack(parseInt(req.params.id));
    if (!stack) return res.status(404).json({ error: 'Git stack not found' });
    _assertStackAccess(req, stack, 'operate');
    await gitService.rollbackStack(
      parseInt(req.params.id), parseInt(req.params.deploymentId),
      { userId: req.user.id, username: req.user.username, ip: getClientIp(req) }
    );
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'git_stack_rollback', targetType: 'git_stack',
      targetId: req.params.id, details: JSON.stringify({ deploymentId: req.params.deploymentId }),
      ip: getClientIp(req),
    });
    res.json({ ok: true, message: 'Rollback completed' });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── Push to Git ──────────────────────────────────────

router.get('/stacks/:id/remote-status', requireAuth, async (req, res) => {
  try {
    const result = await gitService.getRemoteStatus(parseInt(req.params.id));
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/stacks/:id/push', requireAuth, requireRole('admin'), writeable, gitDeployLimiter, async (req, res) => {
  try {
    const { commitMessage, files, forcePush } = req.body;
    if (!files || Object.keys(files).length === 0) {
      return res.status(400).json({ error: 'No files to push' });
    }
    const author = `${req.user.username} <${req.user.username}@docker-dash.local>`;
    const result = await gitService.pushToGit(parseInt(req.params.id), {
      commitMessage, files, author, forcePush,
    });
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'git_stack_push', targetType: 'git_stack',
      targetId: req.params.id, details: JSON.stringify({ commitHash: result.commitHash }),
      ip: getClientIp(req),
    });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── Env Var Management ──────────────────────────────

router.get('/stacks/:id/env', requireAuth, (req, res) => {
  try {
    res.json(gitService.getEnvOverrides(parseInt(req.params.id)));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.put('/stacks/:id/env', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    gitService.updateEnvOverrides(parseInt(req.params.id), req.body.variables || []);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/stacks/:id/env/import', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const { content, sensitiveKeys } = req.body;
    if (!content) return res.status(400).json({ error: 'content is required' });
    const variables = gitService.importEnvFile(parseInt(req.params.id), content, sensitiveKeys || []);
    res.json({ variables });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── Test Connection ──────────────────────────────────

router.post('/test-connection', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const result = await gitService.testConnection(req.body);
    res.json(result);
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

module.exports = router;
