'use strict';

const Database = require('better-sqlite3');
const migration136 = require('../db/migrations/136_sustainability_kubevirt');
const { FinOpsSustainabilityService } = require('../services/finops-sustainability');

const admin = { id: 1, username: 'admin', role: 'admin' };

function database() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL);
    CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, daemon_type TEXT NOT NULL, daemon_config TEXT);
    CREATE TABLE governance_permissions (permission_key TEXT PRIMARY KEY, resource_type TEXT NOT NULL, verb TEXT NOT NULL, description TEXT NOT NULL);
    CREATE TABLE governance_roles (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE);
    CREATE TABLE governance_role_permissions (role_id INTEGER REFERENCES governance_roles(id), permission_key TEXT REFERENCES governance_permissions(permission_key), PRIMARY KEY(role_id,permission_key));
    INSERT INTO users (id,username,role) VALUES (1,'admin','admin');
    INSERT INTO governance_roles (id,slug) VALUES (1,'site-admin');
  `);
  migration136.up(db); return db;
}

function power(service, overrides = {}) {
  return service.recordPowerTelemetry({ hostRef: 'host-a', siteRef: 'site-a',
    intervalStart: '2026-07-01T00:00:00.000Z', intervalEnd: '2026-07-01T02:00:00.000Z',
    averageWatts: 500, peakWatts: 800, cpuUtilizationPercent: 5, vmCount: 10, workloadCount: 20,
    sourceKind: 'bmc', provenance: { source: 'redfish', sensor: 'system-power' }, ...overrides }, admin);
}
function factor(service, siteRef, grams, overrides = {}) {
  return service.saveCarbonFactor({ siteRef, region: 'eu-central', effectiveFrom: '2026-01-01T00:00:00.000Z',
    gramsCo2ePerKwh: grams, sourceUrl: `https://carbon.example/${siteRef}`, methodology: 'location-based hourly average',
    provenance: { dataset: 'grid-v1' }, ...overrides }, admin);
}

