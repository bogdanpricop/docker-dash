'use strict';

const { Router } = require('express');
const { writeable } = require('../middleware/auth');
const factory = require('../services/migration-factory');
const auditService = require('../services/audit');
const { getClientIp } = require('../utils/helpers');

const router = Router();
function route(handler) { return async (req, res, next) => { try { await handler(req, res); } catch (error) { if (error.name === 'MigrationFactoryError') return res.status(error.status || 400).json({ error: error.message, code: error.code, details: error.details }); next(error); } }; }
function audit(req, action, targetId, details = {}) { auditService.log({ userId: req.user.id, username: req.user.username, action,
  targetType: 'migration_factory', targetId: String(targetId), details, ip: getClientIp(req) }); }

router.get('/', route((req, res) => res.json(factory.overview(req.user))));
router.post('/assessments', writeable, route((req, res) => { const assessment = factory.assess(req.body || {}, req.user); audit(req, 'migration_factory_assess', assessment.id, { assessmentHash: assessment.assessmentHash, sourceProvider: assessment.sourceProvider, targetProvider: assessment.targetProvider, state: assessment.state, providerMutationsStarted: 0 }); res.status(assessment.duplicate ? 200 : 201).json({ assessment }); }));
router.post('/assessments/:id/conversions', writeable, route(async (req, res) => { const conversion = await factory.planConversion(req.params.id, req.body || {}, req.user); audit(req, 'migration_conversion_contract_plan', conversion.id, { assessmentId: conversion.assessmentId, requestHash: conversion.requestHash, tool: conversion.tool, outOfProcess: conversion.outOfProcess, diskIoStarted: 0 }); res.status(201).json({ conversion }); }));
router.post('/assessments/:id/network-mappings', writeable, route((req, res) => { const mapping = factory.mapNetworks(req.params.id, req.body || {}, req.user); audit(req, 'migration_network_mapping_plan', mapping.id, { assessmentId: mapping.assessmentId, planHash: mapping.planHash, state: mapping.state, providerMutationsStarted: 0 }); res.status(201).json({ mapping }); }));
router.post('/assessments/:id/storage-mappings', writeable, route((req, res) => { const mapping = factory.mapStorage(req.params.id, req.body || {}, req.user); audit(req, 'migration_storage_mapping_plan', mapping.id, { assessmentId: mapping.assessmentId, planHash: mapping.planHash, state: mapping.state, providerMutationsStarted: 0 }); res.status(201).json({ mapping }); }));
router.post('/assessments/:id/test-clones', writeable, route((req, res) => { const clone = factory.recordTestClone(req.params.id, req.body || {}, req.user); audit(req, 'migration_test_clone_evidence', clone.id, { assessmentId: clone.assessmentId, targetRef: clone.targetRef, isolationMode: clone.isolationMode, state: clone.state, sourceCutoverStarted: 0 }); res.status(201).json({ clone }); }));
router.post('/assessments/:id/wave-plans', writeable, route((req, res) => { const plan = factory.planWaves(req.params.id, req.body || {}, req.user); audit(req, 'migration_wave_plan', plan.id, { assessmentId: plan.assessmentId, planHash: plan.planHash, state: plan.state, waves: plan.waves.length }); res.status(201).json({ plan }); }));
router.post('/assessments/:id/cutover-plans', writeable, route((req, res) => { const plan = factory.planCutover(req.params.id, req.body || {}, req.user); audit(req, 'migration_cutover_plan', plan.id, { assessmentId: plan.assessmentId, planHash: plan.planHash, targetRef: plan.targetRef, state: plan.state, providerMutationsStarted: 0 }); res.status(201).json({ plan }); }));
router.post('/cutover-plans/:id/rollback-plans', writeable, route((req, res) => { const plan = factory.planRollback(req.params.id, req.body || {}, req.user); audit(req, 'migration_rollback_plan', plan.id, { cutoverPlanId: plan.cutoverPlanId, planHash: plan.planHash, state: plan.state, providerMutationsStarted: 0 }); res.status(201).json({ plan }); }));
router.post('/assessments/:id/evidence-reports', writeable, route((req, res) => { const report = factory.createEvidenceReport(req.params.id, req.body || {}, req.user); audit(req, 'migration_evidence_report', report.id, { assessmentId: report.assessmentId, reportHash: report.reportHash, rawArtifactsStored: false }); res.status(201).json({ report }); }));
router.post('/legacy-xen-assessments', writeable, route((req, res) => { const assessment = factory.assessLegacyXen(req.body || {}, req.user); audit(req, 'legacy_xen_migration_assess', assessment.id, { hostRef: assessment.hostRef, toolstack: assessment.toolstack, state: assessment.state, assessmentHash: assessment.assessmentHash, providerMutationsStarted: 0 }); res.status(201).json({ assessment }); }));

module.exports = router;
