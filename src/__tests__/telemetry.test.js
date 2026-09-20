'use strict';

// WHY: Closing self-introduced test debt from the v8.2.x post-audit
// remediation pass.
//
// v8.69 upgrades the old no-op scaffold into explicit, local-only daily
// product-feedback aggregates. There is still no network collector.
//
// This suite locks down the v8.2.x scaffold contract so the v8.3.0
// upgrade can rip out the no-op branches without re-discovering the
// invariants:
//   1. Off by default (no settings row, or settings.value !== 'true').
//   2. emit() is a TRUE no-op when disabled — no network, no throw.
//   3. _ensureInstallId() is idempotent and persists into settings.
//   4. describePayload() returns the documented anonymous shape with
//      the "off by default" notice the Settings UI will render.
//
// If any of these break in a future commit, the regression is on us,
// not the user — telemetry that fires unexpectedly is a security
// incident in self-hosted land.

process.env.APP_SECRET = 'test-secret-key-for-jest-tests-only';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

const Database = require('better-sqlite3');

describe('Product feedback telemetry (v8.69 — local and opt-in)', () => {
  let db;
  let telemetry;

  beforeAll(() => {
    // Fresh in-memory DB with just the `settings` table the scaffold
    // needs — no migrations, keeps the test fast and decoupled.
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE product_feedback_preferences (
        user_id INTEGER PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0,
        usage_enabled INTEGER NOT NULL DEFAULT 1, failure_enabled INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE product_feedback_daily (
        event_date TEXT NOT NULL, event_key TEXT NOT NULL, outcome TEXT NOT NULL,
        provider_type TEXT NOT NULL DEFAULT 'unknown', event_count INTEGER NOT NULL DEFAULT 0,
        first_recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(event_date,event_key,outcome,provider_type)
      );
    `);

    // Re-require with a fresh module cache so internal `_enabled` and
    // `_installId` state don't leak in from any other suite.
    jest.resetModules();
    telemetry = require('../services/telemetry');
  });

  afterAll(() => {
    if (db) db.close();
  });

  beforeEach(() => {
    db.prepare('DELETE FROM settings').run();
    db.prepare('DELETE FROM product_feedback_preferences').run();
    db.prepare('DELETE FROM product_feedback_daily').run();
    // Reset module-level state by reloading the module — the scaffold
    // caches `_enabled` and `_installId` between calls.
    jest.resetModules();
    telemetry = require('../services/telemetry');
  });

  // ── isEnabled() ────────────────────────────────────────────────────

  it('isEnabled returns false when settings row is missing', () => {
    expect(telemetry.isEnabled(db)).toBe(false);
  });

  it('isEnabled returns true ONLY when settings.telemetry_enabled = "true"', () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('telemetry_enabled', 'true')").run();
    expect(telemetry.isEnabled(db)).toBe(true);
  });

  it('isEnabled returns false for any non-"true" value (string "1", "yes", "TRUE")', () => {
    const ins = db.prepare(
      "INSERT INTO settings (key, value) VALUES ('telemetry_enabled', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    );
    for (const v of ['1', 'yes', 'TRUE', 'false', '']) {
      ins.run(v);
      expect(telemetry.isEnabled(db)).toBe(false);
    }
  });

  it('isEnabled returns false (does not throw) when DB query fails', () => {
    const brokenDb = {
      prepare: () => {
        throw new Error('db gone');
      },
    };
    expect(telemetry.isEnabled(brokenDb)).toBe(false);
  });

  // ── emit() ─────────────────────────────────────────────────────────

  it('emit() is a no-op when disabled (returns undefined, does not throw)', () => {
    // Default state: _enabled is false (module just reloaded, no isEnabled call yet).
    expect(() => telemetry.emit('feature.x')).not.toThrow();
    expect(telemetry.emit('feature.x')).toBeUndefined();
  });

  it('emit() with feature + meta args still no-ops cleanly', () => {
    expect(() =>
      telemetry.emit('ai.audit-search', { provider: 'anthropic', count: 12 })
    ).not.toThrow();
    expect(telemetry.emit('pcloud.upload-db', { size: 1024 })).toBeUndefined();
  });

  it('emit() does not attempt any network call when disabled', () => {
    // Trip-wire: if anyone wires up real HTTP in v8.2.x by accident,
    // either http.request or https.request would be invoked. We spy on
    // both and assert zero calls.
    const http = require('http');
    const https = require('https');
    const httpSpy = jest.spyOn(http, 'request').mockImplementation(() => {
      throw new Error('telemetry must not hit the network in v8.2.x');
    });
    const httpsSpy = jest.spyOn(https, 'request').mockImplementation(() => {
      throw new Error('telemetry must not hit the network in v8.2.x');
    });

    telemetry.emit('feature.with.network', { foo: 'bar' });

    expect(httpSpy).not.toHaveBeenCalled();
    expect(httpsSpy).not.toHaveBeenCalled();

    httpSpy.mockRestore();
    httpsSpy.mockRestore();
  });

  // ── _ensureInstallId() ─────────────────────────────────────────────

  it('_ensureInstallId generates a UUID v4 on first call', () => {
    const id = telemetry._ensureInstallId(db);
    expect(typeof id).toBe('string');
    // RFC 4122 v4: xxxxxxxx-xxxx-4xxx-[8|9|a|b]xxx-xxxxxxxxxxxx
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('_ensureInstallId is idempotent — second call returns the same UUID', () => {
    const a = telemetry._ensureInstallId(db);
    const b = telemetry._ensureInstallId(db);
    const c = telemetry._ensureInstallId(db);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('_ensureInstallId persists the UUID into settings.telemetry_install_id', () => {
    const id = telemetry._ensureInstallId(db);
    const row = db.prepare("SELECT value FROM settings WHERE key = 'telemetry_install_id'").get();
    expect(row).toBeTruthy();
    expect(row.value).toBe(id);
  });

  it('_ensureInstallId reuses an existing settings row across module reloads', () => {
    const first = telemetry._ensureInstallId(db);
    // Simulate a process restart — module cache cleared, in-memory
    // `_installId` lost — but the DB row should still be honored.
    jest.resetModules();
    const reloaded = require('../services/telemetry');
    const second = reloaded._ensureInstallId(db);
    expect(second).toBe(first);
  });

  // ── describePayload() ──────────────────────────────────────────────

  it('describePayload returns the documented aggregate-only shape', () => {
    const p = telemetry.describePayload(db);
    expect(p).toMatchObject({
      destination: 'local SQLite aggregate only',
      networkTransmission: false,
      installId: expect.any(String),
      version: expect.any(String),
      mode: 'standalone',
      periodSeconds: 86400,
      sampleCounter: {
        eventKey: 'catalog.view',
        outcome: 'success',
        providerType: 'unknown',
        increment: 1,
      },
      excluded: expect.arrayContaining(['username', 'ip', 'error text']),
    });
    // No PII keys
    expect(p).not.toHaveProperty('hostname');
    expect(p).not.toHaveProperty('username');
    expect(p).not.toHaveProperty('ip');
    expect(p).not.toHaveProperty('email');
  });

  it('describePayload explicitly reports zero network transmission', () => {
    const p = telemetry.describePayload(db);
    expect(p.networkTransmission).toBe(false);
    expect(p.destination).toContain('local');
  });

  it('describePayload accepts a non-default mode', () => {
    const p = telemetry.describePayload(db, 'ha');
    expect(p.mode).toBe('ha');
  });

  it('records only an allowlisted daily counter after explicit user opt-in', () => {
    expect(telemetry.record(db, 7, 'catalog.view')).toEqual({ recorded: false, reason: 'opt_in_required' });
    telemetry.setPreference(db, 7, { enabled: true, usageEnabled: true, failureEnabled: true });
    expect(telemetry.record(db, 7, 'catalog.view', { outcome: 'success', providerType: 'proxmox' })).toMatchObject({ recorded: true });
    expect(telemetry.record(db, 7, 'catalog.view', { outcome: 'success', providerType: 'proxmox' })).toMatchObject({ recorded: true });
    expect(db.prepare('SELECT event_count FROM product_feedback_daily').get().event_count).toBe(2);
  });

  it('rejects arbitrary event, provider and payload dimensions', () => {
    telemetry.setPreference(db, 7, { enabled: true });
    expect(() => telemetry.record(db, 7, 'container.name', { outcome: 'success' })).toThrow('allowlisted');
    expect(() => telemetry.record(db, 7, 'catalog.view', { outcome: 'success', providerType: 'private-hostname' })).toThrow('provider');
  });

  // ── Module loads cleanly with no DB available ──────────────────────

  it('module loads cleanly with no DB available (graceful degradation)', () => {
    // The module-load itself must never touch a DB. If it did, requiring
    // it before getDb() initialized would throw. We already required it
    // in beforeEach above without any DB hookup — survival is the test.
    expect(typeof telemetry.isEnabled).toBe('function');
    expect(typeof telemetry.emit).toBe('function');
    expect(typeof telemetry.describePayload).toBe('function');
    expect(typeof telemetry._ensureInstallId).toBe('function');

    // And isEnabled() called with a totally bogus "db" must not throw:
    expect(() => telemetry.isEnabled({})).not.toThrow();
    expect(telemetry.isEnabled({})).toBe(false);
  });
});