describe('V6.3c FinOps sustainability and TCO (B296-B300)', () => {
  let db; let service;
  beforeEach(() => { db = database(); service = new FinOpsSustainabilityService(() => db); });
  afterEach(() => db.close());

  test('migration adds seven stores, three permissions and site-admin grants', () => {
    const names = ['finops_power_telemetry','finops_carbon_factors','finops_carbon_recommendations','finops_tco_scenarios',
      'kubernetes_virtualization_capability_snapshots','kubernetes_virtualization_inventory_snapshots','kubernetes_virtualization_dry_runs'];
    const placeholders = names.map(() => '?').join(',');
    expect(db.prepare(`SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name IN (${placeholders})`).get(...names).count).toBe(7);
    expect(db.prepare('SELECT COUNT(*) count FROM governance_permissions').get().count).toBe(3);
    expect(db.prepare('SELECT COUNT(*) count FROM governance_role_permissions').get().count).toBe(3);
  });

  test('normalizes power into kWh, preserves provenance and deduplicates samples', () => {
    const first = power(service); const duplicate = power(service);
    expect(first).toMatchObject({ energyKwh: 1, averageWatts: 500, peakWatts: 800,
      sourceKind: 'bmc', duplicate: false });
    expect(duplicate).toMatchObject({ id: first.id, duplicate: true, sampleHash: first.sampleHash });
    expect(first.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test('rejects impossible peaks, secret-shaped provenance and excessive intervals', () => {
    expect(() => power(service, { peakWatts: 100 })).toThrow(/peakWatts/);
    expect(() => power(service, { provenance: { apiToken: 'hidden' } })).toThrow(/secret material/);
    expect(() => power(service, { intervalEnd: '2026-09-01T00:00:00.000Z' })).toThrow(/31 days/);
  });

  test('energy dashboard exposes watt per VM/workload and idle-host waste', () => {
    power(service); power(service, { hostRef: 'host-b', intervalStart: '2026-07-01T02:00:00.000Z',
      intervalEnd: '2026-07-01T04:00:00.000Z', averageWatts: 1000, peakWatts: 1200,
      cpuUtilizationPercent: 50, vmCount: 20, workloadCount: 40 });
    const result = service.energyDashboard({}, admin);
    expect(result).toMatchObject({ sampleCount: 2, hostCount: 2, totalEnergyKwh: 3,
      averageWatts: 750, wattPerVm: 50, wattPerWorkload: 25, idleHostWasteKwh: 1,
      providerMutationsStarted: 0 });
  });

  test('carbon factors add sourced emissions and explicit coverage', () => {
    factor(service, 'site-a', 250); power(service);
    const result = service.energyDashboard({}, admin);
    expect(result).toMatchObject({ emissionsKgCo2e: 0.25, carbonCoveragePercent: 100, uncostedEnergyKwh: 0 });
    expect(() => service.saveCarbonFactor({ siteRef: 'site-a', region: 'eu', effectiveFrom: '2026-01-01T00:00:00.000Z',
      gramsCo2ePerKwh: 10, sourceUrl: 'http://insecure.example/factor', methodology: 'test' }, admin)).toThrow(/credential-free HTTPS/);
  });

  test('carbon-aware recommendation honors site, residency, SLA and latency hard constraints', () => {
    factor(service, 'site-a', 500); factor(service, 'site-b', 100); factor(service, 'site-c', 50);
    const result = service.recommendCarbonSchedule({ workloadRef: 'batch-1', energyKwh: 10,
      currentSiteRef: 'site-a', currentStartAt: '2026-07-02T00:00:00.000Z',
      constraints: { allowedSites: ['site-a','site-b','site-c'], requiredResidency: 'eu',
        latestStartAt: '2026-07-02T04:00:00.000Z', maxLatencyMs: 30 },
      candidates: [
        { siteRef: 'site-b', startAt: '2026-07-02T02:00:00.000Z', latencyMs: 20, residencyTags: ['eu'] },
        { siteRef: 'site-c', startAt: '2026-07-02T02:00:00.000Z', latencyMs: 60, residencyTags: ['eu'] },
      ] }, admin);
    expect(result).toMatchObject({ state: 'recommended', selected: { siteRef: 'site-b', estimatedKgCo2e: 1 },
      current: { estimatedKgCo2e: 5 }, providerMutationsStarted: 0 });
    expect(result.candidates.find(item => item.siteRef === 'site-c').blockers).toContain('latency');
  });

  test('carbon recommendation fails closed when residency or factor evidence is absent', () => {
    factor(service, 'site-a', 500);
    const result = service.recommendCarbonSchedule({ workloadRef: 'regulated', energyKwh: 2,
      currentSiteRef: 'site-a', currentStartAt: '2026-07-02T00:00:00.000Z',
      constraints: { allowedSites: ['site-x'], requiredResidency: 'ro' },
      candidates: [{ siteRef: 'site-x', startAt: '2026-07-02T01:00:00.000Z', residencyTags: ['eu'] }] }, admin);
    expect(result.state).toBe('blocked');
    expect(result.blockers).toEqual(expect.arrayContaining(['carbon_factor_unknown', 'data_residency']));
  });

  test('TCO ranks discounted alternatives and never purchases or bills', () => {
    const body = { name: 'onprem-vs-cloud', horizonMonths: 24, currency: 'EUR', options: [
      { name: 'on-prem', capex: 10000, migrationOneTime: 1000, residualValue: 2000,
        monthlyCosts: { hardware: 100, software: 100, energy: 100 }, riskContingencyPercent: 10 },
      { name: 'cloud', capex: 0, migrationOneTime: 500, monthlyCosts: { provider: 500 },
        discountRateAnnual: 0.05, carbonKgMonthly: 20, carbonPricePerKg: 0.1 },
    ] };
    const first = service.compareTco(body, admin); const duplicate = service.compareTco(body, admin);
    expect(first.ranking).toHaveLength(2); expect(first.ranking[0].rank).toBe(1);
    expect(first.ranking.every(item => Number.isFinite(item.total))).toBe(true);
    expect(first).toMatchObject({ billingTransactionsCreated: 0, providerMutationsStarted: 0, duplicate: false });
    expect(duplicate).toMatchObject({ id: first.id, duplicate: true });
  });

  test('overview advertises all five bounded capabilities and zero side effects', () => {
    const overview = service.overview(admin);
    expect(Object.keys(overview.capabilities)).toHaveLength(5);
    expect(Object.values(overview.capabilities).every(Boolean)).toBe(true);
    expect(overview.summary).toMatchObject({ billingTransactionsCreated: 0, providerMutationsStarted: 0 });
    expect(() => service.overview({ id: 2, role: 'viewer' })).toThrow(/Administrator/);
  });
});
