'use strict';

const { Router } = require('express');
const sync = require('../services/gitops-sync');
const writeback = require('../services/gitops-writeback');
const audit = require('../services/audit');
const { requireAuth, requireRole, writeable } = require('../middleware/auth');
const { getClientIp } = require('../utils/helpers');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();

function record(req, action, details) {
  audit.log({
    userId: req.user.id, username: req.user.username,
    action, targetType: 'gitops_fleet', targetId: 'fleet',
    details, ip: getClientIp(req),
  });
}

router.get('/export', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const document = sync.capture();
    const yaml = sync.exportYaml();
    const stateHash = sync.stateHash();
    record(req, 'gitops_export', {
      state_hash: stateHash,
      hosts: document.spec.hosts.length,
      groups: document.spec.hostGroups.length,
      stacks: document.spec.gitStacks.length,
      procedures: document.spec.procedures.length,
    });
    if (req.query.download === 'yaml') {
      res.setHeader('Content-Type', 'application/yaml; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="docker-dash-fleet.yaml"');
      return res.send(yaml);
    }
    res.json({ document, yaml, stateHash });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.post('/plan', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  try {
    const plan = sync.plan(req.body?.document);
    record(req, 'gitops_plan', {
      plan_hash: plan.planHash, state_hash: plan.stateHash, summary: plan.summary,
      authoritative: plan.authoritative,
    });
    res.json(plan);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
}));

router.post('/apply', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  try {
    const result = await sync.apply(req.body?.document, {
      planHash: req.body?.planHash,
      allowDelete: req.body?.allowDelete === true,
      userId: req.user.id,
    });
    const managedWriteback = await writeback.autoWriteback({
      userId: req.user.id, username: req.user.username,
    });
    record(req, 'gitops_apply', {
      plan_hash: result.planHash,
      state_hash_before: result.stateHashBefore,
      state_hash_after: result.stateHashAfter,
      summary: result.summary,
      managed_writeback: managedWriteback.results.map(item => ({
        id: item.id, ok: item.ok, changed: item.changed, commitHash: item.commitHash, error: item.error,
      })),
    });
    res.json({ ...result, managedWriteback });
  } catch (err) {
    res.status(err.status || 400).json({
      error: err.message, code: err.code,
      currentPlanHash: err.currentPlanHash, blocked: err.blocked,
    });
  }
}));

router.get('/managed', requireAuth, requireRole('admin'), (_req, res) => {
  res.json(writeback.list());
});

router.put('/managed', requireAuth, requireRole('admin'), writeable, (req, res) => {
  try {
    const managed = writeback.configure(req.body || {}, req.user.id);
    record(req, 'gitops_managed_config_update', {
      id: managed.id, git_stack_id: managed.git_stack_id, file_path: managed.file_path,
      enabled: managed.enabled, auto_writeback: managed.auto_writeback,
    });
    res.json(managed);
  } catch (err) { res.status(err.status || 400).json({ error: err.message, code: err.code }); }
});

router.post('/managed/:id/plan', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  try {
    const plan = await writeback.plan(req.params.id);
    record(req, 'gitops_managed_plan', {
      id: plan.managedId, git_stack_id: plan.gitStackId,
      plan_hash: plan.planHash, changed: plan.changed,
    });
    res.json(plan);
  } catch (err) { res.status(err.status || 400).json({ error: err.message, code: err.code }); }
}));

router.post('/managed/:id/apply', requireAuth, requireRole('admin'), writeable, asyncHandler(async (req, res) => {
  try {
    const result = await writeback.apply(req.params.id, {
      planHash: req.body?.planHash, commitMessage: req.body?.commitMessage,
      actor: { author: `${req.user.username} <${req.user.username}@docker-dash.local>` },
    });
    record(req, 'gitops_managed_writeback', {
      id: Number(req.params.id), changed: result.changed,
      commit_hash: result.commitHash, document_hash: result.documentHash,
    });
    res.json(result);
  } catch (err) { res.status(err.status || 400).json({ error: err.message, code: err.code }); }
}));

module.exports = router;
