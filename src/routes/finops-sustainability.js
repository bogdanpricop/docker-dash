'use strict';

const { Router } = require('express');
const { writeable } = require('../middleware/auth');
const sustainability = require('../services/finops-sustainability');
const auditService = require('../services/audit');
const { getClientIp } = require('../utils/helpers');

const router = Router();
function route(handler) { return async (req, res, next) => { try { await handler(req, res); } catch (error) {
  if (error.name === 'FinOpsSustainabilityError') return res.status(error.status || 400)
    .json({ error: error.message, code: error.code, details: error.details });
  next(error);
} }; }
function audit(req, action, targetType, targetId, details = {}) {
  auditService.log({ userId: req.user.id, username: req.user.username, action, targetType,
    targetId: String(targetId), details, ip: getClientIp(req) });
}

router.get('/', route((req, res) => res.json(sustainability.overview(req.user))));
router.get('/energy-dashboard', route((req, res) => res.json(sustainability.energyDashboard(req.query, req.user))));
router.post('/power-telemetry', writeable, route((req, res) => {
  const sample = sustainability.recordPowerTelemetry(req.body || {}, req.user);
  audit(req, 'finops_power_telemetry_record', 'finops_power_telemetry', sample.id,
    { hostRef: sample.hostRef, siteRef: sample.siteRef, energyKwh: sample.energyKwh,
      sourceKind: sample.sourceKind, evidenceHash: sample.evidenceHash, duplicate: sample.duplicate });
  res.status(sample.duplicate ? 200 : 201).json({ sample });
}));
router.post('/carbon-factors', writeable, route((req, res) => {
  const factor = sustainability.saveCarbonFactor(req.body || {}, req.user);
  audit(req, 'finops_carbon_factor_save', 'finops_carbon_factor', factor.id,
    { siteRef: factor.siteRef, region: factor.region, gramsCo2ePerKwh: factor.gramsCo2ePerKwh,
      factorHash: factor.factorHash, duplicate: factor.duplicate });
  res.status(factor.duplicate ? 200 : 201).json({ factor });
}));
router.post('/carbon-recommendations', writeable, route((req, res) => {
  const recommendation = sustainability.recommendCarbonSchedule(req.body || {}, req.user);
  audit(req, 'finops_carbon_schedule_recommend', 'finops_workload', recommendation.workloadRef,
    { state: recommendation.state, selectedSiteRef: recommendation.selected?.siteRef || null,
      blockers: recommendation.blockers, providerMutationsStarted: 0 });
  res.status(recommendation.duplicate ? 200 : 201).json({ recommendation });
}));
router.post('/tco-scenarios', writeable, route((req, res) => {
  const scenario = sustainability.compareTco(req.body || {}, req.user);
  audit(req, 'finops_tco_compare', 'finops_tco_scenario', scenario.id,
    { horizonMonths: scenario.horizonMonths, selectedOption: scenario.selectedOption,
      options: scenario.ranking.length, billingTransactionsCreated: 0, providerMutationsStarted: 0 });
  res.status(scenario.duplicate ? 200 : 201).json({ scenario });
}));

module.exports = router;
