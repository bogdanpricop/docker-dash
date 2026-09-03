'use strict';

const Database = require('better-sqlite3');
const migration134 = require('../db/migrations/134_finops_cost_foundation');
const migration135 = require('../db/migrations/135_finops_optimization_capacity');
const { FinOpsFoundationService } = require('../services/finops-foundation');
const { FinOpsOptimizationService, _internals } = require('../services/finops-optimization');

const admin = { id: 1, username: 'admin', role: 'admin' };
const opId = `op_${'a'.repeat(26)}`;

function database() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL);
    CREATE TABLE governance_permissions (permission_key TEXT PRIMARY KEY, resource_type TEXT NOT NULL, verb TEXT NOT NULL, description TEXT NOT NULL);
    CREATE TABLE governance_roles (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE);
    CREATE TABLE governance_role_permissions (role_id INTEGER REFERENCES governance_roles(id), permission_key TEXT REFERENCES governance_permissions(permission_key), PRIMARY KEY(role_id,permission_key));
    CREATE TABLE provider_operations (id TEXT PRIMARY KEY, state TEXT NOT NULL);
    CREATE TABLE infrastructure_approval_requests (id INTEGER PRIMARY KEY, action_key TEXT NOT NULL, target_id TEXT NOT NULL, payload_hash TEXT NOT NULL, state TEXT NOT NULL);
    INSERT INTO users (id,username,role) VALUES (1,'admin','admin');
    INSERT INTO governance_roles (id,slug) VALUES (1,'site-admin');
  `);
  migration134.up(db); migration135.up(db); return db;
}

function ledger(foundation, ref = 'vm-1', from = '2026-01-01T00:00:00.000Z', to = '2026-01-31T10:00:00.000Z', vCpu = 10) {
  return foundation.recordLedger({ resourceType: 'vm', resourceRef: ref, intervalStart: from, intervalEnd: to,
    allocation: { vCpu, ramGb: 100 }, usage: { usedVcpu: 0.5, usedRamGb: 8, peakVcpu: 2, peakRamGb: 20, uptimeHours: 720 },
    tags: { owner: 'platform', criticality: 'standard', app: 'erp' }, evidence: { source: 'metrics' } }, admin);
}
function privateModel(foundation) {
  return foundation.saveCostModel({ name: 'compute', version: '1', kind: 'private_cloud', currency: 'USD', confidence: 'actual',
    parameters: { monthlyCosts: { hardware: 100 }, capacity: { vCpu: 100, ramGb: 1000 }, weights: { vCpu: 1, ramGb: 0 } },
    sourceUrl: 'https://finance.example/model', effectiveFrom: '2025-01-01T00:00:00.000Z', effectiveTo: '2027-01-01T00:00:00.000Z' }, admin);
}

describe('V6.3b FinOps optimization and capacity (B286-B295)', () => {
  let db; let foundation; let service;
  beforeEach(() => { db = database(); foundation = new FinOpsFoundationService(() => db); service = new FinOpsOptimizationService(() => db); });
  afterEach(() => db.close());

  test('migration adds eleven stores, three permissions and grants', () => {
    const names = ['finops_budget_alert_policies','finops_budget_alerts','finops_cost_anomaly_policies','finops_cost_anomalies',
      'finops_optimization_assessments','finops_savings_schedules','finops_savings_executions','finops_reserved_capacity_recommendations',
      'finops_consolidation_scenarios','finops_capacity_forecasts','finops_placement_scores'];
    const placeholders = names.map(() => '?').join(',');
    expect(db.prepare(`SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name IN (${placeholders})`).get(...names).count).toBe(11);
    expect(db.prepare("SELECT COUNT(*) count FROM governance_permissions WHERE permission_key IN ('finops_alerts.manage','finops_optimization.manage','finops_capacity.manage')").get().count).toBe(3);
    expect(db.prepare('SELECT COUNT(*) count FROM governance_role_permissions').get().count).toBe(7);
  });

  function ratingHistory() {
    const model = privateModel(foundation);
    const periods = [
      ['vm-jan','2026-01-01T00:00:00.000Z','2026-01-31T10:00:00.000Z',10],
      ['vm-feb','2026-02-01T00:00:00.000Z','2026-03-03T10:00:00.000Z',10],
      ['vm-mar','2026-03-04T00:00:00.000Z','2026-04-03T10:00:00.000Z',30],
    ];
    return periods.map(([ref, from, to, cpu]) => { ledger(foundation, ref, from, to, cpu);
      return foundation.createRatingRun({ periodStart: from, periodEnd: to, costModelIds: [model.id] }, admin); });
  }

  test('budget thresholds queue idempotent actual and forecast notifications', () => {
    const runs = ratingHistory(); foundation.saveBudget({ name: 'monthly-global', cadence: 'monthly', scopeType: 'global',
      amount: 20, currency: 'USD', effectiveFrom: '2025-01-01T00:00:00.000Z' }, admin);
    service.saveBudgetAlertPolicy({ name: 'standard', thresholds: [50,80,100], channels: ['in_app','email'], forecastEnabled: true }, admin);
    const first = service.evaluateBudgetAlerts(runs[2].id, admin); const second = service.evaluateBudgetAlerts(runs[2].id, admin);
    expect(first.created).toBe(6); expect(first.alerts.map(item => item.signal)).toEqual(expect.arrayContaining(['actual','forecast']));
    expect(first.alerts.find(item => item.thresholdPercent === 100)).toMatchObject({ severity: 'critical', notificationState: 'queued' });
    expect(second.created).toBe(0); expect(first.providerMutationsStarted).toBe(0);
  });

  test('cost anomalies compare an evidence-linked baseline and deduplicate', () => {
    const runs = ratingHistory(); service.saveAnomalyPolicy({ name: 'global-spend', scopeType: 'global', baselineRuns: 2,
      minimumDeviationPercent: 50, minimumAmount: 1 }, admin);
    const result = service.evaluateCostAnomalies(runs[2].id, admin);
    expect(result.created).toBe(1); expect(result.anomalies[0]).toMatchObject({ direction: 'increase', deviationPercent: 200, baselineAmount: 10, currentAmount: 30 });
    expect(service.evaluateCostAnomalies(runs[2].id, admin).created).toBe(0);
  });

  test('idle detector includes owner, uptime, criticality and coverage context', () => {
    const entry = ledger(foundation);
    expect(service.assessIdleVm(entry.id, { dataCoveragePercent: 95, minimumUptimeHours: 168 }, admin))
      .toMatchObject({ state: 'idle_candidate', owner: 'platform', confidence: 'high', providerMutationsStarted: 0,
        recommendation: { action: 'review_off_hours_schedule', autoStop: false } });
    expect(service.assessIdleVm(entry.id, { dataCoveragePercent: 95, criticality: 'critical' }, admin).state).toBe('protected');
  });

  test('oversized detector applies peak and observation guards before rightsizing', () => {
    const entry = ledger(foundation);
    const result = service.assessOversizedVm(entry.id, { dataCoveragePercent: 95, observationDays: 30, headroomPercent: 25 }, admin);
    expect(result).toMatchObject({ state: 'oversized_candidate', confidence: 'high', recommendation: { suggestedVcpu: 3, suggestedRamGb: 25, applyAutomatically: false } });
    expect(service.assessOversizedVm(entry.id, { dataCoveragePercent: 95, observationDays: 3 }, admin).state).toBe('insufficient_peak_evidence');
  });

  test('zombie detector protects attached or critical resources and never deletes', () => {
    const candidate = service.assessZombieResource({ resourceType: 'snapshot', resourceRef: 'snap-old',
      lastUsedAt: '2025-01-01T00:00:00.000Z', observedAt: '2026-01-01T00:00:00.000Z', staleDays: 90,
      attached: false, owner: 'backup', evidence: { source: 'inventory' } }, admin);
    expect(candidate).toMatchObject({ state: 'zombie_candidate', providerMutationsStarted: 0,
      recommendation: { action: 'owner_review_then_cleanup', autoDelete: false } });
    expect(service.assessZombieResource({ resourceType: 'disk', resourceRef: 'disk-live', lastUsedAt: '2025-01-01T00:00:00.000Z',
      observedAt: '2026-01-01T00:00:00.000Z', attached: true }, admin).state).toBe('in_use');
  });

  test('recommendation-only and missing-adapter schedules do not mutate providers', async () => {
    const recommended = service.saveSavingsSchedule({ name: 'dev-off-hours', resourceRef: 'vm-dev', timezone: 'Europe/Bucharest',
      weekdays: [1,2,3,4,5], offHoursStart: '20:00', offHoursEnd: '07:00', mode: 'recommend', adapterKey: 'provider', owner: 'dev' }, admin);
    expect(await service.executeSavingsSchedule(recommended.id, { action: 'stop', scheduledAt: '2026-06-01T20:00:00.000Z' }, admin))
      .toMatchObject({ state: 'recommended', providerMutationStarted: false });
    const automatic = service.saveSavingsSchedule({ name: 'lab-off-hours', resourceRef: 'vm-lab', timezone: 'UTC', weekdays: [1],
      offHoursStart: '20:00', offHoursEnd: '07:00', mode: 'automate', adapterKey: 'missing', owner: 'lab' }, admin);
    expect(await service.executeSavingsSchedule(automatic.id, { action: 'stop', scheduledAt: '2026-06-01T20:00:00.000Z' }, admin))
      .toMatchObject({ state: 'unsupported', providerMutationStarted: false });
  });

  test('automatic schedule requires hash-bound approval and durable operation', async () => {
    service = new FinOpsOptimizationService(() => db, { savingsAdapters: { native: async () => ({ applied: true, verified: true, finalState: 'stopped' }) } });
    const schedule = service.saveSavingsSchedule({ name: 'approved-off-hours', resourceRef: 'vm-lab', timezone: 'UTC', weekdays: [1],
      offHoursStart: '20:00', offHoursEnd: '07:00', mode: 'automate', adapterKey: 'native', owner: 'lab' }, admin);
    const scheduledAt = '2026-06-01T20:00:00.000Z'; const action = 'stop';
    db.prepare("INSERT INTO provider_operations (id,state) VALUES (?,'running')").run(opId);
    const payloadHash = _internals.hash({ scheduleId: schedule.id, scheduleHash: schedule.scheduleHash, action, scheduledAt });
    db.prepare("INSERT INTO infrastructure_approval_requests (id,action_key,target_id,payload_hash,state) VALUES (1,'finops.schedule.power',?,?,'approved')")
      .run(String(schedule.id), payloadHash);
    const execution = await service.executeSavingsSchedule(schedule.id, { action, scheduledAt, operationId: opId, approvalId: 1,
      confirmation: `EXECUTE SAVINGS ${schedule.id}` }, admin);
    expect(execution).toMatchObject({ state: 'succeeded', operationId: opId, approvalId: 1, providerMutationStarted: true,
      evidence: { applied: true, verified: true } });
  });

  test('reserved capacity compares on-prem headroom and cloud commitments', () => {
    const result = service.recommendReservedCapacity({ scopeRef: 'cluster-a', currentCapacity: { vCpu: 100, ramGb: 500 },
      peakDemand: { vCpu: 90, ramGb: 400 }, forecastDemand: { vCpu: 110, ramGb: 450 }, headroomPercent: 20,
      options: [{ name: 'host-purchase', type: 'on_prem', capacity: { vCpu: 64, ramGb: 256 }, monthlyCost: 1200, termMonths: 36 },
        { name: 'cloud-commit', type: 'cloud_commitment', capacity: { vCpu: 40, ramGb: 100 }, monthlyCost: 600, termMonths: 12 }] }, admin);
    expect(result).toMatchObject({ state: 'recommendation_available', selected: { name: 'cloud-commit' }, purchaseStarted: false });
  });

  test('cluster consolidation retains utilization and N+1 HA constraints', () => {
    const hosts = ['h1','h2','h3'].map(ref => ({ ref, capacity: { vCpu: 100, ramGb: 100 }, demand: { vCpu: 10, ramGb: 10 } }));
    const safe = service.simulateConsolidation({ name: 'remove-h1', removedHostRef: 'h1', hosts, failureToleranceHosts: 1, maximumUtilizationPercent: 80 }, admin);
    expect(safe).toMatchObject({ state: 'safe', providerMutationsStarted: 0 });
    const heavy = hosts.map(host => ({ ...host, demand: { vCpu: 30, ramGb: 30 } }));
    expect(service.simulateConsolidation({ name: 'remove-h1-heavy', removedHostRef: 'h1', hosts: heavy,
      failureToleranceHosts: 1, maximumUtilizationPercent: 80 }, admin).state).toBe('blocked');
  });

  test('capacity forecast identifies when and what to purchase with reserve', () => {
    const observations = [0,30,60].map((day, index) => ({ timestamp: new Date(Date.UTC(2026, 0, 1 + day)).toISOString(),
      vCpu: 40 + index * 20, ramGb: 100 + index * 30, storageGb: 500 + index * 100 }));
    const forecast = service.forecastCapacity({ scopeRef: 'cluster-a', horizonDays: 180, failureReservePercent: 20,
      currentCapacity: { vCpu: 120, ramGb: 300, storageGb: 1000 }, observations }, admin);
    expect(forecast.recommendation).toBe('plan_purchase'); expect(forecast.metrics.vCpu.additionalCapacityRequired).toBeGreaterThan(0);
    expect(forecast.metrics.vCpu.purchaseBy).toBeTruthy(); expect(forecast.purchaseStarted).toBe(false);
  });

  test('placement scoring excludes compliance blockers and explains weights', () => {
    const result = service.scorePlacement({ workloadRef: 'vm-erp', weights: { cost: 40, performance: 20, resilience: 20, compliance: 20 },
      minimumComplianceScore: 70, candidates: [
        { targetRef: 'cheap-noncompliant', scores: { cost: 100, performance: 90, resilience: 90, compliance: 50 } },
        { targetRef: 'balanced', scores: { cost: 80, performance: 85, resilience: 95, compliance: 100 } },
      ] }, admin);
    expect(result).toMatchObject({ selectedTargetRef: 'balanced', providerMutationsStarted: 0 });
    expect(result.ranking.find(item => item.targetRef === 'cheap-noncompliant')).toMatchObject({ eligible: false, score: 0 });
    expect(result.ranking[0].explanation).toHaveLength(4);
  });

  test('overview advertises all ten bounded capabilities', () => {
    const overview = service.overview(admin);
    expect(Object.keys(overview.capabilities)).toHaveLength(10); expect(Object.values(overview.capabilities).every(Boolean)).toBe(true);
    expect(overview.summary.providerMutationsStartedByAdvisories).toBe(0);
  });
});
