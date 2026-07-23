'use strict';

// v8.15.0 (Onboarding — Phase 1) — the saga engine: plan/apply/resume/rollback,
// idempotency, secret redaction, audit coverage. Shares one in-memory DB;
// each test uses a unique tenant slug + idempotency key to stay isolated.

process.env.APP_SECRET = 'test-secret-key-for-jest-provisioning';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';
process.env.BCRYPT_ROUNDS = '4'; // keep createUser fast in tests

const { getDb } = require('../db');
const provisioning = require('../services/provisioning');
const auditService = require('../services/audit');

const USER = { id: null, username: 'admin-tester', role: 'admin' };
let seq = 0;

function decl(overrides = {}) {
  seq += 1;
  const slug = overrides.slug || `t${seq}`;
  return {
    version: 1,
    kind: 'onboarding-declaration',
    idempotencyKey: overrides.idempotencyKey || `key-${slug}`,
    tenant: { slug, name: overrides.name || `Tenant ${slug}`, kind: 'client' },
    mode: overrides.mode || 'production',
    regional: overrides.regional || { locale: 'en', timezone: 'Europe/Bucharest', currency: 'EUR', unitSystem: 'metric' },
    modules: overrides.modules || [{ key: 'firewall' }],
    hosts: overrides.hosts || [
      { name: `${slug}-host`, connectionType: 'ssh', sshHost: '10.0.0.5', sshUsername: 'root', secret: { sshPrivateKey: `PRIVKEY-${slug}` } },
    ],
    users: overrides.users || [
      { username: `${slug}-owner`, role: 'admin', isOwner: true, password: `Str0ng-P@ss-${slug}!` },
    ],
    permissions: overrides.permissions || [
      { username: `${slug}-owner`, hostName: `${slug}-host`, permission: 'operate' },
    ],
  };
}

describe('engine.plan (dry-run)', () => {
  let db;
  beforeAll(() => { db = getDb(); });

  it('computes ordered steps + impact + warnings and writes NOTHING', () => {
    const runsBefore = db.prepare('SELECT COUNT(*) c FROM provisioning_runs').get().c;
    const tenantsBefore = db.prepare('SELECT COUNT(*) c FROM tenants').get().c;
    const p = provisioning.plan({ declaration: decl({ slug: 'planonly' }), user: USER });

    expect(p.steps.map((s) => s.key)).toEqual([
      'create_tenant', 'set_regional', 'seed_nomenclatures', 'seed_entities', 'enable_modules', 'create_hosts', 'create_users', 'grant_permissions', 'finalize',
    ]);
    expect(p.steps.find((s) => s.key === 'create_hosts').kind).toBe('external');
    expect(p.steps.find((s) => s.key === 'create_tenant').kind).toBe('db');
    expect(p.impact.creates).toMatchObject({ tenants: 1, hosts: 1, users: 1, grants: 1 });
    expect(p.impact.creates.modules).toBe(2); // firewall + hosts closure

    expect(db.prepare('SELECT COUNT(*) c FROM provisioning_runs').get().c).toBe(runsBefore);
    expect(db.prepare('SELECT COUNT(*) c FROM tenants').get().c).toBe(tenantsBefore);
  });

  it('rejects a bad declaration', () => {
    expect(() => provisioning.plan({ declaration: { version: 9 }, user: USER })).toThrow(/version/);
  });

  it('rejects a wire-supplied tenant_id', () => {
    const bad = { ...decl({ slug: 'wire' }), tenant_id: 3 };
    expect(() => provisioning.plan({ declaration: bad, user: USER })).toThrow(/tenant_id is not allowed/);
  });

  it('warns for demo mode and missing owner', () => {
    const p = provisioning.plan({ declaration: decl({ slug: 'warn', mode: 'demo', users: [], permissions: [] }), user: USER });
    expect(p.warnings.join(' ')).toMatch(/demo/);
    expect(p.warnings.join(' ')).toMatch(/no users declared/);
  });
});

