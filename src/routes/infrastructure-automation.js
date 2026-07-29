'use strict';

const { Router } = require('express');
const { writeable } = require('../middleware/auth');
const automation = require('../services/infrastructure-automation');
const auditService = require('../services/audit');
const { getClientIp } = require('../utils/helpers');

const router = Router();
function route(handler) { return async (req, res, next) => { try { await handler(req, res); } catch (error) {
  if (error.name === 'InfrastructureAutomationError') return res.status(error.status || 400)
    .json({ error: error.message, code: error.code, details: error.details }); next(error);
} }; }
function audit(req, action, targetType, targetId, details = {}) {
  auditService.log({ userId: req.user.id, username: req.user.username, action, targetType, targetId: String(targetId),
    details, ip: getClientIp(req) });
}

router.get('/', route((req, res) => res.json(automation.overview(req.user))));
router.post('/manifests/validate', route((req, res) => res.json(automation.validateManifest(req.body?.document || req.body, req.user))));
router.get('/manifests', route((req, res) => res.json({ manifests: automation.manifests(req.user) })));
router.get('/manifests/:id', route((req, res) => res.json({ manifest: automation.manifest(req.params.id, req.user) })));
router.post('/manifests', writeable, route((req, res) => {
  const manifest = automation.saveManifest(req.body || {}, req.user);
  audit(req, 'infrastructure_manifest_save', 'infrastructure_manifest', manifest.id, { kind: manifest.kind, name: manifest.name,
    revision: manifest.revision, documentHash: manifest.documentHash, authoritative: manifest.authoritative, deduplicated: manifest.deduplicated });
  res.status(manifest.deduplicated ? 200 : 201).json({ manifest });
}));
router.get('/plans', route((req, res) => res.json({ plans: automation.plans(req.user) })));
router.post('/manifests/:id/plans', writeable, route((req, res) => {
  const plan = automation.createPlan(req.params.id, req.body || {}, req.user);
  audit(req, 'infrastructure_change_plan_create', 'infrastructure_change_plan', plan.id,
    { manifestId: plan.manifestId, planHash: plan.planHash, summary: plan.summary, expiresAt: plan.expiresAt, deduplicated: plan.deduplicated });
  res.status(plan.deduplicated ? 200 : 201).json({ plan });
}));
router.post('/plans/:id/revalidate', writeable, route((req, res) => {
  const plan = automation.revalidatePlan(req.params.id, req.body || {}, req.user);
  audit(req, 'infrastructure_change_plan_accept', 'infrastructure_change_plan', plan.id,
    { planHash: plan.planHash, manifestId: plan.manifestId, providerMutationsScheduled: plan.providerMutationsScheduled });
  res.json({ plan });
}));
router.get('/workflows', route((req, res) => res.json({ workflows: automation.workflows(req.user) })));
router.post('/workflows', writeable, route((req, res) => {
  const workflow = automation.createWorkflow(req.body || {}, req.user);
  audit(req, 'infrastructure_workflow_create', 'infrastructure_workflow', workflow.id,
    { name: workflow.name, version: workflow.version, definitionHash: workflow.definitionHash, steps: workflow.steps.length });
  res.status(201).json({ workflow });
}));
router.post('/workflows/:id/compensation-plan', writeable, route((req, res) => {
  const plan = automation.compensationPlan(req.params.id, req.body || {}, req.user);
  audit(req, 'infrastructure_compensation_plan', 'infrastructure_workflow', req.params.id,
    { definitionHash: plan.definitionHash, actions: plan.actions.length, manual: plan.manual.length, providerMutationsScheduled: 0 });
  res.json({ plan });
}));
router.post('/plans/:id/jobs', writeable, route((req, res) => {
  const link = automation.linkJob(req.params.id, req.body || {}, req.user);
  audit(req, 'infrastructure_plan_job_link', 'infrastructure_change_plan', req.params.id,
    { operationId: link.operationId, relation: link.relation, hasNativeTask: link.hasNativeTask });
  res.status(201).json({ link });
}));

module.exports = router;
