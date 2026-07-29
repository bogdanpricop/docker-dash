'use strict';

const { Router } = require('express');
const { writeable } = require('../middleware/auth');
const automation = require('../services/infrastructure-automation');
const delivery = require('../services/infrastructure-delivery');
const operations = require('../services/infrastructure-operations');
const auditService = require('../services/audit');
const { getClientIp } = require('../utils/helpers');

const router = Router();
function route(handler) { return async (req, res, next) => { try { await handler(req, res); } catch (error) {
  if (['InfrastructureAutomationError', 'InfrastructureDeliveryError', 'InfrastructureOperationsError'].includes(error.name)) return res.status(error.status || 400)
    .json({ error: error.message, code: error.code, details: error.details }); next(error);
} }; }
function audit(req, action, targetType, targetId, details = {}) {
  auditService.log({ userId: req.user.id, username: req.user.username, action, targetType, targetId: String(targetId),
    details, ip: getClientIp(req) });
}

router.get('/', route((req, res) => res.json({ ...automation.overview(req.user), delivery: delivery.overview(req.user),
  operations: operations.overview(req.user) })));
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

router.post('/resource-manifests/validate', route((req, res) => {
  const document = delivery.normalizeResourceManifest(req.body?.document || req.body, req.user);
  res.json({ valid: true, normalized: document, secretFree: true });
}));
router.get('/resource-manifests', route((req, res) => res.json({ manifests: delivery.resourceManifests(req.user) })));
router.post('/resource-manifests', writeable, route((req, res) => {
  const manifest = delivery.saveResourceManifest(req.body || {}, req.user);
  audit(req, 'infrastructure_resource_manifest_save', 'infrastructure_resource_manifest', manifest.id,
    { kind: manifest.kind, name: manifest.name, owner: manifest.owner, ownershipMode: manifest.ownershipMode,
      deletionProtection: manifest.deletionProtection, revision: manifest.revision, documentHash: manifest.documentHash });
  res.status(manifest.deduplicated ? 200 : 201).json({ manifest });
}));
router.post('/import', route((req, res) => {
  const result = delivery.importLiveResource(req.body || {}, req.user);
  audit(req, 'infrastructure_manifest_import_preview', 'infrastructure_manifest', result.document.metadata.name,
    { kind: result.document.kind, documentHash: result.documentHash, persisted: false });
  res.json(result);
}));
router.post('/drift', route((req, res) => {
  const result = delivery.drift(req.body || {}, req.user);
  audit(req, 'infrastructure_drift_evaluate', 'infrastructure_manifest', `${result.manifest.source}:${result.manifest.id}`,
    { planHash: result.planHash, summary: result.summary, providerMutationsScheduled: 0 });
  res.json(result);
}));
router.get('/reconcile-runs', route((req, res) => res.json({ runs: delivery.reconcileRuns(req.user) })));
router.post('/reconcile-runs', writeable, route((req, res) => {
  const run = delivery.createManualReconcile(req.body || {}, req.user);
  audit(req, 'infrastructure_reconcile_plan', 'infrastructure_reconcile_run', run.id,
    { planHash: run.planHash, summary: run.summary, commitSha: run.commitSha, status: run.status });
  res.status(201).json({ run });
}));
router.post('/reconcile-runs/:id/approve', writeable, route((req, res) => {
  const run = delivery.approveReconcile(req.params.id, req.body || {}, req.user);
  audit(req, 'infrastructure_reconcile_approve', 'infrastructure_reconcile_run', run.id, { planHash: run.planHash });
  res.json({ run });
}));
router.post('/reconcile-runs/:id/apply', writeable, route((req, res) => {
  const run = delivery.applyReconcile(req.params.id, req.body || {}, req.user);
  audit(req, 'infrastructure_reconcile_apply_evidence', 'infrastructure_reconcile_run', run.id,
    { planHash: run.planHash, status: run.status, operationIds: (run.evidence.operations || []).map(item => item.operationId),
      externalExecutionStarted: false });
  res.json({ run });
}));
router.get('/controllers', route((req, res) => res.json({ controllers: delivery.controllers(req.user) })));
router.post('/controllers', writeable, route((req, res) => {
  const controller = delivery.configureController(req.body || {}, req.user);
  audit(req, 'infrastructure_controller_create', 'infrastructure_controller', controller.id,
    { name: controller.name, mode: controller.mode, scopeType: controller.scopeType, scopeKey: controller.scopeKey,
      enabled: controller.enabled, conflictPolicy: controller.conflictPolicy });
  res.status(201).json({ controller });
}));
router.post('/controllers/:id/observation', writeable, route((req, res) => {
  const result = delivery.updateControllerObservation(req.params.id, req.body || {}, req.user);
  audit(req, 'infrastructure_controller_observe', 'infrastructure_controller', req.params.id,
    { state: result.controller.state, planHash: result.run?.planHash, providerMutationsScheduled: 0 });
  res.json(result);
}));
router.post('/controllers/:id/resume', writeable, route((req, res) => {
  const controller = delivery.resumeController(req.params.id, req.user);
  audit(req, 'infrastructure_controller_resume', 'infrastructure_controller', controller.id, { state: controller.state });
  res.json({ controller });
}));
router.post('/controllers/:id/run', writeable, route((req, res) => {
  const result = delivery.runController(req.params.id, req.user);
  audit(req, 'infrastructure_controller_run', 'infrastructure_controller', req.params.id,
    { state: result.controller.state, planHash: result.run?.planHash, providerMutationsScheduled: 0 });
  res.json(result);
}));
router.post('/previews/pull-request', writeable, route((req, res) => {
  const preview = delivery.previewPullRequest(req.body || {}, req.user);
  audit(req, 'infrastructure_pull_request_preview', 'infrastructure_external_plan', preview.id,
    { externalRef: preview.externalRef, artifactHash: preview.artifactHash, status: preview.status,
      policyPassed: preview.policy.passed, blastRadius: preview.blastRadius });
  res.status(preview.deduplicated ? 200 : 201).json({ preview });
}));
router.post('/terraform/import-mappings', route((req, res) => res.json(delivery.terraformImportMappings(req.body || {}, req.user))));
router.post('/terraform/plans', writeable, route((req, res) => {
  const plan = delivery.ingestTerraformPlan(req.body || {}, req.user);
  audit(req, 'infrastructure_terraform_plan_ingest', 'infrastructure_external_plan', plan.id,
    { externalRef: plan.externalRef, artifactHash: plan.artifactHash, status: plan.status, summary: plan.plan.summary,
      sensitiveValuesStored: false });
  res.status(plan.deduplicated ? 200 : 201).json({ plan });
}));
router.post('/external-plans/:id/authorize', writeable, route((req, res) => {
  const plan = delivery.authorizeExternalPlan(req.params.id, req.body || {}, req.user);
  audit(req, 'infrastructure_external_plan_authorize', 'infrastructure_external_plan', plan.id,
    { sourceKind: plan.sourceKind, artifactHash: plan.artifactHash, externalExecutionStarted: false });
  res.json({ plan });
}));
router.get('/ansible-inventory', route((req, res) => {
  const result = delivery.ansibleInventory(req.user);
  if (req.query.download === 'yaml') { res.setHeader('Content-Type', 'application/yaml; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="docker-dash-inventory.yaml"'); return res.send(result.yaml); }
  res.json(result);
}));
router.get('/webhook-triggers', route((req, res) => res.json({ triggers: delivery.webhookTriggers(req.user) })));
router.post('/webhook-triggers', writeable, route((req, res) => {
  const result = delivery.createWebhookTrigger(req.body || {}, req.user);
  audit(req, 'infrastructure_webhook_trigger_create', 'infrastructure_webhook_trigger', result.trigger.id,
    { name: result.trigger.name, procedureId: result.trigger.procedureId, events: result.trigger.events, shownOnce: true });
  res.status(201).json(result);
}));

// V0.3d / B246-B250 — calendar-aware triggers, approval escalation,
// provider dry-run evidence, JIT secret brokering and curated templates.
router.use('/operations', require('./infrastructure-operations'));

module.exports = router;
