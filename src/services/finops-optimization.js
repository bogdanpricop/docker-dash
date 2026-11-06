'use strict';

const crypto = require('crypto');
const { getDb } = require('../db');
const { FinOpsFoundationService } = require('./finops-foundation');

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_. -]{0,159}$/;
const SAFE_REF = /^[a-zA-Z0-9][a-zA-Z0-9_.:+/@* -]{0,499}$/;
const SECRET_KEY = /password|secret|token|credential|private.?key|authorization|cookie|license.?key/i;

class FinOpsOptimizationError extends Error {
  constructor(message, status = 400, code = 'FINOPS_OPTIMIZATION_ERROR', details) {
    super(message); this.name = 'FinOpsOptimizationError'; this.status = status; this.code = code; this.details = details;
  }
}
const fail = (message, status, code, details) => new FinOpsOptimizationError(message, status, code, details);
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
  const result = new Date(value); if (Number.isNaN(result.getTime())) throw fail(`${key} must be an ISO timestamp`); return result.toISOString();
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
function numeric(value, key, fields, positive = false) {
  const input = object(value); const result = {};
  for (const field of fields) {
    if (input[field] == null) throw fail(`${key}.${field} is required`);
    result[field] = number(input[field], `${key}.${field}`, positive ? 0.000001 : 0);
  }
  for (const field of Object.keys(input)) if (!fields.includes(field)) throw fail(`${key}.${field} is unsupported`);
  return canonical(result);
}
function confidence(coverage, samples = 1) {
  return coverage >= 90 && samples >= 6 ? 'high' : coverage >= 60 && samples >= 3 ? 'medium' : coverage > 0 ? 'low' : 'unknown';
}