describe('engine.apply (happy path)', () => {
  let db;
  beforeAll(() => { db = getDb(); });

  it('runs all nine steps and creates tenant/settings/modules/hosts/users/grants', async () => {
    const run = await provisioning.apply({ declaration: decl({ slug: 'full' }), user: USER });
    expect(run.status).toBe('completed');
    expect(run.currentStep).toBe(9);
    expect(run.steps.every((s) => s.status === 'completed')).toBe(true);

    const tid = run.tenantId;
    expect(db.prepare('SELECT status FROM tenants WHERE id = ?').get(tid).status).toBe('active');
    expect(db.prepare('SELECT COUNT(*) c FROM tenant_settings WHERE tenant_id = ?').get(tid).c).toBe(4);
    const mods = db.prepare('SELECT module_key FROM tenant_modules WHERE tenant_id = ?').all(tid).map((r) => r.module_key).sort();
    expect(mods).toEqual(['firewall', 'hosts']);
    expect(db.prepare("SELECT COUNT(*) c FROM docker_hosts WHERE name = 'full-host'").get().c).toBe(1);
    const ut = db.prepare('SELECT role, is_owner FROM user_tenants WHERE tenant_id = ?').get(tid);
    expect(ut).toMatchObject({ role: 'admin', is_owner: 1 });
    expect(db.prepare('SELECT COUNT(*) c FROM host_permissions').get().c).toBeGreaterThanOrEqual(1);
  });

  it('writes a result_json summary', async () => {
    const run = await provisioning.apply({ declaration: decl({ slug: 'summary' }), user: USER });
    expect(run.result).toBeTruthy();
    expect(run.result.steps.length).toBe(9);
    expect(run.result.created).toMatchObject({ hosts: 1, users: 1 });
  });

  it('stores the host SSH credential ENCRYPTED at rest (never plaintext)', async () => {
    const run = await provisioning.apply({ declaration: decl({ slug: 'enc' }), user: USER });
    expect(run.status).toBe('completed');
    const row = db.prepare("SELECT ssh_config FROM docker_hosts WHERE name = 'enc-host'").get();
    expect(row.ssh_config).toMatch(/^[0-9a-f]+:[0-9a-f]+:/); // iv:tag:ct
    expect(row.ssh_config).not.toContain('PRIVKEY-enc');
  });

  it('forces the provisioned owner to must_change_password', async () => {
    await provisioning.apply({ declaration: decl({ slug: 'mcp' }), user: USER });
    const u = db.prepare("SELECT must_change_password FROM users WHERE username = 'mcp-owner'").get();
    expect(u.must_change_password).toBe(1);
  });
});

describe('engine idempotency', () => {
  let db;
  beforeAll(() => { db = getDb(); });

  it('a re-run with the same declaration does NOT duplicate anything', async () => {
    const d = decl({ slug: 'idem' });
    const run1 = await provisioning.apply({ declaration: d, user: USER });
    const run2 = await provisioning.apply({ declaration: d, user: USER });
    expect(run2.id).toBe(run1.id);
    expect(db.prepare("SELECT COUNT(*) c FROM provisioning_runs WHERE idempotency_key = ?").get(d.idempotencyKey).c).toBe(1);
    expect(db.prepare("SELECT COUNT(*) c FROM tenants WHERE slug = 'idem'").get().c).toBe(1);
    expect(db.prepare("SELECT COUNT(*) c FROM users WHERE username = 'idem-owner'").get().c).toBe(1);
    expect(db.prepare("SELECT COUNT(*) c FROM docker_hosts WHERE name = 'idem-host'").get().c).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM provisioning_steps WHERE run_id = ?').get(run1.id).c).toBe(9);
  });

  it('the same idempotency key with a DIFFERENT declaration is a 409', async () => {
    const d1 = decl({ slug: 'confa', idempotencyKey: 'shared-key-x' });
    await provisioning.apply({ declaration: d1, user: USER });
    const d2 = decl({ slug: 'confb', idempotencyKey: 'shared-key-x' });
    await expect(provisioning.apply({ declaration: d2, user: USER }))
      .rejects.toMatchObject({ status: 409 });
  });

  it('derives a key when none is supplied and still dedupes identical declarations', async () => {
    const d = decl({ slug: 'derived' });
    delete d.idempotencyKey;
    const r1 = await provisioning.apply({ declaration: d, user: USER });
    const r2 = await provisioning.apply({ declaration: { ...d }, user: USER });
    expect(r2.id).toBe(r1.id);
  });
});

