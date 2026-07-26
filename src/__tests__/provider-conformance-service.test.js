'use strict';

const Database = require('better-sqlite3');
const migration = require('../db/migrations/108_provider_conformance');
const { FEATURE_KEYS } = require('../services/provider-sdk/catalog');
const { supported, adapterNotImplemented } = require('../services/provider-sdk/adapters/helpers');
const { buildEnvelope } = require('../services/provider-sdk/schema');

const mockGetAdapter = jest.fn();
const mockCapabilities = jest.fn();
const mockResources = jest.fn();

jest.mock('../services/provider-sdk/registry', () => ({
  getAdapter: (...args) => mockGetAdapter(...args),
  capabilitiesForHost: (...args) => mockCapabilities(...args),
  resourcesForHost: (...args) => mockResources(...args),
}));

const conformance = require('../services/provider-conformance');

const host = { id: 7, name: 'pve-fixture', daemon_type: 'proxmox', is_active: 1 };
const resourceId = `ddr_vm_${'a'.repeat(26)}`;

describe('Persistent provider conformance runs', () => {
  let database;
  let featureEvidence;

  beforeEach(() => {
    jest.clearAllMocks();
    database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    database.exec(`
      CREATE TABLE docker_hosts (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
      INSERT INTO docker_hosts (id, name) VALUES (7, 'pve-fixture');
      INSERT INTO users (id, username) VALUES (1, 'admin');
    `);
    migration.up(database);
    featureEvidence = Object.fromEntries(FEATURE_KEYS.map(key => [key,
      key === 'inventory.vm' ? supported() : adapterNotImplemented('Proxmox VE')]));
    mockGetAdapter.mockReturnValue({
      type: 'proxmox', declared: () => featureEvidence,
      probe: async () => ({}), listResources: async () => [],
    });
    mockCapabilities.mockResolvedValue(buildEnvelope({
      host, provider: { type: 'proxmox', variant: 'pve', product: 'Proxmox VE', version: 'fixture-1', apiVersion: 'pve-api2-json' },
      probe: { status: 'reachable', durationMs: 3 }, features: featureEvidence,
    }));
    mockResources.mockResolvedValue({
      schemaVersion: '1.0', kind: 'virtualMachine', provider: { type: 'proxmox', endpointId: 7 },
      observedAt: '2026-07-26T00:00:00.000Z', count: 1, totalObserved: 1, truncated: false,
      items: [{
        schemaVersion: '1.0', kind: 'virtualMachine', id: resourceId,
        displayName: 'fixture-vm', observedAt: '2026-07-26T00:00:00.000Z',
        provider: { type: 'proxmox', endpointId: 7 }, identity: { uuid: null, stability: 'derived' },
        labels: {}, relationships: {}, spec: {}, status: {}, actions: [], extensions: {},
      }],
    });
  });

  afterEach(() => database.close());

  it('persists checks, scoring and deterministic tamper-evident evidence', async () => {
    const first = await conformance.runForHost(host, { database, createdBy: 1 });
    const second = await conformance.runForHost(host, { database, createdBy: 1 });
    expect(first).toEqual(expect.objectContaining({
      schemaVersion: '1.0', hostId: 7, providerType: 'proxmox', mode: 'live_readonly',
      state: 'passed', grade: 'certified', providerVersion: 'fixture-1',
    }));
    expect(first.id).toMatch(/^pcr_[a-f0-9]{26}$/);
    expect(first.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.evidenceHash).toBe(first.evidenceHash);
    expect(first.checks.map(check => check.key)).toEqual(expect.arrayContaining([
      'manifest.schema', 'live.capabilities', 'live.inventory.virtualMachine',
      'live.identity_stability', 'live.secret_scan',
    ]));
    expect(mockResources).toHaveBeenCalledTimes(4);
    expect(database.prepare('SELECT COUNT(*) AS count FROM provider_conformance_checks').get().count).toBe(first.checks.length + second.checks.length);
  });

  it('lists host runs and derives an evidence-backed capability scorecard', async () => {
    const run = await conformance.runForHost(host, { database, createdBy: 1 });
    expect(conformance.listForHost(7, { limit: 10 }, database)).toHaveLength(1);
    expect(conformance.get(run.id, database).checks.length).toBeGreaterThan(10);
    const card = conformance.scorecard(database).find(item => item.providerType === 'proxmox');
    expect(card.latestRun.id).toBe(run.id);
    expect(card.latestRun.hostId).toBeUndefined();
    expect(card.counts).toEqual({ shipped: 1, partial: 0, planned: FEATURE_KEYS.length - 1 });
    expect(card.conformanceSlo).toEqual(expect.objectContaining({ windowRuns: 1, successRatePercent: 100, status: 'met' }));
    expect(card.capabilities.find(item => item.key === 'inventory.vm')).toEqual(expect.objectContaining({
      delivery: 'shipped', evidence: `conformance:${run.id}`,
    }));
  });

  it('exports bounded portable evidence with an integrity hash', async () => {
    await conformance.runForHost(host, { database, createdBy: 1 });
    const exported = conformance.exportEvidence(database, { limit: 10 });
    expect(exported).toEqual(expect.objectContaining({
      schemaVersion: '1.0', format: 'docker-dash-provider-conformance',
    }));
    expect(exported.integrityHash).toMatch(/^[a-f0-9]{64}$/);
    expect(exported.runs).toHaveLength(1);
    expect(JSON.stringify(exported)).not.toContain('pve-api2-json-secret');
  });

  it('keeps migration 108 additive and idempotent', () => {
    expect(() => migration.up(database)).not.toThrow();
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='provider_conformance_runs'").get()).toBeTruthy();
  });

  it('allows only one live certification per host at a time', async () => {
    const first = conformance.runForHost(host, { database, createdBy: 1 });
    await expect(conformance.runForHost(host, { database, createdBy: 1 })).rejects.toMatchObject({
      code: 'CONFORMANCE_ALREADY_RUNNING', status: 409,
    });
    await expect(first).resolves.toEqual(expect.objectContaining({ hostId: 7 }));
  });

  it('sanitizes sensitive evidence fields and detects value leaks', () => {
    expect(conformance._internals._safeValue({ token: 'hidden', nested: { password: 'hidden', ok: 'visible' } })).toEqual({ nested: { ok: 'visible' } });
    expect(conformance._internals._secretLeak({ url: 'https://root:secret@example.test/api' })).toBe(true);
    expect(conformance._internals._secretLeak({ token: '[redacted]' })).toBe(false);
  });
});
