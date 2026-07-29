'use strict';

const crypto = require('crypto');
const { getDb } = require('../db');

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_. -]{0,159}$/;
const SAFE_REF = /^[a-zA-Z0-9][a-zA-Z0-9_.:+/@* -]{0,499}$/;
const SAFE_TAG = /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,99}$/;
const SECRET_KEY = /password|secret|token|credential|private.?key|authorization|cookie|license.?key/i;
const KINDS = ['private_cloud', 'provider_license', 'storage', 'network', 'gpu'];
const DIMENSIONS = ['businessUnit', 'application', 'environment', 'costCenter', 'project', 'site'];
const ALLOCATION_KEYS = ['vCpu', 'ramGb', 'logicalStorageGb', 'physicalStorageGb', 'replicatedStorageGb',
  'backupStorageGb', 'gpuDevices', 'publicIps', 'licenseUnits'];
const USAGE_KEYS = ['usedVcpu', 'usedRamGb', 'cpuHours', 'ramGbHours', 'transferGb', 'egressGb',
  'loadBalancerHours', 'vpnHours', 'publicIpHours', 'gpuHours', 'gpuReservations', 'licenseSockets',
  'licenseHosts', 'licenseSubscriptions'];

class FinOpsError extends Error {
  constructor(message, status = 400, code = 'FINOPS_ERROR', details) {
    super(message); this.name = 'FinOpsError'; this.status = status; this.code = code; this.details = details;
  }
}

const fail = (message, status, code, details) => new FinOpsError(message, status, code, details);
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stable = value => JSON.stringify(canonical(value));
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
const round = value => Math.round((value + Number.EPSILON) * 1000000) / 1000000;
const text = (value, key, max = 500, pattern = SAFE_REF) => {
  const result = String(value ?? '').trim();
  if (!result || result.length > max || (pattern && !pattern.test(result))) throw fail(`${key} is invalid`);
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
function timestamp(value, key) {
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) throw fail(`${key} must be an ISO timestamp`);
  return result.toISOString();
}
function httpsUrl(value, key = 'sourceUrl') {
  const result = text(value, key, 1000, null); let parsed;
  try { parsed = new URL(result); } catch { throw fail(`${key} must be a valid URL`); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) {
    throw fail(`${key} must be credential-free HTTPS`);
  }
  return parsed.toString();
}
function bounded(value, key, max = 256 * 1024) {
  let encoded; try { encoded = JSON.stringify(value); } catch { throw fail(`${key} must be JSON serializable`); }
  if (Buffer.byteLength(encoded) > max) throw fail(`${key} exceeds ${max} bytes`, 413, 'FINOPS_DOCUMENT_TOO_LARGE');
}
function secretFree(value, path = 'document') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) throw fail(`${path}.${key} may not contain secret material`, 400, 'FINOPS_SECRET_FIELD');
    secretFree(child, `${path}.${key}`);
  }
}
function numericDocument(value, key, allowed) {
  const input = object(value); const result = {};
  for (const [field, raw] of Object.entries(input)) {
    if (!allowed.includes(field)) throw fail(`${key}.${field} is not supported`);
    result[field] = number(raw, `${key}.${field}`);
  }
  return canonical(result);
}
function tags(value) {
  const input = object(value); const entries = Object.entries(input);
  if (entries.length > 50) throw fail('tags may contain at most 50 entries');
  const result = {};
  for (const [key, raw] of entries) {
    if (!SAFE_TAG.test(key) || SECRET_KEY.test(key)) throw fail(`tags.${key} is invalid`);
    result[key] = text(raw, `tags.${key}`, 200, SAFE_REF);
  }
  return canonical(result);
}
function tagPatterns(value) {
  const input = object(value); const entries = Object.entries(input);
  if (entries.length > 50) throw fail('matchTags may contain at most 50 entries');
  const result = {};
  for (const [key, raw] of entries) {
    if (!SAFE_TAG.test(key) || SECRET_KEY.test(key)) throw fail(`matchTags.${key} is invalid`);
    result[key] = text(raw, `matchTags.${key}`, 200, /^[a-zA-Z0-9*][a-zA-Z0-9_.:+/@* -]{0,199}$/);
  }
  return canonical(result);
}
function dimensions(value, allowEmpty = false) {
  const input = object(value); const result = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!DIMENSIONS.includes(key)) throw fail(`dimensions.${key} is not supported`);
    result[key] = text(raw, `dimensions.${key}`, 200, SAFE_REF);
  }
  if (!allowEmpty && !Object.keys(result).length) throw fail('At least one allocation dimension is required');
  return canonical(result);
}
function globMatch(pattern, value) {
  const escaped = pattern.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}
