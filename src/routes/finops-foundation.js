'use strict';

const { Router } = require('express');
const { writeable } = require('../middleware/auth');
const finops = require('../services/finops-foundation');
const auditService = require('../services/audit');
const { getClientIp } = require('../utils/helpers');

const router = Router();
function route(handler) { return async (req, res, next) => { try { await handler(req, res); } catch (error) {
  if (error.name === 'FinOpsError') return res.status(error.status || 400)
    .json({ error: error.message, code: error.code, details: error.details });
  next(error);
} }; }
function audit(req, action, targetType, targetId, details = {}) {
  auditService.log({ userId: req.user.id, username: req.user.username, action, targetType,
    targetId: String(targetId), details, ip: getClientIp(req) });
}

router.get('/', route((req, res) => res.json(finops.overview(req.user))));
router.post('/ledger', writeable, route((req, res) => {
  const entry = finops.recordLedger(req.body || {}, req.user);
  audit(req, 'finops_ledger_record', 'finops_ledger', entry.id, { resourceType: entry.resourceType,
    resourceRef: entry.resourceRef, entryHash: entry.entryHash, duplicate: entry.duplicate });
  res.status(entry.duplicate ? 200 : 201).json({ entry });
}));
router.post('/cost-models', writeable, route((req, res) => {
  const model = finops.saveCostModel(req.body || {}, req.user);
  audit(req, 'finops_cost_model_create', 'finops_cost_model', model.id, { kind: model.kind, version: model.version,
    scopeRef: model.scopeRef, currency: model.currency, confidence: model.confidence, modelHash: model.modelHash });
  res.status(model.duplicate ? 200 : 201).json({ model });
}));
router.post('/allocation-rules', writeable, route((req, res) => {
  const rule = finops.saveAllocationRule(req.body || {}, req.user);
  audit(req, 'finops_allocation_rule_save', 'finops_allocation_rule', rule.id, { priority: rule.priority,
    matchTags: rule.matchTags, dimensions: rule.dimensions, ruleHash: rule.ruleHash });
  res.json({ rule });
}));
router.post('/ledger/:id/allocate', writeable, route((req, res) => {
  const allocation = finops.resolveAllocation(req.params.id, req.user);
  audit(req, 'finops_allocation_resolve', 'finops_ledger', allocation.ledgerEntryId, { state: allocation.state,
    matchedRuleIds: allocation.matchedRuleIds, dimensions: allocation.dimensions, evidenceHash: allocation.evidenceHash });
  res.json({ allocation });
}));
router.post('/rating-runs', writeable, route((req, res) => {
  const run = finops.createRatingRun(req.body || {}, req.user);
  audit(req, 'finops_showback_rate', 'finops_rating_run', run.id, { periodStart: run.periodStart,
    periodEnd: run.periodEnd, totalCost: run.totalCost, currency: run.currency,
    lines: run.lines.length, billingTransactionCreated: run.billingTransactionCreated, duplicate: run.duplicate });
  res.status(run.duplicate ? 200 : 201).json({ run });
}));
router.get('/rating-runs/:id', route((req, res) => res.json({ run: finops.ratingRun(req.params.id, req.user) })));
router.post('/rating-runs/:id/chargeback-exports', writeable, route((req, res) => {
  const result = finops.createChargebackExport(req.params.id, req.body || {}, req.user);
  audit(req, 'finops_chargeback_export', 'finops_chargeback_export', result.export.id, { ratingRunId: result.export.ratingRunId,
    format: result.export.format, rowCount: result.export.rowCount, exportHash: result.export.exportHash,
    billingTransactionCreated: result.billingTransactionCreated });
  res.status(201).json(result);
}));
router.post('/budgets', writeable, route((req, res) => {
  const budget = finops.saveBudget(req.body || {}, req.user);
  audit(req, 'finops_budget_create', 'finops_budget', budget.id, { cadence: budget.cadence, scopeType: budget.scopeType,
    scopeValue: budget.scopeValue, amount: budget.amount, currency: budget.currency, budgetHash: budget.budgetHash });
  res.status(201).json({ budget });
}));

module.exports = router;
