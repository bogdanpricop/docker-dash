'use strict';

const { Router } = require('express');
const { writeable } = require('../middleware/auth');
const operations = require('../services/infrastructure-operations');
const auditService = require('../services/audit');
const { getClientIp } = require('../utils/helpers');

const router = Router();
function route(handler) { return async (req, res, next) => { try { await handler(req, res); } catch (error) {
  if (error.name === 'InfrastructureOperationsError') return res.status(error.status || 400)
    .json({ error: error.message, code: error.code, details: error.details });
  next(error);
} }; }
function audit(req, action, targetType, targetId, details = {}) {
  auditService.log({ userId: req.user.id, username: req.user.username, action, targetType,
    targetId: String(targetId), details, ip: getClientIp(req) });
}

router.get('/', route((req, res) => res.json(operations.overview(req.user))));
router.post('/schedules', writeable, route((req, res) => {
  const schedule = operations.saveSchedule(req.body || {}, req.user);
  audit(req, 'infrastructure_schedule_create', 'infrastructure_schedule', schedule.id,
    { workflowId: schedule.workflowId, cron: schedule.cron, timezone: schedule.timezone, enabled: schedule.enabled });
  res.status(201).json({ schedule });
}));
router.get('/schedules/:id/evaluate', route((req, res) => res.json(operations.evaluateSchedule(req.params.id, req.query.at || new Date(), req.user))));
router.get('/schedule-runs', route((req, res) => res.json({ runs: operations.scheduleRuns(req.user) })));

router.post('/approvals', writeable, route((req, res) => {
  const approval = operations.createApproval(req.body || {}, req.user);
  audit(req, 'infrastructure_approval_request', 'infrastructure_approval', approval.id,
    { actionKey: approval.actionKey, targetType: approval.targetType, targetId: approval.targetId,
      payloadHash: approval.payloadHash, dueAt: approval.dueAt, applyStarted: false });
  res.status(201).json({ approval });
}));
router.post('/approvals/:id/decision', writeable, route((req, res) => {
  const approval = operations.decideApproval(req.params.id, req.body || {}, req.user);
  audit(req, `infrastructure_approval_${approval.state}`, 'infrastructure_approval', approval.id,
    { payloadHash: approval.payloadHash, applyStarted: false });
  res.json({ approval });
}));

router.post('/dry-runs', writeable, route(async (req, res) => {
  const evidence = await operations.dryRun(req.body || {}, req.user);
  audit(req, 'infrastructure_provider_dry_run', 'infrastructure_dry_run', evidence.id,
    { providerType: evidence.providerType, actionKey: evidence.actionKey, status: evidence.status, providerMutationStarted: false });
  res.status(201).json({ evidence });
}));

router.post('/secret-brokers', writeable, route((req, res) => {
  const profile = operations.saveSecretBroker(req.body || {}, req.user);
  audit(req, 'infrastructure_secret_broker_create', 'infrastructure_secret_broker', profile.id,
    { providerKind: profile.providerKind, secretReference: profile.secretReference, allowedPurposes: profile.allowedPurposes });
  res.status(201).json({ profile });
}));
router.post('/secret-brokers/:id/probe', writeable, route(async (req, res) => {
  const result = await operations.probeSecretBroker(req.params.id, req.body?.purpose, req.user);
  audit(req, 'infrastructure_secret_broker_probe', 'infrastructure_secret_broker', req.params.id,
    { purpose: req.body?.purpose, fingerprint: result.fingerprint, secretReturned: false });
  res.json(result);
}));

router.get('/workflow-templates', route((req, res) => res.json({ templates: operations.workflowTemplates(req.user) })));
router.post('/workflow-templates/:id/instantiate', writeable, route((req, res) => {
  const result = operations.instantiateTemplate(req.params.id, req.body || {}, req.user);
  audit(req, 'infrastructure_workflow_template_instantiate', 'infrastructure_workflow', result.workflow.id,
    { template: result.template, definitionHash: result.workflow.definitionHash, executionStarted: false });
  res.status(201).json(result);
}));

module.exports = router;
