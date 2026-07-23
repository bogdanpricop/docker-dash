'use strict';

// v8.15.0 (Onboarding — Phase 1) — migrations 088/089/090 schema + invariants.

process.env.APP_SECRET = 'test-secret-key-for-jest-provisioning';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

const { getDb } = require('../db');

describe('provisioning migrations (088/089/090)', () => {
  let db;
  beforeAll(() => { db = getDb(); });
  afterAll(() => { require('../db').closeDb(); });

  const tableNames = () => new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name),
  );

  it('creates all six new tables', () => {
    const t = tableNames();
    for (const name of ['tenants', 'tenant_settings', 'user_tenants', 'provisioning_runs', 'provisioning_steps', 'tenant_modules']) {
      expect(t.has(name)).toBe(true);
    }
  });

  it('seeds the default tenant (id=1, slug=default, is_default=1, production/active)', () => {
    const row = db.prepare('SELECT * FROM tenants WHERE id = 1').get();
    expect(row).toBeTruthy();
    expect(row.slug).toBe('default');
    expect(row.is_default).toBe(1);
    expect(row.usage_mode).toBe('production');
    expect(row.status).toBe('active');
    expect(row.kind).toBe('internal');
  });

  it('partial unique index allows only one is_default=1 tenant', () => {
    expect(() => {
      db.prepare("INSERT INTO tenants (slug, name, is_default) VALUES ('another-default', 'x', 1)").run();
    }).toThrow(/UNIQUE|constraint/i);
  });

  it('enforces slug UNIQUE (case-insensitive)', () => {
    db.prepare("INSERT INTO tenants (slug, name) VALUES ('acme-uniq', 'Acme')").run();
    expect(() => db.prepare("INSERT INTO tenants (slug, name) VALUES ('ACME-UNIQ', 'Acme2')").run())
      .toThrow(/UNIQUE|constraint/i);
  });

  it('CHECK constrains tenants.kind / usage_mode / status', () => {
    expect(() => db.prepare("INSERT INTO tenants (slug, name, kind) VALUES ('k1', 'x', 'bogus')").run()).toThrow(/constraint|CHECK/i);
    expect(() => db.prepare("INSERT INTO tenants (slug, name, usage_mode) VALUES ('k2', 'x', 'bogus')").run()).toThrow(/constraint|CHECK/i);
    expect(() => db.prepare("INSERT INTO tenants (slug, name, status) VALUES ('k3', 'x', 'bogus')").run()).toThrow(/constraint|CHECK/i);
  });

  it('tenant-owned children cascade on tenant delete', () => {
    const tid = db.prepare("INSERT INTO tenants (slug, name) VALUES ('cascade-t', 'C')").run().lastInsertRowid;
    db.prepare("INSERT INTO tenant_settings (tenant_id, key, value) VALUES (?, 'locale', 'en')").run(tid);
    db.prepare("INSERT INTO tenant_modules (tenant_id, module_key) VALUES (?, 'hosts')").run(tid);
    const uid = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('cascade-u', 'h', 'viewer')").run().lastInsertRowid;
    db.prepare('INSERT INTO user_tenants (user_id, tenant_id, role) VALUES (?, ?, ?)').run(uid, tid, 'viewer');

    db.prepare('DELETE FROM tenants WHERE id = ?').run(tid);
    expect(db.prepare('SELECT COUNT(*) c FROM tenant_settings WHERE tenant_id = ?').get(tid).c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM tenant_modules WHERE tenant_id = ?').get(tid).c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM user_tenants WHERE tenant_id = ?').get(tid).c).toBe(0);
    // the shared user is NOT deleted by the tenant cascade
    expect(db.prepare('SELECT COUNT(*) c FROM users WHERE id = ?').get(uid).c).toBe(1);
  });

  it('provisioning_runs.tenant_id is ON DELETE SET NULL (run survives tenant delete)', () => {
    const tid = db.prepare("INSERT INTO tenants (slug, name) VALUES ('setnull-t', 'S')").run().lastInsertRowid;
    const rid = db.prepare("INSERT INTO provisioning_runs (tenant_id, idempotency_key) VALUES (?, 'setnull-key')").run(tid).lastInsertRowid;
    db.prepare('DELETE FROM tenants WHERE id = ?').run(tid);
    const run = db.prepare('SELECT * FROM provisioning_runs WHERE id = ?').get(rid);
    expect(run).toBeTruthy();
    expect(run.tenant_id).toBeNull();
  });

  it('enforces provisioning_runs.idempotency_key UNIQUE', () => {
    db.prepare("INSERT INTO provisioning_runs (idempotency_key) VALUES ('dup-key')").run();
    expect(() => db.prepare("INSERT INTO provisioning_runs (idempotency_key) VALUES ('dup-key')").run())
      .toThrow(/UNIQUE|constraint/i);
  });

  it('enforces provisioning_steps UNIQUE(run_id, step_key) and cascades on run delete', () => {
    const rid = db.prepare("INSERT INTO provisioning_runs (idempotency_key) VALUES ('steps-key')").run().lastInsertRowid;
    db.prepare("INSERT INTO provisioning_steps (run_id, step_key, ordinal) VALUES (?, 'create_tenant', 1)").run(rid);
    expect(() => db.prepare("INSERT INTO provisioning_steps (run_id, step_key, ordinal) VALUES (?, 'create_tenant', 1)").run(rid))
      .toThrow(/UNIQUE|constraint/i);
    db.prepare('DELETE FROM provisioning_runs WHERE id = ?').run(rid);
    expect(db.prepare('SELECT COUNT(*) c FROM provisioning_steps WHERE run_id = ?').get(rid).c).toBe(0);
  });

  it('tenant_modules PK(tenant_id, module_key) rejects duplicate module', () => {
    const tid = db.prepare("INSERT INTO tenants (slug, name) VALUES ('mod-t', 'M')").run().lastInsertRowid;
    db.prepare("INSERT INTO tenant_modules (tenant_id, module_key) VALUES (?, 'firewall')").run(tid);
    expect(() => db.prepare("INSERT INTO tenant_modules (tenant_id, module_key) VALUES (?, 'firewall')").run(tid))
      .toThrow(/UNIQUE|PRIMARY|constraint/i);
  });
});
