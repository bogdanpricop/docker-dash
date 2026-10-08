'use strict';

const crypto = require('crypto');
const { getDb } = require('../db');

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@+ -]{0,299}$/;
const SECRET_KEY = /password|secret|token|credential|private.?key|authorization|cookie/i;
const SOURCE_KINDS = ['bmc', 'vendor', 'meter', 'manual', 'import'];

class FinOpsSustainabilityError extends Error {
  constructor(message, status = 400, code = 'FINOPS_SUSTAINABILITY_ERROR', details) {
    super(message); this.name = 'FinOpsSustainabilityError'; this.status = status; this.code = code; this.details = details;
  }
}

const fail = (message, status, code, details) => new FinOpsSustainabilityError(message, status, code, details);
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stable = value => JSON.stringify(canonical(value));
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
const round = (value, digits = 6) => Number(Number(value).toFixed(digits));
const text = (value, key, max = 300) => {
  const result = String(value ?? '').trim();
  if (!result || result.length > max || !SAFE_NAME.test(result)) throw fail(`${key} is invalid`);
  return result;
};
const number = (value, key, min = 0, max = 1e15) => {
  const result = Number(value);
  if (!Number.isFinite(result) || result < min || result > max) throw fail(`${key} must be between ${min} and ${max}`);
  return result;
};
const integer = (value, key, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw fail(`${key} must be an integer between ${min} and ${max}`);
  return result;
};
const timestamp = (value, key) => {
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) throw fail(`${key} must be an ISO timestamp`);
  return result.toISOString();
};
function httpsUrl(value, key = 'sourceUrl') {
  const result = String(value ?? '').trim(); let parsed;
  try { parsed = new URL(result); } catch { throw fail(`${key} must be a valid URL`); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) {
    throw fail(`${key} must be credential-free HTTPS`);
  }
  return parsed.toString();
}
function safeDocument(value, key, maxBytes = 128 * 1024) {
  const result = canonical(object(value)); const encoded = stable(result);
  if (Buffer.byteLength(encoded) > maxBytes) throw fail(`${key} exceeds ${maxBytes} bytes`, 413, 'DOCUMENT_TOO_LARGE');
  const visit = (node, path) => {
    if (!node || typeof node !== 'object') return;
    for (const [field, child] of Object.entries(node)) {
      if (SECRET_KEY.test(field)) throw fail(`${path}.${field} may not contain secret material`, 400, 'SECRET_FIELD');
      visit(child, `${path}.${field}`);
    }
  };
  visit(result, key); return result;
}
const stringList = (value, key, max = 100) => {
  if (!Array.isArray(value) || value.length > max) throw fail(`${key} must be an array with at most ${max} items`);
  return [...new Set(value.map((item, index) => text(item, `${key}[${index}]`)))].sort();
};

class FinOpsSustainabilityService {
  constructor(dbProvider = getDb) { this._dbProvider = dbProvider; }
  _db() { return this._dbProvider(); }
  _admin(actor) {
    if (!actor?.id) throw fail('Authenticated user is required', 401, 'AUTH_REQUIRED');
    if (actor.role !== 'admin') throw fail('Administrator permission is required', 403, 'GOVERNANCE_FORBIDDEN');
  }
  _powerRow(row) { return row && { id: row.id, hostRef: row.host_ref, siteRef: row.site_ref,
    intervalStart: row.interval_start, intervalEnd: row.interval_end, averageWatts: row.average_watts,
    peakWatts: row.peak_watts, energyKwh: row.energy_kwh, cpuUtilizationPercent: row.cpu_utilization_percent,
    vmCount: row.vm_count, workloadCount: row.workload_count, sourceKind: row.source_kind,
    provenance: parse(row.provenance_json, {}), evidenceHash: row.evidence_hash, sampleHash: row.sample_hash,
    createdAt: row.created_at }; }
  _factorRow(row) { return row && { id: row.id, siteRef: row.site_ref, region: row.region,
    effectiveFrom: row.effective_from, effectiveTo: row.effective_to, gramsCo2ePerKwh: row.grams_co2e_per_kwh,
    sourceUrl: row.source_url, methodology: row.methodology, provenance: parse(row.provenance_json, {}),
    factorHash: row.factor_hash, createdAt: row.created_at }; }
  _recommendationRow(row) { return row && { id: row.id, workloadRef: row.workload_ref, state: row.state,
    current: parse(row.current_json, {}), candidates: parse(row.candidates_json, []),
    selected: parse(row.selected_json, null), constraints: parse(row.constraints_json, {}),
    blockers: parse(row.blockers_json, []), recommendationHash: row.recommendation_hash,
    providerMutationsStarted: 0, createdAt: row.created_at }; }
  _tcoRow(row) { return row && { id: row.id, name: row.name, horizonMonths: row.horizon_months,
    currency: row.currency, assumptions: parse(row.assumptions_json, {}), ranking: parse(row.ranking_json, []),
    selectedOption: row.selected_option, scenarioHash: row.scenario_hash, billingTransactionsCreated: 0,
    providerMutationsStarted: 0, createdAt: row.created_at }; }

