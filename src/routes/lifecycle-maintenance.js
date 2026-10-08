'use strict';

const { Router } = require('express');
const { writeable } = require('../middleware/auth');
const lifecycle = require('../services/lifecycle-maintenance');
const auditService = require('../services/audit');
const { getClientIp } = require('../utils/helpers');

const router = Router();
function route(handler) { return async (req, res, next) => { try { await handler(req, res); } catch (error) {
  if (error.name === 'LifecycleMaintenanceError') return res.status(error.status || 400)
    .json({ error: error.message, code: error.code, details: error.details });
  next(error);
} }; }
function audit(req, action, targetType, targetId, details = {}) {
  auditService.log({ userId: req.user.id, username: req.user.username, action, targetType,
    targetId: String(targetId), details, ip: getClientIp(req) });
}

router.get('/', route((req, res) => res.json(lifecycle.overview(req.user))));
router.post('/plans', writeable, route((req, res) => {
  const result = lifecycle.createMaintenancePlan(req.body || {}, req.user);
  audit(req, 'lifecycle_maintenance_plan_create', 'lifecycle_maintenance_plan', result.plan.id,
    { planHash: result.plan.planHash, waves: result.waves.length, conflicts: result.plan.conflicts.length,
      providerMutationsStarted: result.providerMutationsStarted });
  res.status(201).json(result);
}));
router.post('/plans/:id/approve', writeable, route((req, res) => {
  const plan = lifecycle.approveMaintenance(req.params.id, req.body || {}, req.user);
  audit(req, 'lifecycle_maintenance_plan_approve', 'lifecycle_maintenance_plan', plan.id,
    { planHash: plan.planHash, providerMutationsStarted: plan.providerMutationsStarted });
  res.json({ plan });
}));
router.post('/campaigns', writeable, route((req, res) => {
  const campaign = lifecycle.createCampaign(req.body || {}, req.user);
  audit(req, 'lifecycle_campaign_create', 'lifecycle_campaign', campaign.id,
    { kind: campaign.kind, planHash: campaign.planHash, targets: campaign.targets.length,
      providerOperationsCreated: campaign.providerOperationsCreated });
  res.status(201).json({ campaign });
}));
router.post('/campaigns/:id/approve', writeable, route((req, res) => {
  const campaign = lifecycle.approveCampaign(req.params.id, req.body || {}, req.user);
  audit(req, 'lifecycle_campaign_approve', 'lifecycle_campaign', campaign.id,
    { kind: campaign.kind, planHash: campaign.planHash, providerOperationsCreated: campaign.providerOperationsCreated });
  res.json({ campaign });
}));
router.post('/campaigns/:id/advance', writeable, route((req, res) => {
  const campaign = lifecycle.advanceCampaign(req.params.id, req.body || {}, req.user);
  audit(req, 'lifecycle_campaign_advance', 'lifecycle_campaign', campaign.id,
    { state: campaign.state, currentStage: campaign.currentStage, targetId: req.body?.targetId,
      operationId: req.body?.operationId });
  res.json({ campaign });
}));
router.post('/live-patch', writeable, route(async (req, res) => {
  const evidence = await lifecycle.livePatch(req.body || {}, req.user);
  audit(req, 'lifecycle_live_patch_evidence', 'lifecycle_live_patch', evidence.id,
    { providerType: evidence.providerType, targetRef: evidence.targetRef, patchId: evidence.patchId,
      phase: evidence.phase, operationId: evidence.operationId, implicitRebootScheduled: evidence.implicitRebootScheduled });
  res.status(201).json({ evidence });
}));
router.post('/reboot-signals', writeable, route((req, res) => {
  const status = lifecycle.recordRebootSignal(req.body || {}, req.user);
  audit(req, 'lifecycle_reboot_signal_record', 'provider_resource', status.targetRef,
    { providerHostId: status.providerHostId, requiredState: status.requiredState, rebootScheduled: status.rebootScheduled });
  res.status(201).json({ status });
}));
router.get('/reboot-status/:hostId/:targetRef', route((req, res) =>
  res.json({ status: lifecycle.rebootStatus(req.params.hostId, req.params.targetRef, req.user) })));
router.put('/firmware', writeable, route((req, res) => {
  const firmware = lifecycle.saveFirmware(req.body || {}, req.user);
  audit(req, 'lifecycle_firmware_catalog_update', 'lifecycle_firmware', firmware.id,
    { vendor: firmware.vendor, deviceModel: firmware.deviceModel, componentType: firmware.componentType,
      firmwareVersion: firmware.firmwareVersion, sourceDigest: firmware.sourceDigest });
  res.json({ firmware });
}));
router.put('/drivers', writeable, route((req, res) => {
  const driver = lifecycle.saveDriverCompatibility(req.body || {}, req.user);
  audit(req, 'lifecycle_driver_compatibility_update', 'lifecycle_driver_compatibility', driver.id,
    { vendor: driver.vendor, deviceModel: driver.deviceModel, driverName: driver.driverName,
      status: driver.status, sourceDigest: driver.sourceDigest });
  res.json({ driver });
}));
router.post('/drivers/check', writeable, route((req, res) => res.json(lifecycle.checkDriver(req.body || {}, req.user))));
router.put('/certificates/ownership', writeable, route((req, res) => {
  const certificate = lifecycle.saveCertificateOwnership(req.body || {}, req.user);
  audit(req, 'lifecycle_certificate_ownership_update', 'lifecycle_certificate_ownership', certificate.id,
    { inventoryKey: certificate.inventoryKey, resourceType: certificate.resourceType, resourceRef: certificate.resourceRef,
      owner: certificate.owner, maintenancePlanId: certificate.maintenancePlanId });
  res.json({ certificate });
}));
router.post('/certificates/reminder-policies', writeable, route((req, res) => {
  const policy = lifecycle.saveReminderPolicy(req.body || {}, req.user);
  audit(req, 'lifecycle_certificate_reminder_policy_create', 'lifecycle_certificate_reminder_policy', policy.id,
    { thresholds: policy.thresholdDays, environment: policy.environment,
      requireMaintenanceWindow: policy.requireMaintenanceWindow });
  res.status(201).json({ policy });
}));
router.post('/certificates/reminders/evaluate', writeable, route((req, res) => {
  const result = lifecycle.evaluateCertificateReminders(req.user);
  audit(req, 'lifecycle_certificate_reminders_evaluate', 'lifecycle_certificate_reminders', 'all',
    { created: result.created, renewalsStarted: result.renewalsStarted });
  res.json(result);
}));

module.exports = router;
