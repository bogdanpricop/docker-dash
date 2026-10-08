'use strict';

const { Router } = require('express');
const { writeable } = require('../middleware/auth');
const optimization = require('../services/finops-optimization');
const auditService = require('../services/audit');
const { getClientIp } = require('../utils/helpers');

const router = Router();
function route(handler) { return async (req, res, next) => { try { await handler(req, res); } catch (error) {
  if (error.name === 'FinOpsOptimizationError') return res.status(error.status || 400)
    .json({ error: error.message, code: error.code, details: error.details });
  next(error);
} }; }
function audit(req, action, targetType, targetId, details = {}) {
  auditService.log({ userId: req.user.id, username: req.user.username, action, targetType,
    targetId: String(targetId), details, ip: getClientIp(req) });
}

router.get('/', route((req, res) => res.json(optimization.overview(req.user))));
router.post('/budget-alert-policies', writeable, route((req, res) => {
  const policy = optimization.saveBudgetAlertPolicy(req.body || {}, req.user);
  audit(req, 'finops_budget_alert_policy_save', 'finops_budget_alert_policy', policy.id,
    { budgetId: policy.budgetId, thresholds: policy.thresholds, channels: policy.channels, policyHash: policy.policyHash });
  res.json({ policy });
}));
router.post('/budget-alerts/evaluate/:runId', writeable, route((req, res) => {
  const result = optimization.evaluateBudgetAlerts(req.params.runId, req.user);
  audit(req, 'finops_budget_alerts_evaluate', 'finops_rating_run', req.params.runId,
    { created: result.created, notificationsQueued: result.notificationsQueued, providerMutationsStarted: 0 });
  res.json(result);
}));
router.post('/anomaly-policies', writeable, route((req, res) => {
  const policy = optimization.saveAnomalyPolicy(req.body || {}, req.user);
  audit(req, 'finops_anomaly_policy_save', 'finops_anomaly_policy', policy.id,
    { scopeType: policy.scopeType, scopeValue: policy.scopeValue, baselineRuns: policy.baselineRuns, policyHash: policy.policyHash });
  res.json({ policy });
}));
router.post('/anomalies/evaluate/:runId', writeable, route((req, res) => {
  const result = optimization.evaluateCostAnomalies(req.params.runId, req.user);
  audit(req, 'finops_anomalies_evaluate', 'finops_rating_run', req.params.runId,
    { created: result.created, evaluations: result.evaluations.length, providerMutationsStarted: 0 });
  res.json(result);
}));
router.post('/assessments/idle/:ledgerId', writeable, route((req, res) => {
  const assessment = optimization.assessIdleVm(req.params.ledgerId, req.body || {}, req.user);
  audit(req, 'finops_idle_vm_assess', 'finops_ledger', req.params.ledgerId,
    { state: assessment.state, confidence: assessment.confidence, owner: assessment.owner, providerMutationsStarted: 0 });
  res.json({ assessment });
}));
router.post('/assessments/oversized/:ledgerId', writeable, route((req, res) => {
  const assessment = optimization.assessOversizedVm(req.params.ledgerId, req.body || {}, req.user);
  audit(req, 'finops_oversized_vm_assess', 'finops_ledger', req.params.ledgerId,
    { state: assessment.state, confidence: assessment.confidence, providerMutationsStarted: 0 });
  res.json({ assessment });
}));
router.post('/assessments/zombie', writeable, route((req, res) => {
  const assessment = optimization.assessZombieResource(req.body || {}, req.user);
  audit(req, 'finops_zombie_resource_assess', assessment.resourceType, assessment.resourceRef,
    { state: assessment.state, owner: assessment.owner, providerMutationsStarted: 0 });
  res.json({ assessment });
}));
router.post('/savings-schedules', writeable, route((req, res) => {
  const schedule = optimization.saveSavingsSchedule(req.body || {}, req.user);
  audit(req, 'finops_savings_schedule_save', 'finops_savings_schedule', schedule.id,
    { resourceRef: schedule.resourceRef, mode: schedule.mode, timezone: schedule.timezone, scheduleHash: schedule.scheduleHash });
  res.json({ schedule });
}));
router.post('/savings-schedules/:id/execute', writeable, route(async (req, res) => {
  const execution = await optimization.executeSavingsSchedule(req.params.id, req.body || {}, req.user);
  audit(req, 'finops_savings_schedule_execute', 'finops_savings_schedule', req.params.id,
    { executionId: execution.id, action: execution.action, state: execution.state,
      operationId: execution.operationId, approvalId: execution.approvalId, providerMutationStarted: execution.providerMutationStarted });
  res.json({ execution });
}));
router.post('/reserved-capacity', writeable, route((req, res) => {
  const recommendation = optimization.recommendReservedCapacity(req.body || {}, req.user);
  audit(req, 'finops_reserved_capacity_recommend', 'finops_capacity', recommendation.scopeRef,
    { state: recommendation.state, selected: recommendation.selected?.name || null, purchaseStarted: false });
  res.status(201).json({ recommendation });
}));
router.post('/consolidation-scenarios', writeable, route((req, res) => {
  const scenario = optimization.simulateConsolidation(req.body || {}, req.user);
  audit(req, 'finops_consolidation_simulate', 'finops_consolidation', scenario.id,
    { removedHostRef: scenario.removedHostRef, state: scenario.state, providerMutationsStarted: 0 });
  res.status(201).json({ scenario });
}));
router.post('/capacity-forecasts', writeable, route((req, res) => {
  const forecast = optimization.forecastCapacity(req.body || {}, req.user);
  audit(req, 'finops_capacity_forecast', 'finops_capacity', forecast.scopeRef,
    { horizonDays: forecast.horizonDays, recommendation: forecast.recommendation, purchaseStarted: false });
  res.status(201).json({ forecast });
}));
router.post('/placement-scores', writeable, route((req, res) => {
  const score = optimization.scorePlacement(req.body || {}, req.user);
  audit(req, 'finops_placement_score', 'finops_workload', score.workloadRef,
    { selectedTargetRef: score.selectedTargetRef, candidates: score.ranking.length, providerMutationsStarted: 0 });
  res.status(201).json({ score });
}));

module.exports = router;