describe('engine failure + resume', () => {
  let db;
  beforeAll(() => { db = getDb(); });

  it('a step failure marks the run failed (resumable); resume completes it', async () => {
    const grantStep = require('../services/provisioning/steps/grant-permissions');
    const orig = grantStep.run;
    grantStep.run = () => { throw new Error('injected boom'); };

    const d = decl({ slug: 'resume' });
    let thrown = null;
    try {
      await provisioning.apply({ declaration: d, user: USER });
    } catch (e) { thrown = e; }
    expect(thrown).toBeTruthy();
    expect(thrown.resumable).toBe(true);

    const runId = thrown.runId;
    let run = provisioning.getRun(runId);
    expect(run.status).toBe('failed');
    // steps 1-6 done, grant_permissions failed, finalize not started
    const byKey = Object.fromEntries(run.steps.map((s) => [s.step_key, s.status]));
    expect(byKey.create_users).toBe('completed');
    expect(byKey.grant_permissions).toBe('failed');
    expect(run.currentStep).toBe(7);

    // Restore the step and resume.
    grantStep.run = orig;
    run = await provisioning.resume(runId, { user: USER });
    expect(run.status).toBe('completed');
    expect(run.currentStep).toBe(9);
    expect(run.steps.every((s) => s.status === 'completed')).toBe(true);

    // No duplication from the partial-then-resumed run.
    expect(db.prepare("SELECT COUNT(*) c FROM tenants WHERE slug = 'resume'").get().c).toBe(1);
    expect(db.prepare("SELECT COUNT(*) c FROM users WHERE username = 'resume-owner'").get().c).toBe(1);
  });

  it('getActiveRun surfaces a failed run and returns null once completed', async () => {
    const hostStep = require('../services/provisioning/steps/create-hosts');
    const orig = hostStep.run;
    hostStep.run = async () => { throw new Error('host boom'); };
    const d = decl({ slug: 'active' });
    try { await provisioning.apply({ declaration: d, user: USER }); } catch { /* expected */ }

    const active = provisioning.getActiveRun();
    expect(active).toBeTruthy();
    expect(active.status).toBe('failed');

    hostStep.run = orig;
    await provisioning.resume(active.id, { user: USER });
    // the just-failed run is now completed; nothing else is pending/running/failed
    expect(provisioning.getRun(active.id).status).toBe('completed');
  });
});

