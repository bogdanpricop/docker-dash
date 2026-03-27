'use strict';

const { Router } = require('express');
const gitService = require('../services/git');
const auditService = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');

const router = Router();

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
  res.json(gitService.listStacks(hostId));
});

router.get('/stacks/:id', requireAuth, (req, res) => {
  const stack = gitService.getStack(parseInt(req.params.id));
  if (!stack) return res.status(404).json({ error: 'Git stack not found' });
  res.json(stack);
});

router.post('/stacks', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const result = gitService.createStack({ ...req.body, created_by: req.user.id });
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'git_stack_create', targetType: 'git_stack',
      targetId: String(result.id),
      details: JSON.stringify({ stack_name: req.body.stack_name, repo_url: req.body.repo_url, branch: req.body.branch }),
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
      targetId: req.params.id, ip: getClientIp(req),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
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

router.post('/stacks/:id/deploy', requireAuth, requireRole('admin', 'operator'), writeable, async (req, res) => {
  try {
    await gitService.deployStack(parseInt(req.params.id), { force: req.body?.force });
    auditService.log({
      userId: req.user.id, username: req.user.username,
      action: 'git_stack_deploy', targetType: 'git_stack',
      targetId: req.params.id,
      details: JSON.stringify({ trigger: 'manual' }),
      ip: getClientIp(req),
    });
    res.json({ ok: true, message: 'Deployment started', stack_id: parseInt(req.params.id) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/stacks/:id/check', requireAuth, async (req, res) => {
  try {
    const result = await gitService.checkForUpdates(parseInt(req.params.id));
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── Deployment History ──────────────────────────────

router.get('/stacks/:id/deployments', requireAuth, (req, res) => {
  try {
    const { page, limit, status, trigger_type } = req.query;
    const result = gitService.listDeployments(parseInt(req.params.id), {
      page: parseInt(page) || 1, limit: parseInt(limit) || 20, status, trigger_type,
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

router.put('/stacks/:id/auto-deploy', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const stack = gitService.getStack(id);
    if (!stack) return res.status(404).json({ error: 'Git stack not found' });
    gitService.updateAutoDeployConfig(id, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── Diff & Rollback ─────────────────────────────────

router.get('/stacks/:id/diff', requireAuth, async (req, res) => {
  try {
    const result = await gitService.getRepoDiff(parseInt(req.params.id));
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/stacks/:id/rollback/:deploymentId', requireAuth, requireRole('admin', 'operator'), writeable, async (req, res) => {
  try {
    await gitService.rollbackStack(parseInt(req.params.id), parseInt(req.params.deploymentId));
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