function csvCell(value) {
  const result = String(value ?? '');
  return /[",\r\n]/.test(result) ? `"${result.replace(/"/g, '""')}"` : result;
}

class FinOpsFoundationService {
  constructor(dbProvider = getDb) { this._dbProvider = dbProvider; }
  _db() { return this._dbProvider(); }
  _admin(actor) {
    if (!actor?.id) throw fail('Authenticated user is required', 401, 'AUTH_REQUIRED');
    if (actor.role !== 'admin') throw fail('Administrator permission is required', 403, 'GOVERNANCE_FORBIDDEN');
  }
  _ledgerRow(row) { return row && { id: row.id, resourceType: row.resource_type, resourceRef: row.resource_ref,
    providerRef: row.provider_ref, siteRef: row.site_ref, intervalStart: row.interval_start, intervalEnd: row.interval_end,
    allocation: parse(row.allocation_json, {}), usage: parse(row.usage_json, {}), tags: parse(row.tags_json, {}),
    evidence: parse(row.evidence_json, {}), evidenceHash: row.evidence_hash, entryHash: row.entry_hash, createdAt: row.created_at }; }
  _modelRow(row) { return row && { id: row.id, name: row.name, version: row.version, kind: row.kind,
    scopeRef: row.scope_ref, currency: row.currency, confidence: row.confidence, parameters: parse(row.parameters_json, {}),
    sourceUrl: row.source_url, effectiveFrom: row.effective_from, effectiveTo: row.effective_to,
    modelHash: row.model_hash, createdAt: row.created_at }; }
  _ruleRow(row) { return row && { id: row.id, name: row.name, priority: row.priority,
    matchTags: parse(row.match_tags_json, {}), dimensions: parse(row.dimensions_json, {}), active: !!row.active,
    ruleHash: row.rule_hash, createdAt: row.created_at }; }
  _allocationRow(row) { return row && { id: row.id, ledgerEntryId: row.ledger_entry_id, state: row.state,
    matchedRuleIds: parse(row.matched_rule_ids_json, []), dimensions: parse(row.dimensions_json, {}),
    evidenceHash: row.evidence_hash, createdAt: row.created_at }; }
  _lineRow(row) { return row && { id: row.id, ratingRunId: row.rating_run_id, ledgerEntryId: row.ledger_entry_id,
    costModelId: row.cost_model_id, category: row.category, quantity: row.quantity, unit: row.unit,
    rate: row.rate, amount: row.amount, currency: row.currency, confidence: row.confidence,
    dimensions: parse(row.dimensions_json, {}), formula: parse(row.formula_json, {}), provenanceHash: row.provenance_hash }; }

  recordLedger(body = {}, actor) {
    this._admin(actor);
    const resourceType = text(body.resourceType, 'resourceType', 80, SAFE_TAG);
    const resourceRef = text(body.resourceRef, 'resourceRef');
    const providerRef = body.providerRef == null ? null : text(body.providerRef, 'providerRef');
    const siteRef = body.siteRef == null ? null : text(body.siteRef, 'siteRef');
    const intervalStart = timestamp(body.intervalStart, 'intervalStart');
    const intervalEnd = timestamp(body.intervalEnd, 'intervalEnd');
    const duration = new Date(intervalEnd) - new Date(intervalStart);
    if (duration <= 0 || duration > 93 * 86400000) throw fail('Ledger interval must be positive and no longer than 93 days');
    const allocation = numericDocument(body.allocation, 'allocation', ALLOCATION_KEYS);
    const usage = numericDocument(body.usage, 'usage', USAGE_KEYS);
    if (body.gpuProfile != null) usage.gpuProfile = text(body.gpuProfile, 'gpuProfile', 120, SAFE_NAME);
    if (!Object.keys(allocation).length && !Object.keys(usage).length) throw fail('Allocation or usage evidence is required');
    const normalizedTags = tags(body.tags); const evidence = canonical(object(body.evidence));
    bounded(evidence, 'evidence'); secretFree(evidence, 'evidence');
    const evidenceHash = hash(evidence);
    const normalized = { resourceType, resourceRef, providerRef, siteRef, intervalStart, intervalEnd,
      allocation, usage, tags: normalizedTags, evidenceHash };
    const entryHash = hash(normalized); const db = this._db();
    const existing = db.prepare('SELECT * FROM finops_resource_ledger WHERE entry_hash=?').get(entryHash);
    if (existing) return { ...this._ledgerRow(existing), duplicate: true };
    const saved = db.prepare(`INSERT INTO finops_resource_ledger
      (resource_type,resource_ref,provider_ref,site_ref,interval_start,interval_end,allocation_json,usage_json,tags_json,evidence_json,evidence_hash,entry_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(resourceType, resourceRef, providerRef, siteRef, intervalStart, intervalEnd,
      stable(allocation), stable(usage), stable(normalizedTags), stable(evidence), evidenceHash, entryHash, actor.id);
    return { ...this._ledgerRow(db.prepare('SELECT * FROM finops_resource_ledger WHERE id=?').get(saved.lastInsertRowid)), duplicate: false };
  }
  ledger(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM finops_resource_ledger ORDER BY interval_end DESC,id DESC LIMIT 1000').all().map(row => this._ledgerRow(row)); }

  _parameters(kind, supplied) {
    const input = object(supplied); bounded(input, 'parameters'); secretFree(input, 'parameters');
    if (kind === 'private_cloud') {
      const monthly = numericDocument(input.monthlyCosts, 'parameters.monthlyCosts', ['hardware','software','facility','energy','personnel']);
      const capacity = numericDocument(input.capacity, 'parameters.capacity', ['vCpu','ramGb']);
      if (!Object.keys(monthly).length || Object.values(monthly).reduce((a, b) => a + b, 0) <= 0) throw fail('private_cloud monthlyCosts must be positive');
      if (!(capacity.vCpu > 0) || !(capacity.ramGb > 0)) throw fail('private_cloud capacity requires positive vCpu and ramGb');
      const weights = numericDocument(input.weights || { vCpu: 0.5, ramGb: 0.5 }, 'parameters.weights', ['vCpu','ramGb']);
      if ((weights.vCpu || 0) + (weights.ramGb || 0) <= 0) throw fail('private_cloud weights must be positive');
      return canonical({ monthlyCosts: monthly, capacity, weights });
    }
    if (kind === 'provider_license') {
      const metric = text(input.metric, 'parameters.metric', 30, SAFE_TAG);
      if (!['core','socket','host','subscription'].includes(metric)) throw fail('provider_license metric is invalid');
      const billingPeriod = input.billingPeriod || 'month';
      if (!['month','year'].includes(billingPeriod)) throw fail('provider_license billingPeriod is invalid');
      return { metric, unitCost: number(input.unitCost, 'parameters.unitCost'), billingPeriod };
    }
    if (kind === 'storage') return { rates: numericDocument(input.rates, 'parameters.rates',
      ['logicalGbMonth','physicalGbMonth','replicatedGbMonth','backupGbMonth']) };
    if (kind === 'network') return { rates: numericDocument(input.rates, 'parameters.rates',
      ['transferGb','egressGb','loadBalancerHour','vpnHour','publicIpHour']) };
    const suppliedProfiles = object(input.profiles); const entries = Object.entries(suppliedProfiles);
    if (!entries.length || entries.length > 50) throw fail('gpu profiles must contain 1-50 entries');
    const profiles = {};
    for (const [profile, rates] of entries) {
      if (!SAFE_TAG.test(profile)) throw fail(`parameters.profiles.${profile} is invalid`);
      profiles[profile] = numericDocument(rates, `parameters.profiles.${profile}`, ['hourlyRate','reservationMonthly']);
    }
    return { profiles: canonical(profiles) };
  }
  saveCostModel(body = {}, actor) {
    this._admin(actor); const kind = text(body.kind, 'kind', 40, SAFE_TAG);
    if (!KINDS.includes(kind)) throw fail('kind is invalid');
    const name = text(body.name, 'name', 160, SAFE_NAME); const version = text(body.version, 'version', 80, SAFE_NAME);
    const scopeRef = !body.scopeRef || body.scopeRef === '*' ? '*' : text(body.scopeRef, 'scopeRef');
    const currency = text(body.currency || 'USD', 'currency', 3, /^[A-Z]{3}$/);
    const confidence = body.confidence || 'estimated';
    if (!['actual','contracted','estimated','allocated'].includes(confidence)) throw fail('confidence is invalid');
    const parameters = this._parameters(kind, body.parameters); const sourceUrl = httpsUrl(body.sourceUrl);
    const effectiveFrom = timestamp(body.effectiveFrom, 'effectiveFrom');
    const effectiveTo = body.effectiveTo == null ? null : timestamp(body.effectiveTo, 'effectiveTo');
    if (effectiveTo && effectiveTo <= effectiveFrom) throw fail('effectiveTo must be after effectiveFrom');
    const normalized = { name, version, kind, scopeRef, currency, confidence, parameters, sourceUrl, effectiveFrom, effectiveTo };
    const modelHash = hash(normalized); const db = this._db();
    const existingHash = db.prepare('SELECT * FROM finops_cost_models WHERE model_hash=?').get(modelHash);
    if (existingHash) return { ...this._modelRow(existingHash), duplicate: true };
    if (db.prepare('SELECT 1 FROM finops_cost_models WHERE name=? AND version=?').get(name, version)) {
      throw fail('Cost model name/version already exists with different content', 409, 'COST_MODEL_VERSION_EXISTS');
    }
    const saved = db.prepare(`INSERT INTO finops_cost_models
      (name,version,kind,scope_ref,currency,confidence,parameters_json,source_url,effective_from,effective_to,model_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(name, version, kind, scopeRef, currency, confidence, stable(parameters), sourceUrl,
      effectiveFrom, effectiveTo, modelHash, actor.id);
    return { ...this._modelRow(db.prepare('SELECT * FROM finops_cost_models WHERE id=?').get(saved.lastInsertRowid)), duplicate: false };
  }
  costModels(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM finops_cost_models ORDER BY effective_from DESC,id DESC').all().map(row => this._modelRow(row)); }

  saveAllocationRule(body = {}, actor) {
    this._admin(actor); const name = text(body.name, 'name', 160, SAFE_NAME);
    const priority = integer(body.priority ?? 100, 'priority', 0, 10000); const matchTags = tagPatterns(body.matchTags);
    if (!Object.keys(matchTags).length) throw fail('At least one match tag is required');
    const mapped = dimensions(body.dimensions); const active = body.active !== false;
    const normalized = { name, priority, matchTags, dimensions: mapped, active }; const ruleHash = hash(normalized); const db = this._db();
    db.prepare(`INSERT INTO finops_allocation_rules (name,priority,match_tags_json,dimensions_json,active,rule_hash,created_by)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET priority=excluded.priority,match_tags_json=excluded.match_tags_json,
      dimensions_json=excluded.dimensions_json,active=excluded.active,rule_hash=excluded.rule_hash,created_by=excluded.created_by,updated_at=datetime('now')`)
      .run(name, priority, stable(matchTags), stable(mapped), active ? 1 : 0, ruleHash, actor.id);
    return this._ruleRow(db.prepare('SELECT * FROM finops_allocation_rules WHERE name=?').get(name));
  }
  allocationRules(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM finops_allocation_rules ORDER BY priority DESC,id').all().map(row => this._ruleRow(row)); }
  resolveAllocation(id, actor) {
    this._admin(actor); const db = this._db(); const entry = this._ledgerRow(db.prepare('SELECT * FROM finops_resource_ledger WHERE id=?').get(integer(id, 'ledgerEntryId', 1)));
    if (!entry) throw fail('Ledger entry not found', 404, 'LEDGER_ENTRY_NOT_FOUND');
    const rules = this.allocationRules(actor).filter(rule => rule.active); const resolved = {}; const matchedRuleIds = [];
    for (const rule of rules) {
      const matched = Object.entries(rule.matchTags).every(([key, pattern]) => entry.tags[key] != null && globMatch(pattern, entry.tags[key]));
      if (!matched) continue; matchedRuleIds.push(rule.id);
      for (const [key, value] of Object.entries(rule.dimensions)) if (resolved[key] == null) resolved[key] = value;
    }
    const core = ['businessUnit','application','environment','costCenter']; const count = core.filter(key => resolved[key]).length;
    const state = count === core.length ? 'allocated' : count ? 'partial' : 'unallocated';
    const evidenceHash = hash({ ledgerEntryId: entry.id, entryHash: entry.entryHash, matchedRuleIds, dimensions: resolved });
    db.prepare(`INSERT INTO finops_resource_allocations
      (ledger_entry_id,state,matched_rule_ids_json,dimensions_json,evidence_hash,created_by) VALUES (?,?,?,?,?,?)
      ON CONFLICT(ledger_entry_id) DO UPDATE SET state=excluded.state,matched_rule_ids_json=excluded.matched_rule_ids_json,
      dimensions_json=excluded.dimensions_json,evidence_hash=excluded.evidence_hash,created_by=excluded.created_by,updated_at=datetime('now')`)
      .run(entry.id, state, stable(matchedRuleIds), stable(resolved), evidenceHash, actor.id);
    return this._allocationRow(db.prepare('SELECT * FROM finops_resource_allocations WHERE ledger_entry_id=?').get(entry.id));
  }
  allocations(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM finops_resource_allocations ORDER BY id DESC LIMIT 1000').all().map(row => this._allocationRow(row)); }

  _rate(entry, model, dimensionsValue) {
    const hours = (new Date(entry.intervalEnd) - new Date(entry.intervalStart)) / 3600000;
    const monthFactor = hours / 730; const p = model.parameters; let quantity = 0; let rate = 0; let amount = 0; let unit; let formula;
    if (model.kind === 'private_cloud') {
      const monthlyTotal = Object.values(p.monthlyCosts).reduce((sum, value) => sum + value, 0);
      const weightTotal = p.weights.vCpu + p.weights.ramGb;
      const normalizedShare = (((entry.allocation.vCpu || 0) / p.capacity.vCpu) * p.weights.vCpu
        + ((entry.allocation.ramGb || 0) / p.capacity.ramGb) * p.weights.ramGb) / weightTotal;
      quantity = normalizedShare * monthFactor; rate = monthlyTotal; amount = quantity * rate; unit = 'capacity-month';
      formula = { method: 'weighted_capacity_share', hours, monthFactor, monthlyCosts: p.monthlyCosts,
        capacity: p.capacity, weights: p.weights, normalizedShare };
    } else if (model.kind === 'provider_license') {
      const source = { core: entry.allocation.vCpu, socket: entry.usage.licenseSockets,
        host: entry.usage.licenseHosts, subscription: entry.usage.licenseSubscriptions }[p.metric];
      const units = source ?? entry.allocation.licenseUnits ?? 0; const periodFactor = p.billingPeriod === 'year' ? hours / 8760 : monthFactor;
      quantity = units * periodFactor; rate = p.unitCost; amount = quantity * rate; unit = `${p.metric}-${p.billingPeriod}`;
      formula = { method: 'licensed_units', metric: p.metric, units, billingPeriod: p.billingPeriod, hours, periodFactor };
    } else if (model.kind === 'storage') {
      const components = [
        ['logicalStorageGb','logicalGbMonth'], ['physicalStorageGb','physicalGbMonth'],
        ['replicatedStorageGb','replicatedGbMonth'], ['backupStorageGb','backupGbMonth'],
      ].map(([field, rateKey]) => ({ field, quantity: (entry.allocation[field] || 0) * monthFactor,
        rate: p.rates[rateKey] || 0, amount: (entry.allocation[field] || 0) * monthFactor * (p.rates[rateKey] || 0) }));
      quantity = components.reduce((sum, item) => sum + item.quantity, 0); amount = components.reduce((sum, item) => sum + item.amount, 0);
      rate = quantity ? amount / quantity : 0; unit = 'gb-month'; formula = { method: 'storage_tier_sum', hours, monthFactor, components };
    } else if (model.kind === 'network') {
      const ipHours = entry.usage.publicIpHours ?? (entry.allocation.publicIps || 0) * hours;
      const components = [
        ['transferGb', entry.usage.transferGb || 0, p.rates.transferGb || 0], ['egressGb', entry.usage.egressGb || 0, p.rates.egressGb || 0],
        ['loadBalancerHour', entry.usage.loadBalancerHours || 0, p.rates.loadBalancerHour || 0], ['vpnHour', entry.usage.vpnHours || 0, p.rates.vpnHour || 0],
        ['publicIpHour', ipHours, p.rates.publicIpHour || 0],
      ].map(([metric, value, metricRate]) => ({ metric, quantity: value, rate: metricRate, amount: value * metricRate }));
      quantity = components.reduce((sum, item) => sum + item.quantity, 0); amount = components.reduce((sum, item) => sum + item.amount, 0);
      rate = quantity ? amount / quantity : 0; unit = 'rated-network-unit'; formula = { method: 'network_component_sum', hours, components };
    } else {
      const profile = entry.usage.gpuProfile || entry.tags.gpuProfile || 'default'; const profileRates = p.profiles[profile];
      if (!profileRates) throw fail(`GPU profile ${profile} is not present in cost model ${model.id}`, 409, 'GPU_PROFILE_NOT_RATED');
      const gpuHours = entry.usage.gpuHours ?? (entry.allocation.gpuDevices || 0) * hours;
      const reservations = entry.usage.gpuReservations || 0;
      const hourlyAmount = gpuHours * (profileRates.hourlyRate || 0); const reservationAmount = reservations * monthFactor * (profileRates.reservationMonthly || 0);
      quantity = gpuHours; amount = hourlyAmount + reservationAmount; rate = quantity ? amount / quantity : 0; unit = 'gpu-hour';
      formula = { method: 'gpu_profile_and_reservation', profile, gpuHours, reservations, monthFactor,
        hourlyRate: profileRates.hourlyRate || 0, reservationMonthly: profileRates.reservationMonthly || 0 };
    }
    const normalized = { ledgerEntryId: entry.id, costModelId: model.id, category: model.kind,
      quantity: round(quantity), unit, rate: round(rate), amount: round(amount), currency: model.currency,
      confidence: model.confidence, dimensions: dimensionsValue, formula: canonical(formula) };
    return { ...normalized, provenanceHash: hash({ ...normalized, entryHash: entry.entryHash, modelHash: model.modelHash }) };
  }
  createRatingRun(body = {}, actor) {
    this._admin(actor); const periodStart = timestamp(body.periodStart, 'periodStart'); const periodEnd = timestamp(body.periodEnd, 'periodEnd');
    if (periodEnd <= periodStart || new Date(periodEnd) - new Date(periodStart) > 366 * 86400000) throw fail('Rating period must be positive and at most 366 days');
    if (!Array.isArray(body.costModelIds) || !body.costModelIds.length || body.costModelIds.length > 25) throw fail('costModelIds must contain 1-25 values');
    const ids = [...new Set(body.costModelIds.map((id, index) => integer(id, `costModelIds[${index}]`, 1)))]; const db = this._db();
    const placeholders = ids.map(() => '?').join(','); const models = db.prepare(`SELECT * FROM finops_cost_models WHERE id IN (${placeholders}) ORDER BY id`).all(...ids).map(row => this._modelRow(row));
    if (models.length !== ids.length) throw fail('One or more cost models were not found', 404, 'COST_MODEL_NOT_FOUND');
    const currencies = [...new Set(models.map(model => model.currency))]; if (currencies.length !== 1) throw fail('All cost models must use one currency');
    for (const model of models) if (model.effectiveFrom > periodStart || (model.effectiveTo && model.effectiveTo < periodEnd)) {
      throw fail(`Cost model ${model.id} does not cover the complete rating period`, 409, 'COST_MODEL_WINDOW_GAP');
    }
    const entries = db.prepare(`SELECT * FROM finops_resource_ledger WHERE interval_start>=? AND interval_end<=?
      ORDER BY interval_start,id`).all(periodStart, periodEnd).map(row => this._ledgerRow(row));
    const inputHash = hash({ periodStart, periodEnd, modelHashes: models.map(item => item.modelHash), entryHashes: entries.map(item => item.entryHash) });
    const existing = db.prepare('SELECT * FROM finops_rating_runs WHERE input_hash=?').get(inputHash);
    if (existing) return { ...this.ratingRun(existing.id, actor), duplicate: true };
    const lines = [];
    for (const entry of entries) {
      let allocation = db.prepare('SELECT * FROM finops_resource_allocations WHERE ledger_entry_id=?').get(entry.id);
      if (!allocation) { this.resolveAllocation(entry.id, actor); allocation = db.prepare('SELECT * FROM finops_resource_allocations WHERE ledger_entry_id=?').get(entry.id); }
      const mapped = this._allocationRow(allocation).dimensions;
      const lineDimensions = canonical({ ...mapped, resourceType: entry.resourceType, resourceRef: entry.resourceRef,
        provider: entry.providerRef || undefined, site: mapped.site || entry.siteRef || undefined });
      for (const model of models) {
        if (model.scopeRef !== '*' && ![entry.providerRef, entry.siteRef, mapped.project, mapped.costCenter].includes(model.scopeRef)) continue;
        lines.push(this._rate(entry, model, lineDimensions));
      }
    }
    const totalCost = round(lines.reduce((sum, line) => sum + line.amount, 0));
    const aggregate = key => lines.reduce((result, line) => { const value = line[key] || line.dimensions[key] || 'unallocated';
      result[value] = round((result[value] || 0) + line.amount); return result; }, {});
    const summary = { lineCount: lines.length, resourceCount: new Set(lines.map(line => line.ledgerEntryId)).size,
      byCategory: aggregate('category'), byCostCenter: aggregate('costCenter'), byConfidence: aggregate('confidence'),
      allocationCoverage: entries.length ? round(lines.filter(line => line.dimensions.costCenter).length / Math.max(lines.length, 1)) : 0 };
    const runId = db.transaction(() => {
      const saved = db.prepare(`INSERT INTO finops_rating_runs
        (period_start,period_end,currency,state,input_hash,total_cost,summary_json,created_by) VALUES (?,?,?,?,?,?,?,?)`)
        .run(periodStart, periodEnd, currencies[0], lines.length ? 'completed' : 'empty', inputHash, totalCost, stable(summary), actor.id);
      const id = Number(saved.lastInsertRowid); const insert = db.prepare(`INSERT INTO finops_rated_usage
        (rating_run_id,ledger_entry_id,cost_model_id,category,quantity,unit,rate,amount,currency,confidence,dimensions_json,formula_json,provenance_hash)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const line of lines) insert.run(id, line.ledgerEntryId, line.costModelId, line.category, line.quantity, line.unit,
        line.rate, line.amount, line.currency, line.confidence, stable(line.dimensions), stable(line.formula), line.provenanceHash);
      return id;
    })();
    return { ...this.ratingRun(runId, actor), duplicate: false };
  }
  ratingRun(id, actor) {
    this._admin(actor); const db = this._db(); const row = db.prepare('SELECT * FROM finops_rating_runs WHERE id=?').get(integer(id, 'ratingRunId', 1));
    if (!row) throw fail('Rating run not found', 404, 'RATING_RUN_NOT_FOUND');
    const lines = db.prepare('SELECT * FROM finops_rated_usage WHERE rating_run_id=? ORDER BY id').all(row.id).map(item => this._lineRow(item));
    return { id: row.id, periodStart: row.period_start, periodEnd: row.period_end, currency: row.currency, state: row.state,
      inputHash: row.input_hash, totalCost: row.total_cost, summary: parse(row.summary_json, {}), lines,
      budgets: this._budgetStates(row, lines), billingTransactionCreated: false, createdAt: row.created_at };
  }
  ratingRuns(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM finops_rating_runs ORDER BY id DESC LIMIT 100').all().map(row => ({
    id: row.id, periodStart: row.period_start, periodEnd: row.period_end, currency: row.currency, state: row.state,
    inputHash: row.input_hash, totalCost: row.total_cost, summary: parse(row.summary_json, {}), billingTransactionCreated: false, createdAt: row.created_at })); }

  saveBudget(body = {}, actor) {
    this._admin(actor); const name = text(body.name, 'name', 160, SAFE_NAME); const cadence = body.cadence;
    if (!['monthly','quarterly'].includes(cadence)) throw fail('cadence is invalid'); const scopeType = body.scopeType || 'global';
    if (!['global','cost_center','business_unit','application','environment','project','site'].includes(scopeType)) throw fail('scopeType is invalid');
    const scopeValue = scopeType === 'global' ? null : text(body.scopeValue, 'scopeValue', 200, SAFE_REF);
    const amount = number(body.amount, 'amount', 0.000001); const currency = text(body.currency || 'USD', 'currency', 3, /^[A-Z]{3}$/);
    const effectiveFrom = timestamp(body.effectiveFrom, 'effectiveFrom'); const effectiveTo = body.effectiveTo == null ? null : timestamp(body.effectiveTo, 'effectiveTo');
    if (effectiveTo && effectiveTo <= effectiveFrom) throw fail('effectiveTo must be after effectiveFrom'); const active = body.active !== false;
    const normalized = { name, cadence, scopeType, scopeValue, amount, currency, effectiveFrom, effectiveTo, active }; const budgetHash = hash(normalized); const db = this._db();
    const existing = db.prepare('SELECT * FROM finops_budgets WHERE budget_hash=?').get(budgetHash); if (existing) return this._budgetRow(existing);
    const saved = db.prepare(`INSERT INTO finops_budgets
      (name,cadence,scope_type,scope_value,amount,currency,effective_from,effective_to,active,budget_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(name, cadence, scopeType, scopeValue, amount, currency, effectiveFrom, effectiveTo, active ? 1 : 0, budgetHash, actor.id);
    return this._budgetRow(db.prepare('SELECT * FROM finops_budgets WHERE id=?').get(saved.lastInsertRowid));
  }
  _budgetRow(row) { return row && { id: row.id, name: row.name, cadence: row.cadence, scopeType: row.scope_type,
    scopeValue: row.scope_value, amount: row.amount, currency: row.currency, effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to, active: !!row.active, budgetHash: row.budget_hash, createdAt: row.created_at }; }
  budgets(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM finops_budgets ORDER BY active DESC,id DESC').all().map(row => this._budgetRow(row)); }
  _budgetStates(run, lines) {
    const durationDays = (new Date(run.period_end) - new Date(run.period_start)) / 86400000;
    return this._db().prepare(`SELECT * FROM finops_budgets WHERE active=1 AND currency=? AND effective_from<=?
      AND (effective_to IS NULL OR effective_to>=?) ORDER BY id`).all(run.currency, run.period_start, run.period_end).map(row => {
      const budget = this._budgetRow(row); const dimensionKey = { cost_center: 'costCenter', business_unit: 'businessUnit',
        application: 'application', environment: 'environment', project: 'project', site: 'site' }[budget.scopeType];
      const scoped = budget.scopeType === 'global' ? lines : lines.filter(line => line.dimensions[dimensionKey] === budget.scopeValue);
      const spent = round(scoped.reduce((sum, line) => sum + line.amount, 0));
      const periodAmount = round(budget.amount * durationDays / (budget.cadence === 'monthly' ? 30.4375 : 91.3125));
      const utilizationPercent = periodAmount ? round(spent / periodAmount * 100) : 0;
      return { ...budget, periodAmount, spent, remaining: round(periodAmount - spent), utilizationPercent,
        state: spent > periodAmount ? 'over' : 'within', alertsCreated: 0 };
    });
  }

  createChargebackExport(runId, body = {}, actor) {
    this._admin(actor); const format = body.format || 'csv'; if (!['csv','json'].includes(format)) throw fail('format is invalid');
    const run = this.ratingRun(runId, actor); const rows = run.lines.map(line => ({ periodStart: run.periodStart, periodEnd: run.periodEnd,
      resourceType: line.dimensions.resourceType, resourceRef: line.dimensions.resourceRef, costCenter: line.dimensions.costCenter || 'unallocated',
      businessUnit: line.dimensions.businessUnit || '', application: line.dimensions.application || '', environment: line.dimensions.environment || '',
      category: line.category, quantity: line.quantity, unit: line.unit, rate: line.rate, amount: line.amount,
      currency: line.currency, confidence: line.confidence, provenanceHash: line.provenanceHash }));
    const headers = ['periodStart','periodEnd','resourceType','resourceRef','costCenter','businessUnit','application','environment',
      'category','quantity','unit','rate','amount','currency','confidence','provenanceHash'];
    const content = format === 'json' ? stable(rows) : [headers.join(','), ...rows.map(row => headers.map(key => csvCell(row[key])).join(','))].join('\n') + '\n';
    const exportHash = hash({ runInputHash: run.inputHash, format, content }); const db = this._db();
    db.prepare(`INSERT OR IGNORE INTO finops_chargeback_exports
      (rating_run_id,format,export_hash,row_count,total_cost,metadata_json,created_by) VALUES (?,?,?,?,?,?,?)`)
      .run(run.id, format, exportHash, rows.length, run.totalCost, stable({ filename: `chargeback-${run.id}.${format}`,
        contentType: format === 'csv' ? 'text/csv' : 'application/json' }), actor.id);
    const row = db.prepare('SELECT * FROM finops_chargeback_exports WHERE rating_run_id=? AND format=?').get(run.id, format);
    return { export: this._exportRow(row), content, billingTransactionCreated: false };
  }
  _exportRow(row) { return row && { id: row.id, ratingRunId: row.rating_run_id, format: row.format, state: row.state,
    exportHash: row.export_hash, rowCount: row.row_count, totalCost: row.total_cost, metadata: parse(row.metadata_json, {}),
    billingTransactionCreated: false, createdAt: row.created_at }; }
  exports(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM finops_chargeback_exports ORDER BY id DESC LIMIT 100').all().map(row => this._exportRow(row)); }

  overview(actor) {
    this._admin(actor); const ledger = this.ledger(actor); const models = this.costModels(actor); const allocationsValue = this.allocations(actor);
    const runs = this.ratingRuns(actor); const latest = runs[0] ? this.ratingRun(runs[0].id, actor) : null; const budgetsValue = this.budgets(actor);
    const allocated = allocationsValue.filter(item => item.state === 'allocated').length;
    return { capabilities: { unifiedResourceLedger: true, privateCloudCostModel: true, providerLicenseCostModel: true,
      storageTierCostModel: true, networkPublicIpCostModel: true, gpuAcceleratorCostModel: true, tagBasedAllocation: true,
      showbackDashboard: true, chargebackExport: true, budgets: true }, ledger, costModels: models,
    allocationRules: this.allocationRules(actor), allocations: allocationsValue, ratingRuns: runs, chargebackExports: this.exports(actor),
    budgets: budgetsValue, latestShowback: latest, summary: { ledgerEntries: ledger.length, costModels: models.length,
      allocationCoverage: allocationsValue.length ? round(allocated / allocationsValue.length) : 0,
      latestRatedCost: latest?.totalCost || 0, currency: latest?.currency || models[0]?.currency || null,
      overBudget: latest?.budgets.filter(item => item.state === 'over').length || 0,
      billingTransactionsCreated: 0 } };
  }
}

const service = new FinOpsFoundationService();
module.exports = service;
module.exports.FinOpsFoundationService = FinOpsFoundationService;
module.exports.FinOpsError = FinOpsError;
module.exports._internals = { canonical, stable, hash, globMatch, csvCell, round };