  recordPowerTelemetry(body = {}, actor) {
    this._admin(actor);
    const hostRef = text(body.hostRef, 'hostRef'); const siteRef = text(body.siteRef, 'siteRef');
    const intervalStart = timestamp(body.intervalStart, 'intervalStart');
    const intervalEnd = timestamp(body.intervalEnd, 'intervalEnd');
    const hours = (new Date(intervalEnd) - new Date(intervalStart)) / 3600000;
    if (hours <= 0 || hours > 24 * 31) throw fail('Power interval must be positive and no longer than 31 days');
    const averageWatts = number(body.averageWatts, 'averageWatts', 0, 10_000_000);
    const peakWatts = number(body.peakWatts, 'peakWatts', averageWatts, 10_000_000);
    const measuredEnergy = body.energyKwh == null ? null : number(body.energyKwh, 'energyKwh', 0, 10_000_000);
    const energyKwh = round(measuredEnergy == null ? averageWatts * hours / 1000 : measuredEnergy);
    const cpuUtilizationPercent = body.cpuUtilizationPercent == null ? null
      : number(body.cpuUtilizationPercent, 'cpuUtilizationPercent', 0, 100);
    const vmCount = integer(body.vmCount ?? 0, 'vmCount', 0, 1_000_000);
    const workloadCount = integer(body.workloadCount ?? vmCount, 'workloadCount', 0, 1_000_000);
    const sourceKind = text(body.sourceKind, 'sourceKind', 20);
    if (!SOURCE_KINDS.includes(sourceKind)) throw fail('sourceKind is invalid');
    const provenance = safeDocument(body.provenance, 'provenance');
    const evidenceHash = hash(provenance);
    const normalized = { hostRef, siteRef, intervalStart, intervalEnd, averageWatts, peakWatts, energyKwh,
      cpuUtilizationPercent, vmCount, workloadCount, sourceKind, evidenceHash };
    const sampleHash = hash(normalized); const db = this._db();
    const existing = db.prepare('SELECT * FROM finops_power_telemetry WHERE sample_hash=?').get(sampleHash);
    if (existing) return { ...this._powerRow(existing), duplicate: true };
    const saved = db.prepare(`INSERT INTO finops_power_telemetry
      (host_ref,site_ref,interval_start,interval_end,average_watts,peak_watts,energy_kwh,cpu_utilization_percent,
       vm_count,workload_count,source_kind,provenance_json,evidence_hash,sample_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(hostRef, siteRef, intervalStart, intervalEnd, averageWatts,
      peakWatts, energyKwh, cpuUtilizationPercent, vmCount, workloadCount, sourceKind, stable(provenance),
      evidenceHash, sampleHash, actor.id);
    return { ...this._powerRow(db.prepare('SELECT * FROM finops_power_telemetry WHERE id=?').get(saved.lastInsertRowid)), duplicate: false };
  }

  powerTelemetry(query = {}, actor) {
    this._admin(actor); const clauses = []; const params = [];
    if (query.hostRef) { clauses.push('host_ref=?'); params.push(text(query.hostRef, 'hostRef')); }
    if (query.siteRef) { clauses.push('site_ref=?'); params.push(text(query.siteRef, 'siteRef')); }
    if (query.from) { clauses.push('interval_end>=?'); params.push(timestamp(query.from, 'from')); }
    if (query.to) { clauses.push('interval_start<=?'); params.push(timestamp(query.to, 'to')); }
    return this._db().prepare(`SELECT * FROM finops_power_telemetry ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY interval_end DESC,id DESC LIMIT 2000`).all(...params).map(row => this._powerRow(row));
  }

  saveCarbonFactor(body = {}, actor) {
    this._admin(actor); const siteRef = text(body.siteRef, 'siteRef'); const region = text(body.region, 'region');
    const effectiveFrom = timestamp(body.effectiveFrom, 'effectiveFrom');
    const effectiveTo = body.effectiveTo == null ? null : timestamp(body.effectiveTo, 'effectiveTo');
    if (effectiveTo && effectiveTo <= effectiveFrom) throw fail('effectiveTo must be after effectiveFrom');
    const gramsCo2ePerKwh = number(body.gramsCo2ePerKwh, 'gramsCo2ePerKwh', 0, 5000);
    const sourceUrl = httpsUrl(body.sourceUrl); const methodology = text(body.methodology, 'methodology', 300);
    const provenance = safeDocument(body.provenance, 'provenance');
    const normalized = { siteRef, region, effectiveFrom, effectiveTo, gramsCo2ePerKwh, sourceUrl, methodology,
      provenanceHash: hash(provenance) }; const factorHash = hash(normalized); const db = this._db();
    const existing = db.prepare('SELECT * FROM finops_carbon_factors WHERE factor_hash=?').get(factorHash);
    if (existing) return { ...this._factorRow(existing), duplicate: true };
    const saved = db.prepare(`INSERT INTO finops_carbon_factors
      (site_ref,region,effective_from,effective_to,grams_co2e_per_kwh,source_url,methodology,provenance_json,factor_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(siteRef, region, effectiveFrom, effectiveTo, gramsCo2ePerKwh,
      sourceUrl, methodology, stable(provenance), factorHash, actor.id);
    return { ...this._factorRow(db.prepare('SELECT * FROM finops_carbon_factors WHERE id=?').get(saved.lastInsertRowid)), duplicate: false };
  }

  carbonFactors(actor) {
    this._admin(actor);
    return this._db().prepare('SELECT * FROM finops_carbon_factors ORDER BY effective_from DESC,id DESC LIMIT 1000')
      .all().map(row => this._factorRow(row));
  }

  _factorAt(siteRef, at) {
    return this._factorRow(this._db().prepare(`SELECT * FROM finops_carbon_factors
      WHERE site_ref=? AND effective_from<=? AND (effective_to IS NULL OR effective_to>?)
      ORDER BY effective_from DESC,id DESC LIMIT 1`).get(siteRef, at, at));
  }

  energyDashboard(query = {}, actor) {
    this._admin(actor); const samples = this.powerTelemetry(query, actor);
    let totalEnergyKwh = 0; let weightedWattHours = 0; let observedHostHours = 0;
    let vmHours = 0; let workloadHours = 0; let idleWasteKwh = 0; let emissionsKgCo2e = 0; let uncostedEnergyKwh = 0;
    const hosts = new Set(); const sites = new Set();
    for (const sample of samples) {
      const hours = (new Date(sample.intervalEnd) - new Date(sample.intervalStart)) / 3600000;
      totalEnergyKwh += sample.energyKwh; weightedWattHours += sample.averageWatts * hours; observedHostHours += hours;
      vmHours += sample.vmCount * hours; workloadHours += sample.workloadCount * hours;
      if (sample.cpuUtilizationPercent != null && sample.cpuUtilizationPercent <= 10) idleWasteKwh += sample.energyKwh;
      hosts.add(sample.hostRef); sites.add(sample.siteRef);
      const midpoint = new Date((new Date(sample.intervalStart).getTime() + new Date(sample.intervalEnd).getTime()) / 2).toISOString();
      const factor = this._factorAt(sample.siteRef, midpoint);
      if (factor) emissionsKgCo2e += sample.energyKwh * factor.gramsCo2ePerKwh / 1000;
      else uncostedEnergyKwh += sample.energyKwh;
    }
    return { sampleCount: samples.length, hostCount: hosts.size, siteCount: sites.size,
      totalEnergyKwh: round(totalEnergyKwh), averageWatts: observedHostHours ? round(weightedWattHours / observedHostHours) : null,
      wattPerVm: vmHours ? round(weightedWattHours / vmHours) : null,
      wattPerWorkload: workloadHours ? round(weightedWattHours / workloadHours) : null,
      idleHostWasteKwh: round(idleWasteKwh), idleWastePercent: totalEnergyKwh ? round(idleWasteKwh / totalEnergyKwh * 100, 2) : 0,
      emissionsKgCo2e: round(emissionsKgCo2e), carbonCoveragePercent: totalEnergyKwh
        ? round((totalEnergyKwh - uncostedEnergyKwh) / totalEnergyKwh * 100, 2) : 0,
      uncostedEnergyKwh: round(uncostedEnergyKwh), calculationBoundary: 'telemetry-and-configured-carbon-factors',
      providerMutationsStarted: 0 };
  }

  recommendCarbonSchedule(body = {}, actor) {
    this._admin(actor); const workloadRef = text(body.workloadRef, 'workloadRef');
    const energyKwh = number(body.energyKwh, 'energyKwh', 0.000001, 1e9);
    const currentSiteRef = text(body.currentSiteRef, 'currentSiteRef');
    const currentStartAt = timestamp(body.currentStartAt, 'currentStartAt');
    const constraintsInput = object(body.constraints);
    const allowedSites = stringList(constraintsInput.allowedSites || [currentSiteRef], 'constraints.allowedSites');
    const requiredResidency = constraintsInput.requiredResidency == null ? null
      : text(constraintsInput.requiredResidency, 'constraints.requiredResidency');
    const latestStartAt = constraintsInput.latestStartAt == null ? null
      : timestamp(constraintsInput.latestStartAt, 'constraints.latestStartAt');
    const maxLatencyMs = constraintsInput.maxLatencyMs == null ? null
      : number(constraintsInput.maxLatencyMs, 'constraints.maxLatencyMs', 0, 1e7);
    const constraints = { allowedSites, requiredResidency, latestStartAt, maxLatencyMs };
    if (!Array.isArray(body.candidates) || !body.candidates.length || body.candidates.length > 100) {
      throw fail('candidates must contain 1-100 scheduling options');
    }
    const candidates = body.candidates.map((candidate, index) => {
      const item = object(candidate); const siteRef = text(item.siteRef, `candidates[${index}].siteRef`);
      const startAt = timestamp(item.startAt, `candidates[${index}].startAt`);
      const latencyMs = item.latencyMs == null ? null : number(item.latencyMs, `candidates[${index}].latencyMs`, 0, 1e7);
      const residencyTags = stringList(item.residencyTags || [], `candidates[${index}].residencyTags`);
      const blockers = [];
      if (item.available === false) blockers.push('capacity_unavailable');
      if (!allowedSites.includes(siteRef)) blockers.push('site_not_allowed');
      if (requiredResidency && !residencyTags.includes(requiredResidency)) blockers.push('data_residency');
      if (latestStartAt && startAt > latestStartAt) blockers.push('sla_latest_start');
      if (maxLatencyMs != null && (latencyMs == null || latencyMs > maxLatencyMs)) blockers.push('latency');
      const factor = this._factorAt(siteRef, startAt);
      if (!factor) blockers.push('carbon_factor_unknown');
      return { siteRef, startAt, latencyMs, residencyTags, available: item.available !== false,
        gramsCo2ePerKwh: factor?.gramsCo2ePerKwh ?? null, carbonFactorHash: factor?.factorHash || null,
        estimatedKgCo2e: factor ? round(energyKwh * factor.gramsCo2ePerKwh / 1000) : null, blockers };
    }).sort((left, right) => (left.estimatedKgCo2e ?? Infinity) - (right.estimatedKgCo2e ?? Infinity)
      || left.siteRef.localeCompare(right.siteRef) || left.startAt.localeCompare(right.startAt));
    const selected = candidates.find(item => !item.blockers.length) || null;
    const currentFactor = this._factorAt(currentSiteRef, currentStartAt);
    const current = { siteRef: currentSiteRef, startAt: currentStartAt, energyKwh,
      gramsCo2ePerKwh: currentFactor?.gramsCo2ePerKwh ?? null, carbonFactorHash: currentFactor?.factorHash || null,
      estimatedKgCo2e: currentFactor ? round(energyKwh * currentFactor.gramsCo2ePerKwh / 1000) : null };
    const blockers = selected ? [] : [...new Set(candidates.flatMap(item => item.blockers))].sort();
    const state = selected ? 'recommended' : blockers.length ? 'blocked' : 'unknown';
    const normalized = { workloadRef, current, candidates, selected, constraints, blockers };
    const recommendationHash = hash(normalized); const db = this._db();
    const existing = db.prepare('SELECT * FROM finops_carbon_recommendations WHERE recommendation_hash=?').get(recommendationHash);
    if (existing) return { ...this._recommendationRow(existing), duplicate: true };
    const saved = db.prepare(`INSERT INTO finops_carbon_recommendations
      (workload_ref,state,current_json,candidates_json,selected_json,constraints_json,blockers_json,recommendation_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(workloadRef, state, stable(current), stable(candidates), selected ? stable(selected) : null,
      stable(constraints), stable(blockers), recommendationHash, actor.id);
    return { ...this._recommendationRow(db.prepare('SELECT * FROM finops_carbon_recommendations WHERE id=?').get(saved.lastInsertRowid)), duplicate: false };
  }

  carbonRecommendations(actor) {
    this._admin(actor);
    return this._db().prepare('SELECT * FROM finops_carbon_recommendations ORDER BY id DESC LIMIT 200')
      .all().map(row => this._recommendationRow(row));
  }

  compareTco(body = {}, actor) {
    this._admin(actor); const name = text(body.name, 'name');
    const horizonMonths = integer(body.horizonMonths, 'horizonMonths', 1, 120);
    const currency = String(body.currency || 'USD').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw fail('currency must be a three-letter ISO code');
    if (!Array.isArray(body.options) || body.options.length < 2 || body.options.length > 20) {
      throw fail('options must contain 2-20 alternatives');
    }
    const options = body.options.map((raw, index) => {
      const item = object(raw); const optionName = text(item.name, `options[${index}].name`);
      const capex = number(item.capex ?? 0, `options[${index}].capex`);
      const migrationOneTime = number(item.migrationOneTime ?? 0, `options[${index}].migrationOneTime`);
      const residualValue = number(item.residualValue ?? 0, `options[${index}].residualValue`);
      const riskContingencyPercent = number(item.riskContingencyPercent ?? 0, `options[${index}].riskContingencyPercent`, 0, 500);
      const discountRateAnnual = number(item.discountRateAnnual ?? 0, `options[${index}].discountRateAnnual`, 0, 1);
      const annualEscalationPercent = number(item.annualEscalationPercent ?? 0, `options[${index}].annualEscalationPercent`, 0, 500);
      const monthlyCostsInput = object(item.monthlyCosts); const monthlyCosts = {};
      for (const key of ['hardware', 'software', 'facility', 'energy', 'provider', 'network', 'support', 'personnel']) {
        monthlyCosts[key] = number(monthlyCostsInput[key] ?? 0, `options[${index}].monthlyCosts.${key}`);
      }
      const carbonKgMonthly = number(item.carbonKgMonthly ?? 0, `options[${index}].carbonKgMonthly`);
      const carbonPricePerKg = number(item.carbonPricePerKg ?? 0, `options[${index}].carbonPricePerKg`);
      let recurringPresentValue = 0; const baseMonthly = Object.values(monthlyCosts).reduce((sum, value) => sum + value, 0)
        + carbonKgMonthly * carbonPricePerKg;
      for (let month = 1; month <= horizonMonths; month++) {
        const escalation = Math.pow(1 + annualEscalationPercent / 100, (month - 1) / 12);
        const discount = Math.pow(1 + discountRateAnnual, month / 12);
        recurringPresentValue += baseMonthly * escalation / discount;
      }
      const subtotal = capex + migrationOneTime + recurringPresentValue - residualValue;
      const contingency = subtotal * riskContingencyPercent / 100;
      return { name: optionName, total: round(subtotal + contingency, 2), breakdown: { capex, migrationOneTime,
        recurringPresentValue: round(recurringPresentValue, 2), residualValue, contingency: round(contingency, 2),
        baseMonthly: round(baseMonthly, 2), monthlyCosts, carbonKgMonthly, carbonPricePerKg },
      assumptions: { riskContingencyPercent, discountRateAnnual, annualEscalationPercent } };
    });
    const ranking = options.sort((left, right) => left.total - right.total || left.name.localeCompare(right.name))
      .map((item, index) => ({ rank: index + 1, ...item, deltaFromBest: round(item.total - options[0].total, 2) }));
    const assumptions = safeDocument({ options: body.options }, 'assumptions', 256 * 1024);
    const normalized = { name, horizonMonths, currency, assumptions, ranking }; const scenarioHash = hash(normalized);
    const db = this._db(); const existing = db.prepare('SELECT * FROM finops_tco_scenarios WHERE scenario_hash=?').get(scenarioHash);
    if (existing) return { ...this._tcoRow(existing), duplicate: true };
    const saved = db.prepare(`INSERT INTO finops_tco_scenarios
      (name,horizon_months,currency,assumptions_json,ranking_json,selected_option,scenario_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?)`).run(name, horizonMonths, currency, stable(assumptions), stable(ranking),
      ranking[0]?.name || null, scenarioHash, actor.id);
    return { ...this._tcoRow(db.prepare('SELECT * FROM finops_tco_scenarios WHERE id=?').get(saved.lastInsertRowid)), duplicate: false };
  }

  tcoScenarios(actor) {
    this._admin(actor);
    return this._db().prepare('SELECT * FROM finops_tco_scenarios ORDER BY id DESC LIMIT 200')
      .all().map(row => this._tcoRow(row));
  }

  overview(actor) {
    this._admin(actor); const telemetry = this.powerTelemetry({}, actor); const factors = this.carbonFactors(actor);
    const recommendations = this.carbonRecommendations(actor); const tcoScenarios = this.tcoScenarios(actor);
    return { capabilities: { powerEnergyTelemetryIngestion: true, energyEfficiencyDashboard: true,
      carbonFactorConfiguration: true, carbonAwareSchedulingRecommendation: true, tcoScenarioComparator: true },
    telemetry, factors, recommendations, tcoScenarios, dashboard: this.energyDashboard({}, actor),
    summary: { telemetrySamples: telemetry.length, carbonFactors: factors.length,
      actionableCarbonRecommendations: recommendations.filter(item => item.state === 'recommended').length,
      tcoScenarios: tcoScenarios.length, billingTransactionsCreated: 0, providerMutationsStarted: 0 } };
  }
}

const service = new FinOpsSustainabilityService();
module.exports = service;
module.exports.FinOpsSustainabilityService = FinOpsSustainabilityService;
module.exports.FinOpsSustainabilityError = FinOpsSustainabilityError;
module.exports._internals = { canonical, stable, hash, round };
