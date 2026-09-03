'use strict';

const Database = require('better-sqlite3');
const migration134 = require('../db/migrations/134_finops_cost_foundation');
const { FinOpsFoundationService } = require('../services/finops-foundation');

const admin = { id: 1, username: 'admin', role: 'admin' };
const start = '2026-01-01T00:00:00.000Z';
const end = '2026-01-31T10:00:00.000Z'; // 730 hours

function database() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL);
    CREATE TABLE governance_permissions (permission_key TEXT PRIMARY KEY, resource_type TEXT NOT NULL, verb TEXT NOT NULL, description TEXT NOT NULL);
    CREATE TABLE governance_roles (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE);
    CREATE TABLE governance_role_permissions (role_id INTEGER REFERENCES governance_roles(id), permission_key TEXT REFERENCES governance_permissions(permission_key), PRIMARY KEY(role_id,permission_key));
    INSERT INTO users (id,username,role) VALUES (1,'admin','admin');
    INSERT INTO governance_roles (id,slug) VALUES (1,'site-admin');
  `);
  migration134.up(db); return db;
}

function ledger(service, suffix = 'a') {
  return service.recordLedger({ resourceType: 'vm', resourceRef: `vm-${suffix}`, providerRef: 'provider-a', siteRef: 'site-a',
    intervalStart: start, intervalEnd: end,
    allocation: { vCpu: 10, ramGb: 100, logicalStorageGb: 100, physicalStorageGb: 100,
      replicatedStorageGb: 50, backupStorageGb: 20, gpuDevices: 1, publicIps: 1 },
    usage: { usedVcpu: 4, usedRamGb: 60, transferGb: 100, egressGb: 50, loadBalancerHours: 730,
      vpnHours: 0, gpuHours: 100, gpuReservations: 1 }, gpuProfile: 'a100',
    tags: { env: 'production', app: 'erp', gpuProfile: 'a100' }, evidence: { source: 'metering-api' } }, admin);
}
function model(service, kind, parameters, suffix = kind) {
  return service.saveCostModel({ name: `model-${suffix}`, version: '1.0', kind, scopeRef: '*', currency: 'USD',
    confidence: kind === 'provider_license' ? 'contracted' : 'estimated', parameters,
    sourceUrl: `https://cost.example/${suffix}`, effectiveFrom: '2025-01-01T00:00:00.000Z',
    effectiveTo: '2027-01-01T00:00:00.000Z' }, admin);
}