describe('engine.rollback (compensation)', () => {
  let db;
  beforeAll(() => { db = getDb(); });

  it('compensates in reverse: tenant cascade-deleted, users DEACTIVATED (not deleted), host + grants removed', async () => {
    const d = decl({ slug: 'rb' });
    const run = await provisioning.apply({ declaration: d, user: USER });
    const tid = run.tenantId;
    const uid = db.prepare("SELECT id FROM users WHERE username = 'rb-owner'").get().id;
    const hid = db.prepare("SELECT id FROM docker_hosts WHERE name = 'rb-host'").get().id;
    expect(db.prepare('SELECT COUNT(*) c FROM host_permissions WHERE host_id = ?').get(hid).c).toBeGreaterThanOrEqual(1);

    const rb = await provisioning.rollback(run.id, { user: USER });
    expect(rb.status).toBe('rolled_back');
    expect(rb.steps.every((s) => s.status === 'compensated')).toBe(true);

    // tenant + owned children gone (cascade)
    expect(db.prepare('SELECT COUNT(*) c FROM tenants WHERE id = ?').get(tid).c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM tenant_settings WHERE tenant_id = ?').get(tid).c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM tenant_modules WHERE tenant_id = ?').get(tid).c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM user_tenants WHERE tenant_id = ?').get(tid).c).toBe(0);
    // host + grants removed
    expect(db.prepare('SELECT COUNT(*) c FROM docker_hosts WHERE id = ?').get(hid).c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM host_permissions WHERE host_id = ?').get(hid).c).toBe(0);
    // user survives but is DEACTIVATED
    const u = db.prepare('SELECT is_active FROM users WHERE id = ?').get(uid);
    expect(u).toBeTruthy();
    expect(u.is_active).toBe(0);
    // the run itself survives the tenant delete (tenant_id SET NULL)
    expect(db.prepare('SELECT COUNT(*) c FROM provisioning_runs WHERE id = ?').get(run.id).c).toBe(1);
  });

  it('REFUSES to delete the default tenant during rollback, and a failed compensation does not abort the others', async () => {
    // Craft a run whose create_tenant checkpoint points at the DEFAULT tenant (id=1).
    const rid = db.prepare("INSERT INTO provisioning_runs (tenant_id, mode, status, idempotency_key, input_json, current_step, total_steps) VALUES (1, 'production', 'failed', 'rb-default', ?, 2, 8)")
      .run(JSON.stringify(provisioning.validateDeclaration(decl({ slug: 'rbdef' })))).lastInsertRowid;
    db.prepare("INSERT INTO provisioning_steps (run_id, step_key, ordinal, status, checkpoint_json) VALUES (?, 'create_tenant', 1, 'completed', ?)")
      .run(rid, JSON.stringify({ tenantId: 1, created: true }));
    db.prepare("INSERT INTO provisioning_steps (run_id, step_key, ordinal, status, checkpoint_json) VALUES (?, 'set_regional', 2, 'completed', ?)")
      .run(rid, JSON.stringify({ keys: ['locale'] }));

    const rb = await provisioning.rollback(rid, { user: USER });
    expect(rb.status).toBe('rolled_back');
    // default tenant is untouched
    expect(db.prepare('SELECT COUNT(*) c FROM tenants WHERE id = 1 AND is_default = 1').get().c).toBe(1);
    // create_tenant compensation FAILED (refused), set_regional still compensated
    const byKey = Object.fromEntries(rb.steps.map((s) => [s.step_key, s.status]));
    expect(byKey.create_tenant).toBe('failed');
    expect(byKey.set_regional).toBe('compensated');
  });

  it('rollback is idempotent (second call is a no-op)', async () => {
    const run = await provisioning.apply({ declaration: decl({ slug: 'rbidem' }), user: USER });
    await provisioning.rollback(run.id, { user: USER });
    const again = await provisioning.rollback(run.id, { user: USER });
    expect(again.status).toBe('rolled_back');
  });
});

describe('engine secret hygiene + audit', () => {
  let db;
  beforeAll(() => { db = getDb(); });

  it('no secret appears in getRun / export / audit_log, and input_json is wiped after completion', async () => {
    const d = decl({ slug: 'secrets' });
    const run = await provisioning.apply({ declaration: d, user: USER });
    const leak = /PRIVKEY-secrets|Str0ng-P@ss-secrets/;

    expect(leak.test(JSON.stringify(provisioning.getRun(run.id)))).toBe(false);
    expect(leak.test(JSON.stringify(provisioning.exportRun(run.id)))).toBe(false);
    const auditBlob = db.prepare('SELECT group_concat(details) g FROM audit_log').get().g || '';
    expect(leak.test(auditBlob)).toBe(false);

    // input_json redacted (secrets AND their ciphertext removed) after success
    const inputJson = db.prepare('SELECT input_json FROM provisioning_runs WHERE id = ?').get(run.id).input_json;
    expect(inputJson).toContain('<redacted>');
    expect(leak.test(inputJson)).toBe(false);
  });

  it('getRun exposes redacted declaration + step statuses; no checkpoint secrets', async () => {
    const run = await provisioning.apply({ declaration: decl({ slug: 'shape' }), user: USER });
    const shaped = provisioning.getRun(run.id);
    expect(shaped.declaration.hosts[0].secret.sshPrivateKey).toBe('<redacted>');
    expect(shaped.steps.length).toBe(9);
    expect(shaped.steps[0]).not.toHaveProperty('checkpoint_json');
  });

  it('exportRun strips secrets AND drops the idempotencyKey', async () => {
    const run = await provisioning.apply({ declaration: decl({ slug: 'export' }), user: USER });
    const golden = provisioning.exportRun(run.id);
    expect(golden.idempotencyKey).toBeUndefined();
    expect(golden.tenant.slug).toBe('export');
    expect(JSON.stringify(golden)).not.toMatch(/PRIVKEY-export/);
  });

  it('audit hash-chain stays valid after a full run', async () => {
    await provisioning.apply({ declaration: decl({ slug: 'chain' }), user: USER });
    const v = auditService.verify();
    expect(v.valid).toBe(true);
  });

  it('records provisioning_run_start / step_apply / run_complete audit actions', async () => {
    const run = await provisioning.apply({ declaration: decl({ slug: 'auditacts' }), user: USER });
    const actions = db.prepare("SELECT DISTINCT action FROM audit_log WHERE details LIKE ?").all(`%"runId":${run.id}%`).map((r) => r.action);
    expect(actions).toContain('provisioning_run_start');
    expect(actions).toContain('provisioning_step_apply');
    expect(actions).toContain('provisioning_run_complete');
    expect(actions).toContain('tenant_create');
  });
});
