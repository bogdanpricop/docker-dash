'use strict';

// v8.16.0 (Onboarding — Phase 2) — templates, nomenclatures, onboarding-as-code.
//
// Covers: built-in loader idempotency + file-overrides-DB, validateTemplateSpec
// rejection surface (proto-pollution, secret-shaped keys, unknown catalog keys,
// volume caps), the template→declaration merge precedence (user ALWAYS wins),
// the seed_nomenclatures step (idempotent + compensation deletes only what the
// run inserted), save-as-template secret stripping, the `?asTemplate=1` export
// shape, and — the security-critical one — the DD_ONBOARD_FILE headless
// bootstrap gate: it APPLIES on an empty instance and REFUSES on a populated one.
//
// Shares one in-memory DB; each test uses unique slugs/keys to stay isolated.
// The bootstrap block runs LAST because applying it calls completeSetup(), which
// permanently closes the empty-instance gate for the rest of the file.

process.env.APP_SECRET = 'test-secret-key-for-jest-provisioning';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';
process.env.BCRYPT_ROUNDS = '4';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { getDb } = require('../db');
const provisioning = require('../services/provisioning');
const templates = require('../services/provisioning/templates');
const templateMerge = require('../services/provisioning/template-merge');
const bootstrap = require('../services/provisioning/bootstrap');
const authService = require('../services/auth');

const USER = { id: null, username: 'admin-tester', role: 'admin' };
let seq = 0;

function decl(overrides = {}) {
  seq += 1;
  const slug = overrides.slug || `tpl${seq}`;
  const out = {
    version: 1,
    kind: 'onboarding-declaration',
    idempotencyKey: overrides.idempotencyKey || `tplkey-${slug}`,
    // `tenantKind: undefined` (explicitly present) leaves kind UNSET so the
    // template can fill it; omitting the key entirely defaults to 'client'.
    tenant: { slug, name: overrides.name || `Tenant ${slug}`, kind: 'tenantKind' in overrides ? overrides.tenantKind : 'client' },
    mode: overrides.mode || 'production',
    regional: overrides.regional !== undefined ? overrides.regional : { locale: 'en', timezone: 'UTC', currency: 'USD', unitSystem: 'metric' },
    modules: overrides.modules || [{ key: 'hosts' }],
    nomenclatures: overrides.nomenclatures,
    hosts: overrides.hosts || [],
    users: overrides.users || [],
    permissions: overrides.permissions || [],
  };
  if (overrides.template !== undefined) out.template = overrides.template;
  return out;
}