describe('V6.3a FinOps cost foundation (B276-B285)', () => {
  let db; let service;
  beforeEach(() => { db = database(); service = new FinOpsFoundationService(() => db); });
  afterEach(() => db.close());

  test('migration creates eight stores and grants four permissions', () => {
    const names = ['finops_resource_ledger','finops_cost_models','finops_allocation_rules','finops_resource_allocations',
      'finops_rating_runs','finops_rated_usage','finops_chargeback_exports','finops_budgets'];
    const placeholders = names.map(() => '?').join(',');
    expect(db.prepare(`SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name IN (${placeholders})`).get(...names).count).toBe(8);
    expect(db.prepare("SELECT COUNT(*) count FROM governance_permissions WHERE permission_key LIKE 'finops_%'").get().count).toBe(4);
    expect(db.prepare('SELECT COUNT(*) count FROM governance_role_permissions').get().count).toBe(4);
  });

  test('ledger records allocated and used resources immutably and deduplicates evidence', () => {
    const first = ledger(service); const second = ledger(service);
    expect(first).toMatchObject({ duplicate: false, resourceType: 'vm', allocation: { vCpu: 10 }, usage: { usedVcpu: 4 } });
    expect(second).toMatchObject({ id: first.id, duplicate: true, entryHash: first.entryHash });
    expect(db.prepare('SELECT COUNT(*) count FROM finops_resource_ledger').get().count).toBe(1);
  });

  test('ledger rejects secret-shaped evidence and unbounded intervals', () => {
    expect(() => service.recordLedger({ resourceType: 'vm', resourceRef: 'vm-x', intervalStart: start, intervalEnd: end,
      allocation: { vCpu: 1 }, evidence: { apiToken: 'do-not-store' } }, admin)).toThrow(/secret material/);
    expect(() => service.recordLedger({ resourceType: 'vm', resourceRef: 'vm-x', intervalStart: start,
      intervalEnd: '2027-01-01T00:00:00.000Z', allocation: { vCpu: 1 } }, admin)).toThrow(/93 days/);
  });

  test('private cloud model captures hardware, software, facility, energy and personnel cost', () => {
    const saved = model(service, 'private_cloud', { monthlyCosts: { hardware: 500, software: 200, facility: 100,
      energy: 100, personnel: 100 }, capacity: { vCpu: 100, ramGb: 1000 }, weights: { vCpu: 0.5, ramGb: 0.5 } });
    expect(saved.parameters.monthlyCosts).toEqual({ energy: 100, facility: 100, hardware: 500, personnel: 100, software: 200 });
    expect(saved.modelHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test.each([
    ['provider_license', { metric: 'core', unitCost: 20, billingPeriod: 'month' }],
    ['storage', { rates: { logicalGbMonth: 0.1, physicalGbMonth: 0.2, replicatedGbMonth: 0.3, backupGbMonth: 0.05 } }],
    ['network', { rates: { transferGb: 0.01, egressGb: 0.1, loadBalancerHour: 0.02, vpnHour: 0.01, publicIpHour: 0.005 } }],
    ['gpu', { profiles: { a100: { hourlyRate: 2, reservationMonthly: 50 } } }],
  ])('validates and versions the %s model', (kind, parameters) => {
    const saved = model(service, kind, parameters);
    expect(saved).toMatchObject({ kind, version: '1.0', currency: 'USD' });
    expect(service.saveCostModel({ name: saved.name, version: '1.0', kind, scopeRef: '*', currency: 'USD',
      confidence: saved.confidence, parameters, sourceUrl: saved.sourceUrl, effectiveFrom: saved.effectiveFrom,
      effectiveTo: saved.effectiveTo }, admin)).toMatchObject({ id: saved.id, duplicate: true });
  });

  test('tag rules allocate business dimensions deterministically by priority', () => {
    const entry = ledger(service);
    service.saveAllocationRule({ name: 'production-default', priority: 10, matchTags: { env: '*' },
      dimensions: { environment: 'production', costCenter: 'CC-DEFAULT' } }, admin);
    const specific = service.saveAllocationRule({ name: 'erp-production', priority: 100, matchTags: { env: 'production', app: 'erp' },
      dimensions: { businessUnit: 'finance', application: 'erp', environment: 'production', costCenter: 'CC-ERP' } }, admin);
    const result = service.resolveAllocation(entry.id, admin);
    expect(result).toMatchObject({ state: 'allocated', dimensions: { businessUnit: 'finance', application: 'erp',
      environment: 'production', costCenter: 'CC-ERP' } });
    expect(result.matchedRuleIds[0]).toBe(specific.id);
  });

  test('showback rates all five model families with formula and provenance evidence', () => {
    ledger(service); service.saveAllocationRule({ name: 'erp', priority: 100, matchTags: { app: 'erp' },
      dimensions: { businessUnit: 'finance', application: 'erp', environment: 'production', costCenter: 'CC-ERP' } }, admin);
    const models = [
      model(service, 'private_cloud', { monthlyCosts: { hardware: 500, software: 200, facility: 100, energy: 100, personnel: 100 },
        capacity: { vCpu: 100, ramGb: 1000 }, weights: { vCpu: 0.5, ramGb: 0.5 } }),
      model(service, 'provider_license', { metric: 'core', unitCost: 20, billingPeriod: 'month' }),
      model(service, 'storage', { rates: { logicalGbMonth: 0.1, physicalGbMonth: 0.2, replicatedGbMonth: 0.3, backupGbMonth: 0.05 } }),
      model(service, 'network', { rates: { transferGb: 0.01, egressGb: 0.1, loadBalancerHour: 0.02, vpnHour: 0.01, publicIpHour: 0.005 } }),
      model(service, 'gpu', { profiles: { a100: { hourlyRate: 2, reservationMonthly: 50 } } }),
    ];
    const run = service.createRatingRun({ periodStart: start, periodEnd: end, costModelIds: models.map(item => item.id) }, admin);
    expect(run.lines).toHaveLength(5); expect(run.totalCost).toBeCloseTo(620.25, 5);
    expect(run.summary.byCategory).toMatchObject({ private_cloud: 100, provider_license: 200, storage: 46, network: 24.25, gpu: 250 });
    expect(run.summary.byCostCenter).toEqual({ 'CC-ERP': 620.25 });
    expect(run.lines.every(line => line.provenanceHash.match(/^[a-f0-9]{64}$/) && line.formula.method)).toBe(true);
    expect(run.billingTransactionCreated).toBe(false);
  });

  test('showback is hash-idempotent and missing GPU profiles fail closed', () => {
    ledger(service); const gpu = model(service, 'gpu', { profiles: { l40: { hourlyRate: 1, reservationMonthly: 20 } } });
    expect(() => service.createRatingRun({ periodStart: start, periodEnd: end, costModelIds: [gpu.id] }, admin)).toThrow(/not present/);
    db.prepare("UPDATE finops_resource_ledger SET usage_json=json_set(usage_json,'$.gpuProfile','l40')").run();
    const first = service.createRatingRun({ periodStart: start, periodEnd: end, costModelIds: [gpu.id] }, admin);
    const second = service.createRatingRun({ periodStart: start, periodEnd: end, costModelIds: [gpu.id] }, admin);
    expect(second).toMatchObject({ id: first.id, duplicate: true });
  });

  test('chargeback CSV is deterministic rated usage and never a billing transaction', () => {
    ledger(service); const privateModel = model(service, 'private_cloud', { monthlyCosts: { hardware: 100 },
      capacity: { vCpu: 100, ramGb: 1000 }, weights: { vCpu: 1, ramGb: 0 } });
    const run = service.createRatingRun({ periodStart: start, periodEnd: end, costModelIds: [privateModel.id] }, admin);
    const result = service.createChargebackExport(run.id, { format: 'csv' }, admin);
    expect(result.content).toContain('periodStart,periodEnd,resourceType,resourceRef,costCenter');
    expect(result.content).toContain('vm-a'); expect(result.export.rowCount).toBe(1);
    expect(result).toMatchObject({ billingTransactionCreated: false, export: { billingTransactionCreated: false } });
    expect(service.createChargebackExport(run.id, { format: 'csv' }, admin).export.id).toBe(result.export.id);
  });

  test('monthly and quarterly budgets compare scoped showback without creating alerts', () => {
    ledger(service); service.saveAllocationRule({ name: 'erp', matchTags: { app: 'erp' }, dimensions: { businessUnit: 'finance',
      application: 'erp', environment: 'production', costCenter: 'CC-ERP' } }, admin);
    const privateModel = model(service, 'private_cloud', { monthlyCosts: { hardware: 1000 },
      capacity: { vCpu: 100, ramGb: 1000 }, weights: { vCpu: 1, ramGb: 0 } });
    service.saveBudget({ name: 'ERP monthly', cadence: 'monthly', scopeType: 'cost_center', scopeValue: 'CC-ERP',
      amount: 50, currency: 'USD', effectiveFrom: '2025-01-01T00:00:00.000Z', effectiveTo: '2027-01-01T00:00:00.000Z' }, admin);
    service.saveBudget({ name: 'Global quarter', cadence: 'quarterly', scopeType: 'global', amount: 1000,
      currency: 'USD', effectiveFrom: '2025-01-01T00:00:00.000Z' }, admin);
    const run = service.createRatingRun({ periodStart: start, periodEnd: end, costModelIds: [privateModel.id] }, admin);
    expect(run.budgets).toHaveLength(2);
    expect(run.budgets.find(item => item.name === 'ERP monthly')).toMatchObject({ state: 'over', spent: 100, alertsCreated: 0 });
    expect(run.budgets.find(item => item.name === 'Global quarter').state).toBe('within');
  });

  test('overview exposes all ten capabilities and zero billing side effects', () => {
    const overview = service.overview(admin);
    expect(Object.values(overview.capabilities).every(Boolean)).toBe(true);
    expect(Object.keys(overview.capabilities)).toHaveLength(10);
    expect(overview.summary.billingTransactionsCreated).toBe(0);
  });
});