class FinOpsOptimizationService {
  constructor(dbProvider = getDb, options = {}) {
    this._dbProvider = dbProvider; this._foundation = new FinOpsFoundationService(dbProvider);
    this._savingsAdapters = options.savingsAdapters || {};
  }
  _db() { return this._dbProvider(); }
  _admin(actor) {
    if (!actor?.id) throw fail('Authenticated user is required', 401, 'AUTH_REQUIRED');
    if (actor.role !== 'admin') throw fail('Administrator permission is required', 403, 'GOVERNANCE_FORBIDDEN');
  }
  _budgetPolicy(row) { return row && { id: row.id, name: row.name, budgetId: row.budget_id,
    thresholds: parse(row.thresholds_json, []), forecastEnabled: !!row.forecast_enabled,
    channels: parse(row.channels_json, []), active: !!row.active, policyHash: row.policy_hash, createdAt: row.created_at }; }
  saveBudgetAlertPolicy(body = {}, actor) {
    this._admin(actor); const name = text(body.name, 'name', 160, SAFE_NAME);
    const budgetId = body.budgetId == null ? null : integer(body.budgetId, 'budgetId', 1); const db = this._db();
    if (budgetId && !db.prepare('SELECT 1 FROM finops_budgets WHERE id=?').get(budgetId)) throw fail('Budget not found', 404, 'BUDGET_NOT_FOUND');
    if (!Array.isArray(body.thresholds) || !body.thresholds.length || body.thresholds.length > 6) throw fail('thresholds must contain 1-6 values');
    const thresholds = [...new Set(body.thresholds.map((value, index) => number(value, `thresholds[${index}]`, 1, 200)))].sort((a, b) => a - b);
    const channels = [...new Set((body.channels || ['in_app']).map((value, index) => text(value, `channels[${index}]`, 40, SAFE_NAME)))];
    if (!channels.length || channels.some(value => !['in_app','email','webhook'].includes(value))) throw fail('channels contain an unsupported value');
    const normalized = { name, budgetId, thresholds, forecastEnabled: body.forecastEnabled !== false, channels, active: body.active !== false };
    const policyHash = hash(normalized);
    db.prepare(`INSERT INTO finops_budget_alert_policies
      (name,budget_id,thresholds_json,forecast_enabled,channels_json,active,policy_hash,created_by) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET budget_id=excluded.budget_id,thresholds_json=excluded.thresholds_json,
      forecast_enabled=excluded.forecast_enabled,channels_json=excluded.channels_json,active=excluded.active,
      policy_hash=excluded.policy_hash,created_by=excluded.created_by,updated_at=datetime('now')`)
      .run(name, budgetId, stable(thresholds), normalized.forecastEnabled ? 1 : 0, stable(channels), normalized.active ? 1 : 0, policyHash, actor.id);
    return this._budgetPolicy(db.prepare('SELECT * FROM finops_budget_alert_policies WHERE name=?').get(name));
  }
  budgetAlertPolicies(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM finops_budget_alert_policies ORDER BY id DESC').all().map(row => this._budgetPolicy(row)); }
  evaluateBudgetAlerts(runId, actor) {
    this._admin(actor); const run = this._foundation.ratingRun(runId, actor); const durationDays = (new Date(run.periodEnd) - new Date(run.periodStart)) / 86400000;
    const policies = this.budgetAlertPolicies(actor).filter(item => item.active); const db = this._db(); let created = 0;
    const insert = db.prepare(`INSERT OR IGNORE INTO finops_budget_alerts
      (policy_id,budget_id,rating_run_id,signal,threshold_percent,observed_percent,severity,evidence_json,fingerprint)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    for (const budget of run.budgets) for (const policy of policies.filter(item => !item.budgetId || item.budgetId === budget.id)) {
      const actualPercent = round(budget.amount ? budget.spent / budget.amount * 100 : 0);
      const cadenceDays = budget.cadence === 'monthly' ? 30.4375 : 91.3125;
      const forecastPercent = round(durationDays > 0 && budget.amount ? (budget.spent / durationDays * cadenceDays) / budget.amount * 100 : 0);
      for (const threshold of policy.thresholds) {
        const signals = [{ signal: 'actual', value: actualPercent }, ...(policy.forecastEnabled ? [{ signal: 'forecast', value: forecastPercent }] : [])];
        for (const item of signals) if (item.value >= threshold) {
          const severity = threshold >= 100 ? 'critical' : threshold >= 80 ? 'warning' : 'info';
          const evidence = { budgetName: budget.name, cadence: budget.cadence, spent: budget.spent, budgetAmount: budget.amount,
            durationDays: round(durationDays), channels: policy.channels, projectedFullPeriod: item.signal === 'forecast' };
          const fingerprint = hash({ policyId: policy.id, budgetId: budget.id, ratingRunId: run.id, signal: item.signal, threshold });
          created += insert.run(policy.id, budget.id, run.id, item.signal, threshold, item.value, severity, stable(evidence), fingerprint).changes;
        }
      }
    }
    return { ratingRunId: run.id, created, alerts: this.budgetAlerts(actor).filter(item => item.ratingRunId === run.id),
      notificationsQueued: created, providerMutationsStarted: 0 };
  }
  budgetAlerts(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM finops_budget_alerts ORDER BY id DESC LIMIT 500').all().map(row => ({
    id: row.id, policyId: row.policy_id, budgetId: row.budget_id, ratingRunId: row.rating_run_id, signal: row.signal,
    thresholdPercent: row.threshold_percent, observedPercent: row.observed_percent, severity: row.severity,
    notificationState: row.notification_state, evidence: parse(row.evidence_json, {}), fingerprint: row.fingerprint, createdAt: row.created_at })); }

  _anomalyPolicy(row) { return row && { id: row.id, name: row.name, scopeType: row.scope_type, scopeValue: row.scope_value,
    baselineRuns: row.baseline_runs, minimumDeviationPercent: row.minimum_deviation_percent, minimumAmount: row.minimum_amount,
    active: !!row.active, policyHash: row.policy_hash, createdAt: row.created_at }; }
  saveAnomalyPolicy(body = {}, actor) {
    this._admin(actor); const name = text(body.name, 'name', 160, SAFE_NAME); const scopeType = body.scopeType || 'global';
    if (!['global','category','cost_center'].includes(scopeType)) throw fail('scopeType is invalid');
    const scopeValue = scopeType === 'global' ? null : text(body.scopeValue, 'scopeValue', 200, SAFE_REF);
    const normalized = { name, scopeType, scopeValue, baselineRuns: integer(body.baselineRuns ?? 6, 'baselineRuns', 2, 24),
      minimumDeviationPercent: number(body.minimumDeviationPercent ?? 30, 'minimumDeviationPercent', 0.000001, 10000),
      minimumAmount: number(body.minimumAmount ?? 0, 'minimumAmount'), active: body.active !== false };
    const policyHash = hash(normalized); const db = this._db();
    db.prepare(`INSERT INTO finops_cost_anomaly_policies
      (name,scope_type,scope_value,baseline_runs,minimum_deviation_percent,minimum_amount,active,policy_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET scope_type=excluded.scope_type,scope_value=excluded.scope_value,
      baseline_runs=excluded.baseline_runs,minimum_deviation_percent=excluded.minimum_deviation_percent,
      minimum_amount=excluded.minimum_amount,active=excluded.active,policy_hash=excluded.policy_hash,created_by=excluded.created_by`)
      .run(name, scopeType, scopeValue, normalized.baselineRuns, normalized.minimumDeviationPercent, normalized.minimumAmount,
        normalized.active ? 1 : 0, policyHash, actor.id);
    return this._anomalyPolicy(db.prepare('SELECT * FROM finops_cost_anomaly_policies WHERE name=?').get(name));
  }
  anomalyPolicies(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM finops_cost_anomaly_policies ORDER BY id DESC').all().map(row => this._anomalyPolicy(row)); }
  _scopedAmount(run, policy) {
    if (policy.scopeType === 'global') return run.totalCost;
    if (policy.scopeType === 'category') return run.summary.byCategory?.[policy.scopeValue] || 0;
    return run.summary.byCostCenter?.[policy.scopeValue] || 0;
  }
  evaluateCostAnomalies(runId, actor) {
    this._admin(actor); const current = this._foundation.ratingRun(runId, actor); const db = this._db(); let created = 0;
    const policies = this.anomalyPolicies(actor).filter(item => item.active); const evaluations = [];
    for (const policy of policies) {
      const priorRows = db.prepare('SELECT id FROM finops_rating_runs WHERE id<? AND currency=? ORDER BY id DESC LIMIT ?')
        .all(current.id, current.currency, policy.baselineRuns);
      if (priorRows.length < 2) { evaluations.push({ policyId: policy.id, state: 'insufficient_baseline', baselineRuns: priorRows.length }); continue; }
      const baselineValues = priorRows.map(row => this._scopedAmount(this._foundation.ratingRun(row.id, actor), policy));
      const baselineAmount = baselineValues.reduce((sum, value) => sum + value, 0) / baselineValues.length;
      const currentAmount = this._scopedAmount(current, policy);
      if (baselineAmount <= 0 || currentAmount < policy.minimumAmount) { evaluations.push({ policyId: policy.id, state: 'below_floor' }); continue; }
      const deviationPercent = round(Math.abs(currentAmount - baselineAmount) / baselineAmount * 100);
      if (deviationPercent < policy.minimumDeviationPercent) { evaluations.push({ policyId: policy.id, state: 'normal', deviationPercent }); continue; }
      const direction = currentAmount >= baselineAmount ? 'increase' : 'decrease'; const evidence = { scopeType: policy.scopeType,
        scopeValue: policy.scopeValue, currentRunId: current.id, baselineRunIds: priorRows.map(row => row.id), baselineValues };
      const fingerprint = hash({ policyId: policy.id, ratingRunId: current.id, direction, currentAmount, baselineAmount: round(baselineAmount) });
      const result = db.prepare(`INSERT OR IGNORE INTO finops_cost_anomalies
        (policy_id,rating_run_id,direction,current_amount,baseline_amount,deviation_percent,confidence,evidence_json,fingerprint)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(policy.id, current.id, direction, currentAmount, round(baselineAmount), deviationPercent,
        confidence(100, priorRows.length), stable(evidence), fingerprint);
      created += result.changes; evaluations.push({ policyId: policy.id, state: 'anomaly', direction, deviationPercent });
    }
    return { ratingRunId: current.id, created, evaluations, anomalies: this.costAnomalies(actor).filter(item => item.ratingRunId === current.id), providerMutationsStarted: 0 };
  }
  costAnomalies(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM finops_cost_anomalies ORDER BY id DESC LIMIT 500').all().map(row => ({
    id: row.id, policyId: row.policy_id, ratingRunId: row.rating_run_id, direction: row.direction,
    currentAmount: row.current_amount, baselineAmount: row.baseline_amount, deviationPercent: row.deviation_percent,
    confidence: row.confidence, evidence: parse(row.evidence_json, {}), fingerprint: row.fingerprint, createdAt: row.created_at })); }

  _ledger(id) {
    const row = this._db().prepare('SELECT * FROM finops_resource_ledger WHERE id=?').get(integer(id, 'ledgerEntryId', 1));
    if (!row) throw fail('Ledger entry not found', 404, 'LEDGER_ENTRY_NOT_FOUND');
    return { id: row.id, resourceType: row.resource_type, resourceRef: row.resource_ref, allocation: parse(row.allocation_json, {}),
      usage: parse(row.usage_json, {}), tags: parse(row.tags_json, {}), entryHash: row.entry_hash, intervalStart: row.interval_start, intervalEnd: row.interval_end };
  }
  _saveAssessment(type, entry, state, owner, criticality, evidence, recommendation, assessmentConfidence, actor) {
    const normalized = { type, ledgerEntryId: entry?.id || null, resourceType: entry.resourceType, resourceRef: entry.resourceRef,
      state, owner: owner || null, criticality: criticality || null, confidence: assessmentConfidence, evidence: canonical(evidence),
      recommendation: canonical(recommendation) };
    bounded(normalized, 'assessment'); secretFree(normalized, 'assessment'); const assessmentHash = hash(normalized); const db = this._db();
    db.prepare(`INSERT OR IGNORE INTO finops_optimization_assessments
      (assessment_type,ledger_entry_id,resource_type,resource_ref,state,owner,criticality,confidence,evidence_json,recommendation_json,assessment_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(type, normalized.ledgerEntryId, normalized.resourceType, normalized.resourceRef, state,
      normalized.owner, normalized.criticality, assessmentConfidence, stable(evidence), stable(recommendation), assessmentHash, actor.id);
    const row = db.prepare('SELECT * FROM finops_optimization_assessments WHERE assessment_hash=?').get(assessmentHash);
    return this._assessment(row);
  }
  _assessment(row) { return row && { id: row.id, type: row.assessment_type, ledgerEntryId: row.ledger_entry_id,
    resourceType: row.resource_type, resourceRef: row.resource_ref, state: row.state, owner: row.owner,
    criticality: row.criticality, confidence: row.confidence, evidence: parse(row.evidence_json, {}),
    recommendation: parse(row.recommendation_json, {}), assessmentHash: row.assessment_hash,
    providerMutationsStarted: 0, createdAt: row.created_at }; }
  assessIdleVm(ledgerId, body = {}, actor) {
    this._admin(actor); const entry = this._ledger(ledgerId); if (entry.resourceType !== 'vm') throw fail('Idle assessment requires a VM ledger entry');
    const cpuThreshold = number(body.cpuThresholdPercent ?? 10, 'cpuThresholdPercent', 0, 100);
    const ramThreshold = number(body.ramThresholdPercent ?? 20, 'ramThresholdPercent', 0, 100);
    const minimumUptimeHours = number(body.minimumUptimeHours ?? 168, 'minimumUptimeHours'); const coverage = number(body.dataCoveragePercent ?? 0, 'dataCoveragePercent', 0, 100);
    const owner = body.owner || entry.tags.owner || null; const criticality = body.criticality || entry.tags.criticality || 'unknown';
    const cpuPercent = entry.allocation.vCpu ? (entry.usage.usedVcpu ?? 0) / entry.allocation.vCpu * 100 : null;
    const ramPercent = entry.allocation.ramGb ? (entry.usage.usedRamGb ?? 0) / entry.allocation.ramGb * 100 : null;
    const uptimeHours = entry.usage.uptimeHours; let state;
    if (['critical','protected'].includes(String(criticality).toLowerCase())) state = 'protected';
    else if (cpuPercent == null || ramPercent == null || uptimeHours == null || coverage < 30) state = 'insufficient_evidence';
    else state = cpuPercent <= cpuThreshold && ramPercent <= ramThreshold && uptimeHours >= minimumUptimeHours ? 'idle_candidate' : 'active';
    const evidence = { entryHash: entry.entryHash, cpuPercent: round(cpuPercent || 0), ramPercent: round(ramPercent || 0),
      uptimeHours: uptimeHours ?? null, dataCoveragePercent: coverage, thresholds: { cpuThreshold, ramThreshold, minimumUptimeHours }, ownerPresent: !!owner };
    const recommendation = state === 'idle_candidate' ? { action: 'review_off_hours_schedule', autoStop: false,
      requiresOwner: !owner, savingsRequiresRatedUsage: true } : { action: 'none', reason: state };
    return this._saveAssessment('idle_vm', entry, state, owner, criticality, evidence, recommendation, confidence(coverage, 7), actor);
  }
  assessOversizedVm(ledgerId, body = {}, actor) {
    this._admin(actor); const entry = this._ledger(ledgerId); if (entry.resourceType !== 'vm') throw fail('Oversize assessment requires a VM ledger entry');
    const headroomPercent = number(body.headroomPercent ?? 30, 'headroomPercent', 0, 300); const minimumReductionPercent = number(body.minimumReductionPercent ?? 20, 'minimumReductionPercent', 0, 100);
    const coverage = number(body.dataCoveragePercent ?? 0, 'dataCoveragePercent', 0, 100); const observationDays = integer(body.observationDays ?? 1, 'observationDays', 1, 366);
    const peakVcpu = entry.usage.peakVcpu; const peakRamGb = entry.usage.peakRamGb; const factor = 1 + headroomPercent / 100;
    const suggestedVcpu = peakVcpu == null ? null : Math.max(1, Math.ceil(peakVcpu * factor));
    const suggestedRamGb = peakRamGb == null ? null : Math.max(1, Math.ceil(peakRamGb * factor));
    const cpuReduction = suggestedVcpu == null || !entry.allocation.vCpu ? 0 : (entry.allocation.vCpu - suggestedVcpu) / entry.allocation.vCpu * 100;
    const ramReduction = suggestedRamGb == null || !entry.allocation.ramGb ? 0 : (entry.allocation.ramGb - suggestedRamGb) / entry.allocation.ramGb * 100;
    const criticality = body.criticality || entry.tags.criticality || 'unknown'; const owner = body.owner || entry.tags.owner || null; let state;
    if (peakVcpu == null || peakRamGb == null || coverage < 60 || observationDays < 7) state = 'insufficient_peak_evidence';
    else if (['critical','protected'].includes(String(criticality).toLowerCase()) && observationDays < 30) state = 'peak_guard_blocked';
    else state = Math.max(cpuReduction, ramReduction) >= minimumReductionPercent ? 'oversized_candidate' : 'right_sized';
    const evidence = { entryHash: entry.entryHash, peakVcpu: peakVcpu ?? null, peakRamGb: peakRamGb ?? null,
      allocatedVcpu: entry.allocation.vCpu ?? null, allocatedRamGb: entry.allocation.ramGb ?? null, coverage, observationDays,
      headroomPercent, minimumReductionPercent, peakGuardApplied: true };
    const recommendation = state === 'oversized_candidate' ? { suggestedVcpu, suggestedRamGb, cpuReductionPercent: round(cpuReduction),
      ramReductionPercent: round(ramReduction), applyAutomatically: false } : { action: 'none', reason: state };
    return this._saveAssessment('oversized_vm', entry, state, owner, criticality, evidence, recommendation, confidence(coverage, observationDays), actor);
  }
  assessZombieResource(body = {}, actor) {
    this._admin(actor); const resourceType = text(body.resourceType, 'resourceType', 40, SAFE_NAME);
    if (!['disk','snapshot','ip','template','backup'].includes(resourceType)) throw fail('resourceType is invalid');
    const resourceRef = text(body.resourceRef, 'resourceRef'); const lastUsedAt = timestamp(body.lastUsedAt, 'lastUsedAt');
    const observedAt = timestamp(body.observedAt || new Date().toISOString(), 'observedAt'); const staleDays = integer(body.staleDays ?? 30, 'staleDays', 1, 3650);
    const ageDays = (new Date(observedAt) - new Date(lastUsedAt)) / 86400000; if (ageDays < 0) throw fail('lastUsedAt cannot be after observedAt');
    const owner = body.owner ? text(body.owner, 'owner', 200, SAFE_REF) : null; const criticality = body.criticality || 'unknown';
    const attached = body.attached === true; const protectedResource = body.protected === true;
    const state = protectedResource || ['critical','protected'].includes(String(criticality).toLowerCase()) ? 'protected'
      : attached ? 'in_use' : ageDays >= staleDays ? 'zombie_candidate' : 'recent';
    const evidence = canonical(object(body.evidence)); bounded(evidence, 'evidence'); secretFree(evidence, 'evidence');
    const entry = { id: null, resourceType, resourceRef };
    return this._saveAssessment('zombie_resource', entry, state, owner, criticality,
      { lastUsedAt, observedAt, ageDays: round(ageDays), staleDays, attached, protected: protectedResource, source: evidence },
      state === 'zombie_candidate' ? { action: 'owner_review_then_cleanup', autoDelete: false } : { action: 'none', reason: state },
      body.lastUsedAt ? 'medium' : 'unknown', actor);
  }
  assessments(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM finops_optimization_assessments ORDER BY id DESC LIMIT 1000').all().map(row => this._assessment(row)); }

  _schedule(row) { return row && { id: row.id, name: row.name, resourceRef: row.resource_ref, timezone: row.timezone,
    weekdays: parse(row.weekdays_json, []), offHoursStart: row.off_hours_start, offHoursEnd: row.off_hours_end,
    mode: row.mode, adapterKey: row.adapter_key, owner: row.owner, active: !!row.active, scheduleHash: row.schedule_hash,
    createdAt: row.created_at }; }
  saveSavingsSchedule(body = {}, actor) {
    this._admin(actor); const name = text(body.name, 'name', 160, SAFE_NAME); const resourceRef = text(body.resourceRef, 'resourceRef');
    const timezone = text(body.timezone, 'timezone', 100, /^[a-zA-Z0-9_+/-]+$/);
    try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date()); } catch { throw fail('timezone must be a valid IANA zone'); }
    if (!Array.isArray(body.weekdays) || !body.weekdays.length) throw fail('weekdays must not be empty');
    const weekdays = [...new Set(body.weekdays.map((value, index) => integer(value, `weekdays[${index}]`, 1, 7)))].sort();
    const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/; const offHoursStart = text(body.offHoursStart, 'offHoursStart', 5, timePattern);
    const offHoursEnd = text(body.offHoursEnd, 'offHoursEnd', 5, timePattern); if (offHoursStart === offHoursEnd) throw fail('Off-hours window cannot be zero length');
    const mode = body.mode || 'recommend'; if (!['recommend','automate'].includes(mode)) throw fail('mode is invalid');
    const adapterKey = text(body.adapterKey || 'provider', 'adapterKey', 120, SAFE_NAME).toLowerCase(); const owner = text(body.owner, 'owner', 200, SAFE_REF);
    const normalized = { name, resourceRef, timezone, weekdays, offHoursStart, offHoursEnd, mode, adapterKey, owner, active: body.active !== false };
    const scheduleHash = hash(normalized); const db = this._db();
    db.prepare(`INSERT INTO finops_savings_schedules
      (name,resource_ref,timezone,weekdays_json,off_hours_start,off_hours_end,mode,adapter_key,owner,active,schedule_hash,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET resource_ref=excluded.resource_ref,timezone=excluded.timezone,
      weekdays_json=excluded.weekdays_json,off_hours_start=excluded.off_hours_start,off_hours_end=excluded.off_hours_end,
      mode=excluded.mode,adapter_key=excluded.adapter_key,owner=excluded.owner,active=excluded.active,
      schedule_hash=excluded.schedule_hash,created_by=excluded.created_by,updated_at=datetime('now')`)
      .run(name, resourceRef, timezone, stable(weekdays), offHoursStart, offHoursEnd, mode, adapterKey, owner,
        normalized.active ? 1 : 0, scheduleHash, actor.id);
    return this._schedule(db.prepare('SELECT * FROM finops_savings_schedules WHERE name=?').get(name));
  }
  schedules(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM finops_savings_schedules ORDER BY id DESC').all().map(row => this._schedule(row)); }
  async executeSavingsSchedule(id, body = {}, actor) {
    this._admin(actor); const db = this._db(); const schedule = this._schedule(db.prepare('SELECT * FROM finops_savings_schedules WHERE id=?').get(integer(id, 'scheduleId', 1)));
    if (!schedule || !schedule.active) throw fail('Active savings schedule not found', 404, 'SAVINGS_SCHEDULE_NOT_FOUND');
    const action = body.action; if (!['stop','start'].includes(action)) throw fail('action is invalid'); const scheduledAt = timestamp(body.scheduledAt, 'scheduledAt');
    const executionHash = hash({ scheduleHash: schedule.scheduleHash, action, scheduledAt });
    const existing = db.prepare('SELECT * FROM finops_savings_executions WHERE execution_hash=?').get(executionHash);
    if (existing) return this._execution(existing);
    if (schedule.mode === 'recommend') {
      db.prepare(`INSERT INTO finops_savings_executions
        (schedule_id,action,scheduled_at,state,evidence_json,execution_hash,created_by,completed_at) VALUES (?,?,?,'recommended',?,?,?,datetime('now'))`)
        .run(schedule.id, action, scheduledAt, stable({ reason: 'Policy is recommendation-only', providerMutationStarted: false }), executionHash, actor.id);
      return this._execution(db.prepare('SELECT * FROM finops_savings_executions WHERE execution_hash=?').get(executionHash));
    }
    const adapter = this._savingsAdapters[schedule.adapterKey];
    if (!adapter) {
      db.prepare(`INSERT INTO finops_savings_executions
        (schedule_id,action,scheduled_at,state,evidence_json,execution_hash,created_by,completed_at) VALUES (?,?,?,'unsupported',?,?,?,datetime('now'))`)
        .run(schedule.id, action, scheduledAt, stable({ reason: `No savings adapter is registered for ${schedule.adapterKey}`, providerMutationStarted: false }), executionHash, actor.id);
      return this._execution(db.prepare('SELECT * FROM finops_savings_executions WHERE execution_hash=?').get(executionHash));
    }
    const operationId = text(body.operationId, 'operationId', 80, /^op_[a-f0-9]{26}$/); const approvalId = integer(body.approvalId, 'approvalId', 1);
    if (body.confirmation !== `EXECUTE SAVINGS ${schedule.id}`) throw fail('Typed confirmation does not match');
    const operation = db.prepare('SELECT id,state FROM provider_operations WHERE id=?').get(operationId);
    if (!operation || !['queued','running','reconciling','succeeded'].includes(operation.state)) throw fail('Active durable operation is required', 409, 'DURABLE_OPERATION_REQUIRED');
    const approvalHash = hash({ scheduleId: schedule.id, scheduleHash: schedule.scheduleHash, action, scheduledAt });
    const approval = db.prepare(`SELECT id FROM infrastructure_approval_requests
      WHERE id=? AND action_key='finops.schedule.power' AND target_id=? AND payload_hash=? AND state='approved'`).get(approvalId, String(schedule.id), approvalHash);
    if (!approval) throw fail('Matching approved savings request is required', 409, 'SAVINGS_APPROVAL_REQUIRED');
    let evidence; let state;
    try {
      evidence = canonical(object(await adapter({ schedule, action, scheduledAt, operationId }))); bounded(evidence, 'adapterEvidence'); secretFree(evidence, 'adapterEvidence');
      state = evidence.applied === true && evidence.verified === true ? 'succeeded' : 'failed';
    } catch (error) { evidence = { error: String(error.message || error).slice(0, 500), applied: false, verified: false }; state = 'failed'; }
    db.prepare(`INSERT INTO finops_savings_executions
      (schedule_id,action,scheduled_at,state,operation_id,approval_id,evidence_json,execution_hash,created_by,completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))`).run(schedule.id, action, scheduledAt, state, operationId, approvalId, stable(evidence), executionHash, actor.id);
    return this._execution(db.prepare('SELECT * FROM finops_savings_executions WHERE execution_hash=?').get(executionHash));
  }
  _execution(row) { return row && { id: row.id, scheduleId: row.schedule_id, action: row.action, scheduledAt: row.scheduled_at,
    state: row.state, operationId: row.operation_id, approvalId: row.approval_id, evidence: parse(row.evidence_json, {}),
    executionHash: row.execution_hash, providerMutationStarted: row.state === 'succeeded', createdAt: row.created_at }; }
  executions(actor) { this._admin(actor); return this._db().prepare('SELECT * FROM finops_savings_executions ORDER BY id DESC LIMIT 500').all().map(row => this._execution(row)); }

  recommendReservedCapacity(body = {}, actor) {
    this._admin(actor); const scopeRef = text(body.scopeRef, 'scopeRef'); const fields = ['vCpu','ramGb'];
    const capacity = numeric(body.currentCapacity, 'currentCapacity', fields, true); const peak = numeric(body.peakDemand, 'peakDemand', fields);
    const forecast = numeric(body.forecastDemand, 'forecastDemand', fields); const headroomPercent = number(body.headroomPercent ?? 20, 'headroomPercent', 0, 300);
    if (!Array.isArray(body.options) || !body.options.length || body.options.length > 50) throw fail('options must contain 1-50 values');
    const required = Object.fromEntries(fields.map(field => [field, round(Math.max(peak[field], forecast[field]) * (1 + headroomPercent / 100))]));
    const shortage = Object.fromEntries(fields.map(field => [field, round(Math.max(0, required[field] - capacity[field]))]));
    const options = body.options.map((item, index) => { const value = object(item); const type = value.type;
      if (!['on_prem','cloud_commitment'].includes(type)) throw fail(`options[${index}].type is invalid`);
      const optionCapacity = numeric(value.capacity, `options[${index}].capacity`, fields);
      return { name: text(value.name, `options[${index}].name`, 160, SAFE_NAME), type, capacity: optionCapacity,
        monthlyCost: number(value.monthlyCost, `options[${index}].monthlyCost`), termMonths: integer(value.termMonths ?? 1, `options[${index}].termMonths`, 1, 120),
        viable: fields.every(field => optionCapacity[field] >= shortage[field]) };
    }).sort((a, b) => (Number(b.viable) - Number(a.viable)) || a.monthlyCost - b.monthlyCost);
    const selected = shortage.vCpu === 0 && shortage.ramGb === 0 ? null : options.find(item => item.viable) || null;
    const recommendation = { currentCapacity: capacity, peakDemand: peak, forecastDemand: forecast, headroomPercent, required,
      shortage, options, selected, state: shortage.vCpu === 0 && shortage.ramGb === 0 ? 'headroom_sufficient' : selected ? 'recommendation_available' : 'capacity_gap_uncovered' };
    const evidenceHash = hash({ scopeRef, recommendation }); const db = this._db();
    db.prepare('INSERT OR IGNORE INTO finops_reserved_capacity_recommendations (scope_ref,recommendation_json,evidence_hash,created_by) VALUES (?,?,?,?)')
      .run(scopeRef, stable(recommendation), evidenceHash, actor.id);
    const row = db.prepare('SELECT * FROM finops_reserved_capacity_recommendations WHERE evidence_hash=?').get(evidenceHash);
    return { id: row.id, scopeRef: row.scope_ref, ...parse(row.recommendation_json, {}), evidenceHash: row.evidence_hash, purchaseStarted: false, createdAt: row.created_at };
  }
  simulateConsolidation(body = {}, actor) {
    this._admin(actor); const name = text(body.name, 'name', 160, SAFE_NAME); const removedHostRef = text(body.removedHostRef, 'removedHostRef');
    if (!Array.isArray(body.hosts) || body.hosts.length < 2 || body.hosts.length > 100) throw fail('hosts must contain 2-100 values');
    const hosts = body.hosts.map((item, index) => ({ ref: text(item.ref, `hosts[${index}].ref`),
      capacity: numeric(item.capacity, `hosts[${index}].capacity`, ['vCpu','ramGb'], true),
      demand: numeric(item.demand, `hosts[${index}].demand`, ['vCpu','ramGb']), haEligible: item.haEligible !== false }));
    if (!hosts.some(host => host.ref === removedHostRef)) throw fail('removedHostRef is not present');
    const failureToleranceHosts = integer(body.failureToleranceHosts ?? 1, 'failureToleranceHosts', 0, hosts.length - 1);
    const maximumUtilizationPercent = number(body.maximumUtilizationPercent ?? 80, 'maximumUtilizationPercent', 1, 100);
    const remaining = hosts.filter(host => host.ref !== removedHostRef); const fields = ['vCpu','ramGb']; const totals = {};
    for (const field of fields) {
      const capacity = remaining.reduce((sum, host) => sum + host.capacity[field], 0);
      const demand = hosts.reduce((sum, host) => sum + host.demand[field], 0);
      const reserve = remaining.filter(host => host.haEligible).map(host => host.capacity[field]).sort((a, b) => b - a)
        .slice(0, failureToleranceHosts).reduce((sum, value) => sum + value, 0);
      const usable = Math.max(0, capacity - reserve) * maximumUtilizationPercent / 100;
      totals[field] = { capacity, demand, failureReserve: reserve, usable: round(usable), headroom: round(usable - demand), passes: demand <= usable };
    }
    const state = fields.every(field => totals[field].passes) ? 'safe' : 'blocked';
    const result = { hosts: hosts.map(host => host.ref), remainingHosts: remaining.map(host => host.ref), failureToleranceHosts,
      maximumUtilizationPercent, totals, blockers: fields.filter(field => !totals[field].passes).map(field => `${field} capacity/HA headroom`) };
    const scenarioHash = hash({ name, removedHostRef, hosts, failureToleranceHosts, maximumUtilizationPercent }); const db = this._db();
    db.prepare(`INSERT OR IGNORE INTO finops_consolidation_scenarios
      (name,removed_host_ref,state,result_json,scenario_hash,created_by) VALUES (?,?,?,?,?,?)`)
      .run(name, removedHostRef, state, stable(result), scenarioHash, actor.id);
    const row = db.prepare('SELECT * FROM finops_consolidation_scenarios WHERE scenario_hash=?').get(scenarioHash);
    return { id: row.id, name: row.name, removedHostRef: row.removed_host_ref, state: row.state,
      result: parse(row.result_json, {}), scenarioHash: row.scenario_hash, providerMutationsStarted: 0, createdAt: row.created_at };
  }
  forecastCapacity(body = {}, actor) {
    this._admin(actor); const scopeRef = text(body.scopeRef, 'scopeRef'); const horizonDays = integer(body.horizonDays ?? 365, 'horizonDays', 1, 1095);
    const reservePercent = number(body.failureReservePercent ?? 20, 'failureReservePercent', 0, 90);
    if (!Array.isArray(body.observations) || body.observations.length < 3 || body.observations.length > 366) throw fail('observations must contain 3-366 values');
    const fields = ['vCpu','ramGb','storageGb']; const observations = body.observations.map((item, index) => ({
      timestamp: timestamp(item.timestamp, `observations[${index}].timestamp`),
      ...numeric({ vCpu: item.vCpu, ramGb: item.ramGb, storageGb: item.storageGb }, `observations[${index}]`, fields) }));
    observations.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    if (new Set(observations.map(item => item.timestamp)).size !== observations.length) throw fail('Observation timestamps must be unique');
    const capacity = numeric(body.currentCapacity, 'currentCapacity', fields, true); const origin = new Date(observations[0].timestamp).getTime();
    const x = observations.map(item => (new Date(item.timestamp).getTime() - origin) / 86400000); const meanX = x.reduce((a, b) => a + b, 0) / x.length;
    const result = {};
    for (const field of fields) {
      const y = observations.map(item => item[field]); const meanY = y.reduce((a, b) => a + b, 0) / y.length;
      const denominator = x.reduce((sum, value) => sum + (value - meanX) ** 2, 0);
      const slopePerDay = denominator ? x.reduce((sum, value, index) => sum + (value - meanX) * (y[index] - meanY), 0) / denominator : 0;
      const intercept = meanY - slopePerDay * meanX; const latestDay = x[x.length - 1]; const targetDay = latestDay + horizonDays;
      const projected = Math.max(0, intercept + slopePerDay * targetDay); const usableCapacity = capacity[field] * (1 - reservePercent / 100);
      const crossingDay = slopePerDay > 0 ? (usableCapacity - intercept) / slopePerDay : null;
      const purchaseBy = crossingDay != null && crossingDay >= latestDay && crossingDay <= targetDay
        ? new Date(origin + crossingDay * 86400000).toISOString() : null;
      const requiredCapacity = projected / (1 - reservePercent / 100);
      result[field] = { currentCapacity: capacity[field], usableCapacity: round(usableCapacity), slopePerDay: round(slopePerDay),
        projectedAtHorizon: round(projected), additionalCapacityRequired: round(Math.max(0, requiredCapacity - capacity[field])), purchaseBy };
    }
    const normalized = { scopeRef, horizonDays, failureReservePercent: reservePercent, observationCount: observations.length,
      observedFrom: observations[0].timestamp, observedTo: observations[observations.length - 1].timestamp, metrics: result,
      recommendation: Object.values(result).some(item => item.additionalCapacityRequired > 0) ? 'plan_purchase' : 'capacity_sufficient' };
    const forecastHash = hash({ ...normalized, observations }); const db = this._db();
    db.prepare('INSERT OR IGNORE INTO finops_capacity_forecasts (scope_ref,horizon_days,result_json,forecast_hash,created_by) VALUES (?,?,?,?,?)')
      .run(scopeRef, horizonDays, stable(normalized), forecastHash, actor.id);
    const row = db.prepare('SELECT * FROM finops_capacity_forecasts WHERE forecast_hash=?').get(forecastHash);
    return { id: row.id, ...parse(row.result_json, {}), forecastHash: row.forecast_hash, purchaseStarted: false, createdAt: row.created_at };
  }
  scorePlacement(body = {}, actor) {
    this._admin(actor); const workloadRef = text(body.workloadRef, 'workloadRef'); const fields = ['cost','performance','resilience','compliance'];
    const weights = numeric(body.weights || { cost: 25, performance: 25, resilience: 25, compliance: 25 }, 'weights', fields);
    const weightTotal = Object.values(weights).reduce((sum, value) => sum + value, 0); if (weightTotal <= 0) throw fail('weights must be positive');
    const minimumComplianceScore = number(body.minimumComplianceScore ?? 70, 'minimumComplianceScore', 0, 100);
    if (!Array.isArray(body.candidates) || !body.candidates.length || body.candidates.length > 100) throw fail('candidates must contain 1-100 values');
    const ranking = body.candidates.map((item, index) => {
      const targetRef = text(item.targetRef, `candidates[${index}].targetRef`); const scores = numeric(item.scores, `candidates[${index}].scores`, fields);
      for (const [key, value] of Object.entries(scores)) if (value > 100) throw fail(`candidates[${index}].scores.${key} cannot exceed 100`);
      const blockers = Array.isArray(item.blockers) ? item.blockers.map((value, blockerIndex) => text(value, `candidates[${index}].blockers[${blockerIndex}]`, 200, SAFE_REF)) : [];
      if (scores.compliance < minimumComplianceScore) blockers.push('minimum compliance score');
      const eligible = blockers.length === 0; const score = eligible ? round(fields.reduce((sum, field) => sum + scores[field] * weights[field], 0) / weightTotal) : 0;
      return { targetRef, scores, score, eligible, blockers, explanation: fields.map(field => ({ dimension: field, score: scores[field], weight: weights[field] })) };
    }).sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score || a.targetRef.localeCompare(b.targetRef));
    const selectedTargetRef = ranking.find(item => item.eligible)?.targetRef || null; const scoreHash = hash({ workloadRef, weights, minimumComplianceScore, ranking }); const db = this._db();
    db.prepare(`INSERT OR IGNORE INTO finops_placement_scores
      (workload_ref,selected_target_ref,ranking_json,weights_json,score_hash,created_by) VALUES (?,?,?,?,?,?)`)
      .run(workloadRef, selectedTargetRef, stable(ranking), stable(weights), scoreHash, actor.id);
    const row = db.prepare('SELECT * FROM finops_placement_scores WHERE score_hash=?').get(scoreHash);
    return { id: row.id, workloadRef: row.workload_ref, selectedTargetRef: row.selected_target_ref,
      ranking: parse(row.ranking_json, []), weights: parse(row.weights_json, {}), scoreHash: row.score_hash,
      providerMutationsStarted: 0, createdAt: row.created_at };
  }

  capacityEvidence(actor) {
    this._admin(actor); const db = this._db();
    return { reservations: db.prepare('SELECT * FROM finops_reserved_capacity_recommendations ORDER BY id DESC LIMIT 100').all().map(row => ({
      id: row.id, scopeRef: row.scope_ref, ...parse(row.recommendation_json, {}), evidenceHash: row.evidence_hash, purchaseStarted: false, createdAt: row.created_at })),
    consolidation: db.prepare('SELECT * FROM finops_consolidation_scenarios ORDER BY id DESC LIMIT 100').all().map(row => ({ id: row.id,
      name: row.name, removedHostRef: row.removed_host_ref, state: row.state, result: parse(row.result_json, {}),
      scenarioHash: row.scenario_hash, providerMutationsStarted: 0, createdAt: row.created_at })),
    forecasts: db.prepare('SELECT * FROM finops_capacity_forecasts ORDER BY id DESC LIMIT 100').all().map(row => ({ id: row.id,
      ...parse(row.result_json, {}), forecastHash: row.forecast_hash, purchaseStarted: false, createdAt: row.created_at })),
    placementScores: db.prepare('SELECT * FROM finops_placement_scores ORDER BY id DESC LIMIT 100').all().map(row => ({ id: row.id,
      workloadRef: row.workload_ref, selectedTargetRef: row.selected_target_ref, ranking: parse(row.ranking_json, []),
      weights: parse(row.weights_json, {}), scoreHash: row.score_hash, providerMutationsStarted: 0, createdAt: row.created_at })) };
  }
  overview(actor) {
    this._admin(actor); const budgetAlerts = this.budgetAlerts(actor); const anomalies = this.costAnomalies(actor);
    const assessments = this.assessments(actor); const schedules = this.schedules(actor); const executions = this.executions(actor);
    const capacity = this.capacityEvidence(actor);
    return { capabilities: { budgetThresholdAlerts: true, costAnomalyDetection: true, idleVmDetector: true,
      oversizedVmDetector: true, zombieResourceDetector: true, scheduleBasedSavings: true,
      reservedCapacityRecommendations: true, clusterConsolidationScenario: true, capacityPurchaseForecast: true,
      workloadPlacementCostScore: true }, budgetAlertPolicies: this.budgetAlertPolicies(actor), budgetAlerts,
    anomalyPolicies: this.anomalyPolicies(actor), costAnomalies: anomalies, assessments, schedules, executions, ...capacity,
    summary: { queuedBudgetAlerts: budgetAlerts.filter(item => item.notificationState === 'queued').length,
      openAnomalies: anomalies.length, optimizationCandidates: assessments.filter(item => item.state.endsWith('_candidate')).length,
      automatedSavingsSucceeded: executions.filter(item => item.state === 'succeeded').length,
      blockedConsolidations: capacity.consolidation.filter(item => item.state === 'blocked').length,
      purchaseForecasts: capacity.forecasts.filter(item => item.recommendation === 'plan_purchase').length,
      providerMutationsStartedByAdvisories: 0 } };
  }
}

const service = new FinOpsOptimizationService();
module.exports = service;
module.exports.FinOpsOptimizationService = FinOpsOptimizationService;
module.exports.FinOpsOptimizationError = FinOpsOptimizationError;
module.exports._internals = { canonical, stable, hash, round, confidence };