// ── built-in loader ─────────────────────────────────────────────────────────
describe('built-in template loader', () => {
  let db;
  beforeAll(() => { db = getDb(); });

  it('ships the four built-ins and marks them is_builtin=1', () => {
    const r = templates.loadBuiltins(db);
    expect(r.errors).toEqual([]);
    expect(r.loaded).toBe(4);
    const keys = templates.list().filter((t) => t.isBuiltin).map((t) => t.key).sort();
    expect(keys).toEqual(['manufacturing-plant', 'minimal', 'msp-client', 'software-team']);
  });

  it('every built-in file on disk parses + validates', () => {
    const files = fs.readdirSync(templates.TEMPLATES_DIR).filter((f) => f.endsWith('.json'));
    expect(files.length).toBe(4);
    for (const f of files) {
      const raw = JSON.parse(fs.readFileSync(path.join(templates.TEMPLATES_DIR, f), 'utf8'));
      const norm = templates.validateTemplateRecord(raw);
      expect(norm.key).toBe(f.slice(0, -'.json'.length));
      expect(norm.version).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  it('is IDEMPOTENT — a second load changes no row count and no spec', () => {
    const before = db.prepare('SELECT key, spec_json, is_builtin FROM onboarding_templates ORDER BY key').all();
    const countBefore = before.length;
    templates.loadBuiltins(db);
    templates.loadBuiltins(db);
    const after = db.prepare('SELECT key, spec_json, is_builtin FROM onboarding_templates ORDER BY key').all();
    expect(after.length).toBe(countBefore);
    expect(after).toEqual(before);
  });

  it('the FILE overrides the DB row for a built-in key', () => {
    db.prepare("UPDATE onboarding_templates SET name = 'TAMPERED', spec_json = '{}' WHERE key = 'minimal'").run();
    expect(templates.get('minimal').name).toBe('TAMPERED');
    templates.loadBuiltins(db);
    const restored = templates.get('minimal');
    expect(restored.name).toBe('Minimal');
    expect(restored.spec.modules.map((m) => m.key)).toContain('hosts');
    expect(restored.isBuiltin).toBe(true);
  });

  it('a malformed file is skipped, never thrown, and never crashes the loader', () => {
    const bad = path.join(templates.TEMPLATES_DIR, 'zz-broken-test.json');
    fs.writeFileSync(bad, '{ this is not json', 'utf8');
    try {
      const r = templates.loadBuiltins(db);
      expect(r.loaded).toBe(4);
      expect(r.skipped).toBe(1);
      expect(r.errors[0].file).toBe('zz-broken-test.json');
      expect(templates.get('zz-broken-test')).toBeNull();
    } finally { fs.unlinkSync(bad); }
  });

  it('a file whose key does not match its filename is rejected', () => {
    const bad = path.join(templates.TEMPLATES_DIR, 'zz-mismatch-test.json');
    fs.writeFileSync(bad, JSON.stringify({ key: 'something-else', name: 'X', spec: {} }), 'utf8');
    try {
      const r = templates.loadBuiltins(db);
      expect(r.skipped).toBe(1);
      expect(r.errors[0].error).toMatch(/does not match filename/);
      expect(templates.get('something-else')).toBeNull();
    } finally { fs.unlinkSync(bad); }
  });
});

// ── validateTemplateSpec ────────────────────────────────────────────────────
describe('validateTemplateSpec', () => {
  it('normalizes a good spec and DROPS unknown keys', () => {
    const spec = templates.validateTemplateSpec({
      tenant: { kind: 'plant', slug: 'nope' },
      regional: { currency: 'EUR', unitSystem: 'metric', bogus: 'x' },
      modules: ['hosts', { key: 'firewall', enabled: false }],
      nomenclatures: [{ kind: 'environment', code: 'dev', label: 'Dev', sort: 1 }],
      notes: 'hello',
      somethingElse: { a: 1 },
    });
    expect(spec).toEqual({
      tenant: { kind: 'plant' },
      regional: { currency: 'EUR', unitSystem: 'metric' },
      modules: [{ key: 'hosts', enabled: true }, { key: 'firewall', enabled: false }],
      nomenclatures: [{ kind: 'environment', code: 'dev', label: 'Dev', sort: 1 }],
      notes: 'hello',
    });
    expect(spec.tenant.slug).toBeUndefined();
    expect(spec.somethingElse).toBeUndefined();
  });

  it('REJECTS prototype pollution anywhere in the spec', () => {
    expect(() => templates.validateTemplateSpec(JSON.parse('{"__proto__":{"admin":true}}'))).toThrow(/forbidden key/);
    expect(() => templates.validateTemplateSpec(JSON.parse('{"regional":{"constructor":{"x":1}}}'))).toThrow(/forbidden key/);
    expect(() => templates.validateTemplateSpec(JSON.parse('{"a":{"b":{"prototype":1}}}'))).toThrow(/forbidden key/);
  });

  it('REJECTS any secret-shaped key anywhere (a template never carries a credential)', () => {
    for (const bad of [
      { users: [{ username: 'u', password: 'p' }] },
      { regional: { apiKey: 'x' } },
      { hosts: [{ sshPrivateKey: 'k' }] },
      { x: { _enc: 'iv:tag:ct' } },
      { token: 'abc' },
    ]) {
      expect(() => templates.validateTemplateSpec(bad)).toThrow(/secret-shaped key/);
    }
  });

  it('REJECTS inline secret assignments hidden inside otherwise unknown template fields', () => {
    expect(() => templates.validateTemplateSpec({ ignored: {
      environment: ['DATABASE_PASSWORD=must-not-pass-admission'],
    } })).toThrow(expect.objectContaining({ code: 'SECRET_REFERENCE_ADMISSION_FAILED', status: 422,
      details: expect.objectContaining({ documentStored: false, networkCallsStarted: 0 }) }));
  });

  it('REJECTS unknown module keys and unknown nomenclature kinds', () => {
    expect(() => templates.validateTemplateSpec({ modules: ['not-a-module'] })).toThrow(/unknown module key/);
    expect(() => templates.validateTemplateSpec({ nomenclatures: [{ kind: 'bogus', code: 'a', label: 'A' }] })).toThrow(/unknown nomenclature kind/);
  });

  it('REJECTS bad shapes, bad codes, duplicates and over-cap volumes', () => {
    expect(() => templates.validateTemplateSpec(null)).toThrow(/spec is required/);
    expect(() => templates.validateTemplateSpec([])).toThrow(/spec must be an object/);
    expect(() => templates.validateTemplateSpec({ modules: 'hosts' })).toThrow(/must be an array/);
    expect(() => templates.validateTemplateSpec({ regional: { unitSystem: 'furlongs' } })).toThrow(/metric.*imperial/);
    expect(() => templates.validateTemplateSpec({ nomenclatures: [{ kind: 'environment', code: '../etc', label: 'X' }] })).toThrow(/invalid characters/);
    expect(() => templates.validateTemplateSpec({
      nomenclatures: [{ kind: 'environment', code: 'dev', label: 'A' }, { kind: 'environment', code: 'DEV', label: 'B' }],
    })).toThrow(/duplicate/);
    const many = Array.from({ length: 501 }, (_, i) => ({ kind: 'environment', code: `c${i}`, label: 'L' }));
    expect(() => templates.validateTemplateSpec({ nomenclatures: many })).toThrow(/too many entries/);
    expect(() => templates.validateTemplateSpec({ notes: 'x'.repeat(5000) })).toThrow(/exceeds/);
  });

  it('validateTemplateRecord enforces key format (path traversal) + semver', () => {
    expect(() => templates.validateTemplateRecord({ key: '../evil', name: 'X', spec: {} })).toThrow(/template.key must match/);
    expect(() => templates.validateTemplateRecord({ key: 'Bad Key', name: 'X', spec: {} })).toThrow(/template.key must match/);
    expect(() => templates.validateTemplateRecord({ key: 'ok-key', name: 'X', version: 'v1', spec: {} })).toThrow(/semver/);
    expect(() => templates.validateTemplateRecord({ key: 'ok-key', spec: {} })).toThrow(/template.name is required/);
    expect(templates.validateTemplateRecord({ key: 'ok-key', name: 'X', spec: {} }).version).toBe('1.0.0');
  });
});

// ── custom template CRUD ────────────────────────────────────────────────────
describe('custom templates', () => {
  it('saves, reads back and deletes a custom template', () => {
    const saved = templates.saveCustom({
      key: 'my-preset', name: 'My Preset', description: 'd', industry: 'general', version: '2.1.0',
      spec: { modules: ['hosts', 'registries'], regional: { currency: 'GBP' } },
    }, USER);
    expect(saved.isBuiltin).toBe(false);
    expect(saved.createdBy).toBe('admin-tester');
    expect(templates.get('my-preset').spec.regional.currency).toBe('GBP');
    expect(templates.remove('my-preset')).toBe(true);
    expect(templates.get('my-preset')).toBeNull();
  });

  it('REFUSES to shadow a built-in key (409) or delete a built-in (400)', () => {
    expect(() => templates.saveCustom({ key: 'minimal', name: 'Hijack', spec: {} }, USER))
      .toThrow(/built-in template key/);
    expect(() => templates.remove('minimal')).toThrow(/cannot be deleted/);
    expect(templates.get('minimal').name).toBe('Minimal');
  });

  it('removing an unknown key is a 404', () => {
    let err = null;
    try { templates.remove('does-not-exist'); } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.status).toBe(404);
  });
});

// ── template → declaration merge ────────────────────────────────────────────
describe('template → declaration merge (user ALWAYS wins)', () => {
  beforeAll(() => { templates.loadBuiltins(getDb()); });

  it('fills gaps from the template but never overrides an explicit user value', () => {
    const merged = provisioning.validateDeclaration(decl({
      slug: 'merge1',
      template: 'manufacturing-plant',
      tenantKind: undefined,                       // template supplies 'plant'
      regional: { currency: 'RON' },               // user wins on currency only
      modules: [{ key: 'git' }],                   // appended to the template's set
    }));

    expect(merged.tenant.kind).toBe('plant');           // from template
    expect(merged.regional.currency).toBe('RON');       // USER wins
    expect(merged.regional.timezone).toBe('Europe/Bucharest'); // from template
    expect(merged.regional.unitSystem).toBe('metric');  // from template
    const mods = merged.modules.map((m) => m.key);
    expect(mods).toEqual(expect.arrayContaining(['hosts', 'firewall', 'posture', 'reconciler', 'teams', 'git']));
    expect(merged.nomenclatures.length).toBeGreaterThan(10);
    expect(merged.template).toBe('manufacturing-plant');
  });

  it('an explicit tenant.kind beats the template kind', () => {
    const merged = provisioning.validateDeclaration(decl({ slug: 'merge2', template: 'manufacturing-plant', tenantKind: 'client' }));
    expect(merged.tenant.kind).toBe('client');
  });

  it('a user module entry overrides the template enabled flag (no duplicate key)', () => {
    const merged = provisioning.validateDeclaration(decl({
      slug: 'merge3', template: 'manufacturing-plant', modules: [{ key: 'firewall', enabled: false }],
    }));
    const fw = merged.modules.filter((m) => m.key === 'firewall');
    expect(fw.length).toBe(1);
    expect(fw[0].enabled).toBe(false);
  });

  it('a user nomenclature overrides the template entry with the same (kind, code)', () => {
    const merged = provisioning.validateDeclaration(decl({
      slug: 'merge4', template: 'software-team',
      nomenclatures: [
        { kind: 'environment', code: 'dev', label: 'MY DEV', sort: 99 },
        { kind: 'environment', code: 'sandbox', label: 'Sandbox' },
      ],
    }));
    const envs = merged.nomenclatures.filter((n) => n.kind === 'environment');
    const dev = envs.filter((n) => n.code === 'dev');
    expect(dev.length).toBe(1);
    expect(dev[0].label).toBe('MY DEV');
    expect(dev[0].sort).toBe(99);
    expect(envs.some((n) => n.code === 'staging')).toBe(true);   // template survives
    expect(envs.some((n) => n.code === 'sandbox')).toBe(true);   // user addition survives
  });

  it("template 'custom' / absent is a no-op; an unknown key is a hard error", () => {
    expect(provisioning.validateDeclaration(decl({ slug: 'merge5', template: 'custom' })).nomenclatures).toEqual([]);
    expect(provisioning.validateDeclaration(decl({ slug: 'merge6' })).nomenclatures).toEqual([]);
    expect(() => provisioning.validateDeclaration(decl({ slug: 'merge7', template: 'no-such-template' })))
      .toThrow(/unknown template/);
  });

  it('does NOT merge template roles/users into the declaration (a template never mints an account)', () => {
    const merged = provisioning.validateDeclaration(decl({ slug: 'merge8', template: 'msp-client' }));
    expect(merged.users).toEqual([]);
    expect(merged.roles).toBeUndefined();
    expect(templates.get('msp-client').spec.roles.length).toBeGreaterThan(0); // present in the spec, just not merged
  });

  it('mergeSpecIntoDoc never mutates the input document', () => {
    const doc = { regional: { currency: 'USD' }, modules: [{ key: 'hosts' }] };
    const snapshot = JSON.stringify(doc);
    templateMerge.mergeSpecIntoDoc(doc, { regional: { timezone: 'UTC' }, modules: [{ key: 'git', enabled: true }] });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('the MERGED declaration is what gets fingerprinted + stored', async () => {
    const run = await provisioning.apply({ declaration: decl({ slug: 'mergestore', template: 'software-team' }), user: USER });
    const stored = provisioning.getRun(run.id).declaration;
    expect(stored.regional.timezone).toBe('UTC');
    expect(stored.nomenclatures.length).toBeGreaterThan(10);
    expect(stored.modules.map((m) => m.key)).toContain('git');
  });
});

// ── seed_nomenclatures step ─────────────────────────────────────────────────
describe('seed_nomenclatures step', () => {
  let db;
  beforeAll(() => { db = getDb(); });

  const NOMS = [
    { kind: 'environment', code: 'dev', label: 'Development', sort: 1 },
    { kind: 'environment', code: 'prod', label: 'Production', sort: 2 },
    { kind: 'severity', code: 'sev1', label: 'SEV1', sort: 1, meta: { color: 'red' } },
  ];

  it('seeds the declaration nomenclatures for the tenant', async () => {
    const run = await provisioning.apply({ declaration: decl({ slug: 'noms', nomenclatures: NOMS }), user: USER });
    expect(run.status).toBe('completed');
    const rows = db.prepare('SELECT * FROM nomenclatures WHERE tenant_id = ? ORDER BY kind, sort').all(run.tenantId);
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.code)).toEqual(['dev', 'prod', 'sev1']);
    expect(JSON.parse(rows[2].meta_json)).toEqual({ color: 'red' });
    expect(run.result.created.nomenclatures).toBe(3);
  });

  it('is IDEMPOTENT — a fresh run over the same tenant upserts, never duplicates', async () => {
    const first = await provisioning.apply({ declaration: decl({ slug: 'nomidem', nomenclatures: NOMS }), user: USER });
    const tid = first.tenantId;
    // A DIFFERENT run (new idempotency key) against the SAME tenant slug, with a
    // relabelled entry — the natural key (tenant_id, kind, code) absorbs it.
    const changed = NOMS.map((n) => (n.code === 'dev' ? { ...n, label: 'Dev v2' } : n));
    const second = await provisioning.apply({
      declaration: decl({ slug: 'nomidem', idempotencyKey: 'nomidem-2', nomenclatures: changed }),
      user: USER,
    });
    expect(second.tenantId).toBe(tid);
    const rows = db.prepare('SELECT * FROM nomenclatures WHERE tenant_id = ?').all(tid);
    expect(rows.length).toBe(3);
    expect(rows.find((r) => r.code === 'dev').label).toBe('Dev v2');
    const cp = JSON.parse(db.prepare("SELECT checkpoint_json c FROM provisioning_steps WHERE run_id = ? AND step_key = 'seed_nomenclatures'").get(second.id).c);
    expect(cp.inserted).toEqual([]); // nothing NEW was inserted the second time
    expect(cp.updated).toBe(3);
  });

  it('compensation deletes ONLY the rows this run inserted', async () => {
    const first = await provisioning.apply({
      declaration: decl({ slug: 'nomcomp', nomenclatures: [{ kind: 'environment', code: 'pre', label: 'Pre-existing' }] }),
      user: USER,
    });
    const tid = first.tenantId;

    const second = await provisioning.apply({
      declaration: decl({
        slug: 'nomcomp', idempotencyKey: 'nomcomp-2',
        nomenclatures: [
          { kind: 'environment', code: 'pre', label: 'Pre-existing (touched)' }, // updated, not inserted
          { kind: 'environment', code: 'new', label: 'Brand new' },              // inserted
        ],
      }),
      user: USER,
    });
    expect(db.prepare('SELECT COUNT(*) c FROM nomenclatures WHERE tenant_id = ?').get(tid).c).toBe(2);

    // Compensate JUST the step (not the whole run — that would cascade the tenant).
    const step = require('../services/provisioning/steps/seed-nomenclatures');
    const cp = JSON.parse(db.prepare("SELECT checkpoint_json c FROM provisioning_steps WHERE run_id = ? AND step_key = 'seed_nomenclatures'").get(second.id).c);
    expect(cp.inserted).toEqual([{ kind: 'environment', code: 'new' }]);

    const ctx = { db, tenantId: tid, log: console };
    step.compensate(ctx, cp);
    const left = db.prepare('SELECT code FROM nomenclatures WHERE tenant_id = ?').all(tid).map((r) => r.code);
    expect(left).toEqual(['pre']);           // the pre-existing row SURVIVES
    step.compensate(ctx, cp);                // idempotent: a second pass is a no-op
    expect(db.prepare('SELECT COUNT(*) c FROM nomenclatures WHERE tenant_id = ?').get(tid).c).toBe(1);
  });

  it('full rollback removes the tenant and its nomenclatures via the cascade', async () => {
    const run = await provisioning.apply({ declaration: decl({ slug: 'nomrb', nomenclatures: NOMS }), user: USER });
    const tid = run.tenantId;
    expect(db.prepare('SELECT COUNT(*) c FROM nomenclatures WHERE tenant_id = ?').get(tid).c).toBe(3);
    await provisioning.rollback(run.id, { user: USER });
    expect(db.prepare('SELECT COUNT(*) c FROM nomenclatures WHERE tenant_id = ?').get(tid).c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM tenants WHERE id = ?').get(tid).c).toBe(0);
  });

  it('the step is a no-op when the declaration has no nomenclatures', async () => {
    const run = await provisioning.apply({ declaration: decl({ slug: 'nomnone' }), user: USER });
    expect(run.steps.find((s) => s.step_key === 'seed_nomenclatures').status).toBe('completed');
    expect(db.prepare('SELECT COUNT(*) c FROM nomenclatures WHERE tenant_id = ?').get(run.tenantId).c).toBe(0);
  });
});

// ── save-as-template + export?asTemplate=1 ──────────────────────────────────
describe('save-as-template / golden-config export', () => {
  it('specFromDeclaration STRIPS every secret (hosts dropped, passwords never copied)', () => {
    const spec = templates.specFromDeclaration({
      tenant: { slug: 'x', kind: 'client' },
      regional: { currency: 'EUR' },
      modules: [{ key: 'hosts', enabled: true }],
      nomenclatures: [{ kind: 'environment', code: 'dev', label: 'Dev' }],
      hosts: [{ name: 'h1', connectionType: 'ssh', sshHost: '10.0.0.5', secret: { sshPrivateKey: 'SUPER-SECRET-KEY' } }],
      users: [{ username: 'owner', role: 'admin', isOwner: true, password: { _enc: 'iv:tag:ct' } }],
    });
    const blob = JSON.stringify(spec);
    expect(blob).not.toMatch(/SUPER-SECRET-KEY/);
    expect(blob).not.toMatch(/iv:tag:ct/);
    expect(spec.hosts).toBeUndefined();
    expect(spec.users).toEqual([{ username: 'owner', role: 'admin', isOwner: true }]);
    expect(spec.tenant).toEqual({ kind: 'client' });
  });

  it('a saved template round-trips through saveCustom without leaking a secret', async () => {
    const run = await provisioning.apply({
      declaration: decl({
        slug: 'saveastpl',
        hosts: [{ name: 'saveastpl-host', connectionType: 'ssh', sshHost: '10.0.0.9', sshUsername: 'root', secret: { sshPrivateKey: 'PRIVKEY-saveastpl' } }],
        users: [{ username: 'saveastpl-owner', role: 'admin', isOwner: true, password: 'Str0ng-P@ss-saveastpl!' }],
        permissions: [],
      }),
      user: USER,
    });
    const golden = provisioning.exportRun(run.id);
    const saved = templates.saveCustom({
      key: 'from-run', name: 'From Run', spec: templates.specFromDeclaration(golden),
    }, USER);
    const blob = JSON.stringify(saved);
    expect(blob).not.toMatch(/PRIVKEY-saveastpl|Str0ng-P@ss-saveastpl/);
    expect(blob).not.toMatch(/<redacted>/);
    templates.remove('from-run');
  });

  it('exportRun pins the template key that was used', async () => {
    const run = await provisioning.apply({ declaration: decl({ slug: 'exptpl', template: 'msp-client' }), user: USER });
    expect(provisioning.exportRun(run.id).template).toBe('msp-client');
  });

  it('exportRunAsTemplate emits a document that validateTemplateRecord accepts', async () => {
    const run = await provisioning.apply({
      declaration: decl({
        slug: 'astemplate', template: 'software-team',
        hosts: [{ name: 'astemplate-host', connectionType: 'ssh', sshHost: '10.0.0.7', sshUsername: 'root', secret: { sshPrivateKey: 'PRIVKEY-astemplate' } }],
      }),
      user: USER,
    });
    const doc = provisioning.exportRunAsTemplate(run.id);
    expect(doc).toMatchObject({ key: 'astemplate-template', version: '1.0.0' });
    expect(doc.spec.modules.map((m) => m.key)).toContain('git');
    expect(doc.spec.nomenclatures.length).toBeGreaterThan(10);
    expect(doc.spec.hosts).toBeUndefined();
    expect(JSON.stringify(doc)).not.toMatch(/PRIVKEY-astemplate/);
    // It is directly POST-able to /templates.
    expect(() => templates.validateTemplateRecord(doc)).not.toThrow();
    expect(provisioning.exportRunAsTemplate(999999)).toBeNull();
  });
});

// ── DD_ONBOARD_FILE headless bootstrap (SECURITY-CRITICAL) ──────────────────
// Runs LAST: a successful apply calls completeSetup(), which permanently closes
// the empty-instance gate for this in-memory DB.
describe('DD_ONBOARD_FILE headless bootstrap', () => {
  let db;
  let tmpDir;
  const written = [];

  beforeAll(() => {
    db = getDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-onboard-'));
  });
  afterAll(() => {
    for (const f of written) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
    try { fs.rmdirSync(tmpDir); } catch { /* non-empty / gone */ }
    require('../db').closeDb();
  });

  function writeDecl(name, body) {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, JSON.stringify(body), 'utf8');
    written.push(p);
    return p;
  }

  it('is a no-op when DD_ONBOARD_FILE is unset', async () => {
    const r = await bootstrap.maybeBootstrap({ filePath: undefined });
    expect(r).toEqual({ applied: false, reason: 'not-configured' });
  });

  it('REFUSES on a populated instance (a non-default tenant exists) and writes nothing', async () => {
    // The suites above already provisioned several tenants, so the instance is
    // populated even though setup_completed is still false.
    expect(db.prepare('SELECT COUNT(*) c FROM tenants WHERE is_default = 0').get().c).toBeGreaterThan(0);
    const gate = bootstrap.isEmptyInstance();
    expect(gate.empty).toBe(false);
    expect(gate.reason).toMatch(/non-default tenant/);

    const file = writeDecl('populated.json', {
      version: 1, kind: 'onboarding-declaration', idempotencyKey: 'headless-populated',
      tenant: { slug: 'headless-populated', name: 'Headless Populated' },
      mode: 'production', modules: [{ key: 'hosts' }],
    });
    const tenantsBefore = db.prepare('SELECT COUNT(*) c FROM tenants').get().c;
    const runsBefore = db.prepare('SELECT COUNT(*) c FROM provisioning_runs').get().c;

    const r = await bootstrap.maybeBootstrap({ filePath: file });
    expect(r.applied).toBe(false);
    expect(r.reason).toMatch(/^refused:/);
    expect(db.prepare('SELECT COUNT(*) c FROM tenants').get().c).toBe(tenantsBefore);
    expect(db.prepare('SELECT COUNT(*) c FROM provisioning_runs').get().c).toBe(runsBefore);
    expect(db.prepare("SELECT COUNT(*) c FROM tenants WHERE slug = 'headless-populated'").get().c).toBe(0);
    expect(db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'onboarding_headless_apply'").get().c).toBe(0);
  });

  it('REFUSES once setup is complete, even on an otherwise empty instance', () => {
    const original = authService.isSetupComplete;
    authService.isSetupComplete = () => true;
    try {
      const gate = bootstrap.isEmptyInstance();
      expect(gate.empty).toBe(false);
      expect(gate.reason).toMatch(/setup already completed/);
    } finally { authService.isSetupComplete = original; }
  });

  it('APPLIES on an empty instance, audits the act, and completes setup (one-shot)', async () => {
    // Simulate a genuinely fresh install: no non-default tenants, no completed
    // runs, setup_completed=false.
    db.prepare('DELETE FROM provisioning_steps').run();
    db.prepare('DELETE FROM provisioning_runs').run();
    db.prepare('DELETE FROM tenants WHERE is_default = 0').run();
    db.prepare("UPDATE settings SET value = 'false' WHERE key = 'setup_completed'").run();
    expect(bootstrap.isEmptyInstance().empty).toBe(true);
    expect(authService.isSetupComplete()).toBe(false);

    const file = writeDecl('empty.json', {
      version: 1, kind: 'onboarding-declaration', idempotencyKey: 'headless-empty',
      tenant: { slug: 'headless-empty', name: 'Headless Empty', kind: 'client' },
      mode: 'production',
      template: 'software-team',
      regional: { currency: 'EUR' },
      users: [{ username: 'headless-owner', role: 'admin', isOwner: true, password: 'Str0ng-P@ss-headless!' }],
    });

    const r = await bootstrap.maybeBootstrap({ filePath: file });
    expect(r.applied).toBe(true);
    expect(r.status).toBe('completed');

    const tenant = db.prepare("SELECT * FROM tenants WHERE slug = 'headless-empty'").get();
    expect(tenant).toBeTruthy();
    expect(tenant.status).toBe('active');
    expect(tenant.created_by).toBe('system-bootstrap');
    // template defaults were merged in (software-team ships environments)
    expect(db.prepare('SELECT COUNT(*) c FROM nomenclatures WHERE tenant_id = ?').get(tenant.id).c).toBeGreaterThan(10);

    const audit = db.prepare("SELECT * FROM audit_log WHERE action = 'onboarding_headless_apply' ORDER BY id DESC LIMIT 1").get();
    expect(audit).toBeTruthy();
    expect(audit.username).toBe('system-bootstrap');
    const details = JSON.parse(audit.details);
    expect(details.source).toBe('DD_ONBOARD_FILE');
    expect(details.tenantSlug).toBe('headless-empty');
    expect(audit.details).not.toMatch(/Str0ng-P@ss-headless/);

    // The gate is now closed — a restart re-reading the SAME file refuses.
    expect(authService.isSetupComplete()).toBe(true);
    const again = await bootstrap.maybeBootstrap({ filePath: file });
    expect(again.applied).toBe(false);
    expect(again.reason).toMatch(/setup already completed/);
    expect(db.prepare("SELECT COUNT(*) c FROM tenants WHERE slug = 'headless-empty'").get().c).toBe(1);
  });

  it('an unreadable / malformed file aborts WITHOUT throwing and without provisioning', async () => {
    db.prepare("UPDATE settings SET value = 'false' WHERE key = 'setup_completed'").run();
    db.prepare('DELETE FROM provisioning_steps').run();
    db.prepare('DELETE FROM provisioning_runs').run();
    db.prepare('DELETE FROM tenants WHERE is_default = 0').run();
    expect(bootstrap.isEmptyInstance().empty).toBe(true);

    const missing = await bootstrap.maybeBootstrap({ filePath: path.join(tmpDir, 'nope.json') });
    expect(missing.applied).toBe(false);
    expect(missing.reason).toMatch(/unreadable/);

    const badPath = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(badPath, 'not json at all', 'utf8');
    written.push(badPath);
    const bad = await bootstrap.maybeBootstrap({ filePath: badPath });
    expect(bad.applied).toBe(false);
    expect(bad.reason).toMatch(/not valid JSON/);

    // Setup is still NOT complete and nothing was provisioned.
    expect(authService.isSetupComplete()).toBe(false);
    expect(db.prepare('SELECT COUNT(*) c FROM tenants WHERE is_default = 0').get().c).toBe(0);
  });

  it('a declaration the validator rejects fails closed (no throw, no writes, setup not completed)', async () => {
    const file = writeDecl('wire-tenant.json', {
      version: 1, kind: 'onboarding-declaration',
      tenant_id: 3,                                   // TC-02: wire-supplied tenant id
      tenant: { slug: 'headless-bad', name: 'Bad' },
      mode: 'production',
    });
    const r = await bootstrap.maybeBootstrap({ filePath: file });
    expect(r.applied).toBe(false);
    expect(r.reason).toMatch(/tenant_id is not allowed/);
    expect(db.prepare("SELECT COUNT(*) c FROM tenants WHERE slug = 'headless-bad'").get().c).toBe(0);
    expect(authService.isSetupComplete()).toBe(false);
  });
});
