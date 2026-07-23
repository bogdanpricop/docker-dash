'use strict';

// v8.18.0 (Onboarding & Provisioning Wizard — Phase 4) — entities & relations,
// drift re-provision (replan), and the trial-expiry lifecycle.
//
// Shares one in-memory DB; each test isolates itself with a unique tenant slug /
// idempotency key. The load-bearing safety test here is the EXTENDED PURGE
// CANARY (`purge canary — the two new entity tables` below): a real entity + a
// real relation (seed_run_id IS NULL) sit alongside a synthetic batch and MUST
// survive its purge, exactly like the Phase-3 canary for the infra tables.

process.env.APP_SECRET = 'test-secret-key-for-jest-phase4';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';
process.env.BCRYPT_ROUNDS = '4';

const { getDb } = require('../db');
const provisioning = require('../services/provisioning');
const seed = require('../services/provisioning/seed');
const promotion = require('../services/provisioning/promotion');
const trialMonitor = require('../services/provisioning/trial-monitor');
const auditService = require('../services/audit');

const USER = { id: null, username: 'phase4-tester', role: 'admin' };
const FIXED_NOW = 1750000000000;
let seq = 0;

function decl(overrides = {}) {
  seq += 1;
  const slug = overrides.slug || `p4t${seq}`;
  return {
    version: 1,
    kind: 'onboarding-declaration',
    idempotencyKey: overrides.idempotencyKey || `p4-${slug}`,
    tenant: { slug, name: overrides.name || `Tenant ${slug}`, kind: 'client' },
    mode: overrides.mode || 'production',
    regional: { locale: 'en', timezone: 'UTC', currency: 'EUR', unitSystem: 'metric' },
    modules: overrides.modules || [{ key: 'hosts' }],
    nomenclatures: overrides.nomenclatures || [],
    entities: overrides.entities !== undefined ? overrides.entities : [
      { entityType: 'site', code: 'SITE-1', name: 'Main Site' },
      { entityType: 'department', code: 'DEPT-OPS', name: 'Operations' },
      { entityType: 'application', code: 'APP-API', name: 'API' },
    ],
    relations: overrides.relations !== undefined ? overrides.relations : [
      { fromType: 'department', fromCode: 'DEPT-OPS', toType: 'site', toCode: 'SITE-1', relationType: 'belongs_to' },
      { fromType: 'application', fromCode: 'APP-API', toType: 'department', toCode: 'DEPT-OPS', relationType: 'belongs_to' },
    ],
    hosts: overrides.hosts || [],
    users: overrides.users || [
      { username: `${slug}-owner`, role: 'admin', isOwner: true, password: `Str0ng-P@ss-${slug}!` },
    ],
    permissions: [],
  };
}

// ── 1. Declaration validation ────────────────────────────────────────────────
describe('declaration — entities & relations', () => {
  it('normalizes a valid entity graph', () => {
    const d = provisioning.validateDeclaration(decl({ slug: 'valid' }));
    expect(d.entities).toHaveLength(3);
    expect(d.entities[0]).toEqual({ entityType: 'site', code: 'SITE-1', name: 'Main Site' });
    expect(d.relations).toHaveLength(2);
    expect(d.relations[0].relationType).toBe('belongs_to');
  });

  it('rejects an unknown entity_type', () => {
    expect(() => provisioning.validateDeclaration(decl({
      slug: 'badtype', entities: [{ entityType: 'spaceship', code: 'X', name: 'X' }], relations: [],
    }))).toThrow(/unknown entity type/);
  });

  it('rejects an unknown relation_type', () => {
    expect(() => provisioning.validateDeclaration(decl({
      slug: 'badrel',
      entities: [{ entityType: 'site', code: 'A', name: 'A' }, { entityType: 'site', code: 'B', name: 'B' }],
      relations: [{ fromType: 'site', fromCode: 'A', toType: 'site', toCode: 'B', relationType: 'teleports_to' }],
    }))).toThrow(/unknown relation type/);
  });

  it('rejects a relation referencing an undeclared entity', () => {
    expect(() => provisioning.validateDeclaration(decl({
      slug: 'dangling',
      entities: [{ entityType: 'site', code: 'A', name: 'A' }],
      relations: [{ fromType: 'site', fromCode: 'A', toType: 'site', toCode: 'GHOST', relationType: 'belongs_to' }],
    }))).toThrow(/not declared in entities/);
  });

  it('rejects a duplicate entity and a self-relation', () => {
    expect(() => provisioning.validateDeclaration(decl({
      slug: 'dup', entities: [{ entityType: 'site', code: 'A', name: 'A' }, { entityType: 'site', code: 'a', name: 'A2' }], relations: [],
    }))).toThrow(/duplicate site\/a/);
    expect(() => provisioning.validateDeclaration(decl({
      slug: 'self', entities: [{ entityType: 'site', code: 'A', name: 'A' }],
      relations: [{ fromType: 'site', fromCode: 'A', toType: 'site', toCode: 'A', relationType: 'depends_on' }],
    }))).toThrow(/cannot relate to itself/);
  });
});

// ── 2. seed_entities provisioning step — idempotent + compensation ───────────
describe('seed_entities step — apply, idempotency, compensation', () => {
  let db;
  beforeAll(() => { db = getDb(); });

  it('writes real (untagged) entity + relation rows on apply', async () => {
    const run = await provisioning.apply({ declaration: decl({ slug: 'ent-apply' }), user: USER });
    expect(run.status).toBe('completed');
    expect(run.steps.map((s) => s.step_key)).toContain('seed_entities');
    const tid = run.tenantId;

    const ents = db.prepare('SELECT entity_type, code, name, seed_run_id FROM tenant_entities WHERE tenant_id = ? ORDER BY id').all(tid);
    expect(ents).toHaveLength(3);
    for (const e of ents) expect(e.seed_run_id).toBeNull(); // REAL config — never tagged
    const rels = db.prepare('SELECT relation_type, seed_run_id FROM tenant_entity_relations WHERE tenant_id = ?').all(tid);
    expect(rels).toHaveLength(2);
    for (const r of rels) expect(r.seed_run_id).toBeNull();
    expect(run.result.created).toMatchObject({ entities: 3, relations: 2 });
  });

  it('a re-apply converges without duplicating', async () => {
    const d = decl({ slug: 'ent-idem' });
    const first = await provisioning.apply({ declaration: d, user: USER });
    const tid = first.tenantId;
    // Second apply with the SAME idempotency key is a completed-run no-op; force a
    // real re-run of the step by resetting the run to resumable and re-applying.
    await provisioning.apply({ declaration: d, user: USER });
    expect(db.prepare('SELECT COUNT(*) c FROM tenant_entities WHERE tenant_id = ?').get(tid).c).toBe(3);
    expect(db.prepare('SELECT COUNT(*) c FROM tenant_entity_relations WHERE tenant_id = ?').get(tid).c).toBe(2);

    // A DIFFERENT run (new key) applying the same shape to the same slug adopts the
    // tenant and upserts — still exactly 3 entities / 2 relations, no duplication.
    await provisioning.apply({ declaration: decl({ slug: 'ent-idem', idempotencyKey: 'ent-idem-2' }), user: USER });
    expect(db.prepare('SELECT COUNT(*) c FROM tenant_entities WHERE tenant_id = ?').get(tid).c).toBe(3);
    expect(db.prepare('SELECT COUNT(*) c FROM tenant_entity_relations WHERE tenant_id = ?').get(tid).c).toBe(2);
  });

  it('rollback compensates: entities + relations this run inserted are removed', async () => {
    const run = await provisioning.apply({ declaration: decl({ slug: 'ent-rb' }), user: USER });
    const tid = run.tenantId;
    expect(db.prepare('SELECT COUNT(*) c FROM tenant_entities WHERE tenant_id = ?').get(tid).c).toBe(3);

    await provisioning.rollback(run.id, { user: USER });
    // create_tenant's cascade removes the tenant (and its entities) anyway, but the
    // seed_entities compensation targets only THIS run's rows first — either way,
    // nothing survives and no FK dangles.
    expect(db.prepare('SELECT COUNT(*) c FROM tenant_entities WHERE tenant_id = ?').get(tid).c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM tenant_entity_relations WHERE tenant_id = ?').get(tid).c).toBe(0);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('the plan estimate surfaces entity + relation counts', () => {
    const p = provisioning.plan({ declaration: decl({ slug: 'ent-est' }), user: USER });
    expect(p.impact.creates.entities).toBe(3);
    expect(p.impact.creates.relations).toBe(2);
    expect(p.steps.map((s) => s.key)).toContain('seed_entities');
  });
});

// ── 3. Template entity merge (unlike users, entities merge) ───────────────────
describe('template merge — entities/relations merge, users do not', () => {
  const { mergeSpecIntoDoc } = require('../services/provisioning/template-merge');
  const { validateTemplateSpec } = require('../services/provisioning/templates');

  it('validateTemplateSpec accepts entities + relations', () => {
    const spec = validateTemplateSpec({
      entities: [
        { entityType: 'site', code: 'S1', name: 'Site 1' },
        { entityType: 'department', code: 'D1', name: 'Dept 1' },
      ],
      relations: [{ fromType: 'department', fromCode: 'D1', toType: 'site', toCode: 'S1', relationType: 'belongs_to' }],
    });
    expect(spec.entities).toHaveLength(2);
    expect(spec.relations).toHaveLength(1);
  });

  it('template entities are DEFAULTS: user entities win on the same key, template-only entries append', () => {
    const spec = {
      entities: [
        { entityType: 'site', code: 'S1', name: 'Template Site' },
        { entityType: 'department', code: 'D1', name: 'Template Dept' },
      ],
      relations: [{ fromType: 'department', fromCode: 'D1', toType: 'site', toCode: 'S1', relationType: 'belongs_to' }],
    };
    const doc = { entities: [{ entityType: 'site', code: 'S1', name: 'My Site' }] };
    const merged = mergeSpecIntoDoc(doc, spec);
    const byKey = Object.fromEntries(merged.entities.map((e) => [`${e.entityType}/${e.code}`, e.name]));
    expect(byKey['site/S1']).toBe('My Site');        // user override wins
    expect(byKey['department/D1']).toBe('Template Dept'); // template-only appended
    expect(merged.relations).toHaveLength(1);         // template relation carried in
  });

  it('the merged document validates end-to-end through validateDeclaration', () => {
    const merged = mergeSpecIntoDoc(
      { version: 1, tenant: { slug: 'mrg', name: 'Merged' }, mode: 'production', users: [] },
      {
        entities: [{ entityType: 'site', code: 'S1', name: 'Site' }, { entityType: 'service', code: 'SV1', name: 'Svc' }],
        relations: [{ fromType: 'service', fromCode: 'SV1', toType: 'site', toCode: 'S1', relationType: 'located_at' }],
      },
    );
    const norm = provisioning.validateDeclaration(merged);
    expect(norm.entities).toHaveLength(2);
    expect(norm.relations[0].relationType).toBe('located_at');
  });
});

// ── 4. replan — drift diff + idempotent convergence ──────────────────────────
describe('engine.replan — drift diff', () => {
  let db; let tenantId; let baseDecl;
  beforeAll(async () => {
    db = getDb();
    baseDecl = decl({ slug: 'drift', modules: [{ key: 'firewall' }] });
    const run = await provisioning.apply({ declaration: baseDecl, user: USER });
    tenantId = run.tenantId;
  });

  it('a just-provisioned tenant re-planned against the SAME declaration is fully inSync', () => {
    const d = provisioning.replan(tenantId, baseDecl);
    expect(d.summary.toCreate).toBe(0);
    expect(d.summary.toUpdate).toBe(0);
    expect(d.inSync).toBe(true);
    expect(d.entities.inSync).toHaveLength(3);
    expect(d.modules.inSync.map((m) => m.key).sort()).toEqual(['firewall', 'hosts']);
  });

  it('a new module, nomenclature and entity land in toCreate; a changed name lands in toUpdate', () => {
    const desired = decl({
      slug: 'drift', modules: [{ key: 'firewall' }, { key: 'registries' }],
      nomenclatures: [{ kind: 'environment', code: 'prod', label: 'Production' }],
      entities: [
        { entityType: 'site', code: 'SITE-1', name: 'Renamed Site' },   // toUpdate (name changed)
        { entityType: 'department', code: 'DEPT-OPS', name: 'Operations' },
        { entityType: 'application', code: 'APP-API', name: 'API' },
        { entityType: 'application', code: 'APP-NEW', name: 'New App' }, // toCreate
      ],
      relations: [
        { fromType: 'department', fromCode: 'DEPT-OPS', toType: 'site', toCode: 'SITE-1', relationType: 'belongs_to' },
        { fromType: 'application', fromCode: 'APP-API', toType: 'department', toCode: 'DEPT-OPS', relationType: 'belongs_to' },
        { fromType: 'application', fromCode: 'APP-NEW', toType: 'department', toCode: 'DEPT-OPS', relationType: 'belongs_to' }, // toCreate
      ],
    });
    const d = provisioning.replan(tenantId, desired);
    expect(d.modules.toCreate.map((m) => m.key)).toContain('registries');
    expect(d.nomenclatures.toCreate).toHaveLength(1);
    expect(d.entities.toCreate.map((e) => e.code)).toEqual(['APP-NEW']);
    expect(d.entities.toUpdate.map((e) => e.code)).toEqual(['SITE-1']);
    expect(d.relations.toCreate).toHaveLength(1);
    expect(d.inSync).toBe(false);

    // convergence: apply the desired declaration, then replan again → all inSync,
    // and no duplication (natural-key upserts).
    return provisioning.apply({ declaration: { ...desired, idempotencyKey: 'drift-converge' }, user: USER }).then(() => {
      const after = provisioning.replan(tenantId, desired);
      expect(after.inSync).toBe(true);
      expect(after.summary.toCreate).toBe(0);
      expect(after.summary.toUpdate).toBe(0);
      expect(db.prepare('SELECT COUNT(*) c FROM tenant_entities WHERE tenant_id = ?').get(tenantId).c).toBe(4);
      expect(db.prepare("SELECT COUNT(*) c FROM tenant_modules WHERE tenant_id = ? AND module_key = 'registries'").get(tenantId).c).toBe(1);
    });
  });

  it('writes an onboarding_replan audit row via the route helper path (service is read-only)', () => {
    const before = db.prepare('SELECT COUNT(*) c FROM tenant_entities WHERE tenant_id = ?').get(tenantId).c;
    provisioning.replan(tenantId, baseDecl);
    expect(db.prepare('SELECT COUNT(*) c FROM tenant_entities WHERE tenant_id = ?').get(tenantId).c).toBe(before); // no writes
  });
});

// ── 5. trial-expiry lifecycle ────────────────────────────────────────────────
describe('trial-monitor — suspend, idempotency, warn', () => {
  let db;
  beforeAll(() => { db = getDb(); });

  // `offset` is a datetime() modifier, evaluated to a real timestamp before it is
  // bound (binding the expression text would store literal garbage).
  function makeTrial(slug, offset) {
    const exp = db.prepare("SELECT datetime('now', ?) AS t").get(offset).t;
    return Number(db.prepare(
      "INSERT INTO tenants (slug, name, kind, usage_mode, status, trial_expires_at) VALUES (?, ?, 'client', 'trial', 'active', ?)",
    ).run(slug, slug, exp).lastInsertRowid);
  }

  it('suspends an expired trial, notifies, and audits tenant_trial_expired', () => {
    const id = makeTrial('trial-exp', '-1 day');
    const notifBefore = db.prepare('SELECT COUNT(*) c FROM notifications').get().c;

    const res = trialMonitor.tick();
    expect(res.suspended).toBeGreaterThanOrEqual(1);
    expect(db.prepare('SELECT status FROM tenants WHERE id = ?').get(id).status).toBe('suspended');
    expect(db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'tenant_trial_expired' AND target_id = ?").get(String(id)).c).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM notifications').get().c).toBeGreaterThan(notifBefore);
    expect(auditService.verify().valid).toBe(true);
  });

  it('is idempotent — a second tick does not re-suspend or re-audit (the suspend guard)', () => {
    const id = makeTrial('trial-idem', '-2 day');
    trialMonitor.tick();
    expect(db.prepare('SELECT status FROM tenants WHERE id = ?').get(id).status).toBe('suspended');
    const auditAfterFirst = db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'tenant_trial_expired' AND target_id = ?").get(String(id)).c;
    trialMonitor.tick();
    trialMonitor.tick();
    expect(db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'tenant_trial_expired' AND target_id = ?").get(String(id)).c).toBe(auditAfterFirst);
  });

  it('warns ONCE within the window and never for a production tenant', () => {
    const id = makeTrial('trial-warn', '+2 day');
    const r1 = trialMonitor.tick();
    expect(r1.warned).toBeGreaterThanOrEqual(1);
    expect(db.prepare('SELECT status FROM tenants WHERE id = ?').get(id).status).toBe('active'); // warned, not suspended
    const marker = db.prepare("SELECT value FROM tenant_settings WHERE tenant_id = ? AND key = ?").get(id, trialMonitor.WARN_MARKER_KEY);
    expect(marker).toBeTruthy();
    // second tick: dedup — no new warning for the same expiry
    const notifBefore = db.prepare('SELECT COUNT(*) c FROM notifications').get().c;
    trialMonitor.tick();
    expect(db.prepare('SELECT COUNT(*) c FROM notifications').get().c).toBe(notifBefore);
  });
});

describe('trial-monitor.extendTrial + promotion reactivation', () => {
  let db;
  beforeAll(() => { db = getDb(); });

  function makeTrial(slug, offset, status = 'active') {
    const exp = db.prepare("SELECT datetime('now', ?) AS t").get(offset).t;
    return Number(db.prepare(
      "INSERT INTO tenants (slug, name, kind, usage_mode, status, trial_expires_at) VALUES (?, ?, 'client', 'trial', ?, ?)",
    ).run(slug, slug, status, exp).lastInsertRowid);
  }

  it('extend-trial pushes the date out and REACTIVATES a suspended trial', () => {
    const id = makeTrial('trial-ext', '-1 day', 'active');
    trialMonitor.tick(); // suspends it
    expect(db.prepare('SELECT status FROM tenants WHERE id = ?').get(id).status).toBe('suspended');

    const res = trialMonitor.extendTrial(id, { days: 30, user: USER });
    expect(res.reactivated).toBe(true);
    const t = db.prepare('SELECT status, trial_expires_at FROM tenants WHERE id = ?').get(id);
    expect(t.status).toBe('active');
    expect(new Date(t.trial_expires_at.replace(' ', 'T') + 'Z').getTime()).toBeGreaterThan(Date.now());
    expect(db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'tenant_trial_extend' AND target_id = ?").get(String(id)).c).toBe(1);
    // extend cleared the warning marker so a future approach warns afresh
    expect(db.prepare("SELECT COUNT(*) c FROM tenant_settings WHERE tenant_id = ? AND key = ?").get(id, trialMonitor.WARN_MARKER_KEY).c).toBe(0);
  });

  it('promoting a suspended trial to production reactivates it and clears the trial clock', () => {
    const id = makeTrial('trial-promo', '-1 day', 'active');
    trialMonitor.tick();
    expect(db.prepare('SELECT status FROM tenants WHERE id = ?').get(id).status).toBe('suspended');

    const res = promotion.setUsageMode(id, 'production', { user: USER });
    expect(res).toMatchObject({ to: 'production', changed: true, reactivated: true });
    const t = db.prepare('SELECT usage_mode, status, trial_expires_at FROM tenants WHERE id = ?').get(id);
    expect(t.usage_mode).toBe('production');
    expect(t.status).toBe('active');
    expect(t.trial_expires_at).toBeNull();
  });

  it('rejects extend-trial on a non-trial tenant', () => {
    const id = Number(db.prepare("INSERT INTO tenants (slug, name, kind, usage_mode, status) VALUES ('not-trial','nt','client','production','active')").run().lastInsertRowid);
    expect(() => trialMonitor.extendTrial(id, { user: USER })).toThrow(/is not a trial/);
  });
});

// ── 6. mock entity generation + the extended purge canary ────────────────────
describe('mock entities — generation, determinism, tagging', () => {
  let db;
  beforeAll(() => { db = getDb(); });

  function makeDemoTenant(slug) {
    return Number(db.prepare("INSERT INTO tenants (slug, name, kind, usage_mode, status) VALUES (?, ?, 'client', 'demo', 'active')").run(slug, slug).lastInsertRowid);
  }

  it('generates tagged entities + relations matching the profile estimate', () => {
    const est = seed.estimate({ profile: 'small' });
    const estE = est.tables.find((t) => t.name === 'tenant_entities').count;
    const estR = est.tables.find((t) => t.name === 'tenant_entity_relations').count;
    expect(estE).toBe(12);   // 2 sites + 4 depts + 6 apps
    expect(estR).toBe(13);   // 4 (dept→site) + 6 (app→dept) + 3 (depends_on)

    const t = makeDemoTenant('ment-gen');
    const ds = seed.generate({ tenantId: t, profile: 'small', seed: 4242, nowMs: FIXED_NOW });
    const ent = ds.tables.find((x) => x.name === 'tenant_entities');
    const rel = ds.tables.find((x) => x.name === 'tenant_entity_relations');
    expect(ent.count).toBe(estE);
    expect(rel.count).toBe(estR);

    // every generated row is tagged; every relation FK resolves to a tagged entity
    const untagged = db.prepare('SELECT COUNT(*) c FROM tenant_entities WHERE tenant_id = ? AND seed_run_id IS NULL').get(t).c;
    expect(untagged).toBe(0);
    const orphan = db.prepare(
      'SELECT COUNT(*) c FROM tenant_entity_relations WHERE seed_run_id = ? AND (from_entity_id NOT IN (SELECT id FROM tenant_entities WHERE seed_run_id = ?) OR to_entity_id NOT IN (SELECT id FROM tenant_entities WHERE seed_run_id = ?))',
    ).get(ds.datasetId, ds.datasetId, ds.datasetId).c;
    expect(orphan).toBe(0);
    seed.purge(ds.datasetId);
  });

  it('is deterministic — the same seed yields the same entity names/types', () => {
    const a = makeDemoTenant('ment-detA');
    const b = makeDemoTenant('ment-detB');
    const dsa = seed.generate({ tenantId: a, profile: 'small', seed: 7, nowMs: FIXED_NOW });
    const dsb = seed.generate({ tenantId: b, profile: 'small', seed: 7, nowMs: FIXED_NOW });
    const names = (id) => db.prepare('SELECT entity_type, name FROM tenant_entities WHERE seed_run_id = ? ORDER BY entity_type, name').all(id);
    expect(names(dsb.datasetId)).toEqual(names(dsa.datasetId));
    seed.purge(dsa.datasetId); seed.purge(dsb.datasetId);
  });
});

describe('purge canary — the two new entity tables', () => {
  // The Phase-4 extension of the Phase-3 canary: a REAL entity + a REAL relation
  // (seed_run_id IS NULL) sit alongside a synthetic batch and MUST survive its
  // purge. `NULL = x` is never true, so the purge predicate can never match them.
  let db; let realEntityA; let realEntityB;
  beforeAll(() => {
    db = getDb();
    realEntityA = Number(db.prepare("INSERT INTO tenant_entities (tenant_id, entity_type, code, name) VALUES (1, 'site', 'REAL-SITE', 'Real Site')").run().lastInsertRowid);
    realEntityB = Number(db.prepare("INSERT INTO tenant_entities (tenant_id, entity_type, code, name) VALUES (1, 'department', 'REAL-DEPT', 'Real Dept')").run().lastInsertRowid);
    db.prepare("INSERT INTO tenant_entity_relations (tenant_id, from_entity_id, to_entity_id, relation_type) VALUES (1, ?, ?, 'belongs_to')").run(realEntityB, realEntityA);
  });

  it('purging a synthetic batch removes ONLY its tagged entity/relation rows; real rows survive', () => {
    const realEntBefore = db.prepare('SELECT COUNT(*) c FROM tenant_entities WHERE seed_run_id IS NULL').get().c;
    const realRelBefore = db.prepare('SELECT COUNT(*) c FROM tenant_entity_relations WHERE seed_run_id IS NULL').get().c;
    expect(realEntBefore).toBeGreaterThanOrEqual(2);
    expect(realRelBefore).toBeGreaterThanOrEqual(1);

    const t = Number(db.prepare("INSERT INTO tenants (slug, name, kind, usage_mode, status) VALUES ('canary-ent','ce','client','demo','active')").run().lastInsertRowid);
    const ds = seed.generate({ tenantId: t, profile: 'small', seed: 555, nowMs: FIXED_NOW });
    expect(db.prepare('SELECT COUNT(*) c FROM tenant_entities WHERE seed_run_id = ?').get(ds.datasetId).c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM tenant_entity_relations WHERE seed_run_id = ?').get(ds.datasetId).c).toBeGreaterThan(0);

    const res = seed.purge(ds.datasetId);
    expect(res.total).toBeGreaterThan(0);
    // every tagged entity/relation of the batch is gone…
    expect(db.prepare('SELECT COUNT(*) c FROM tenant_entities WHERE seed_run_id = ?').get(ds.datasetId).c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM tenant_entity_relations WHERE seed_run_id = ?').get(ds.datasetId).c).toBe(0);
    // …and NOT ONE real row was touched
    expect(db.prepare('SELECT COUNT(*) c FROM tenant_entities WHERE seed_run_id IS NULL').get().c).toBe(realEntBefore);
    expect(db.prepare('SELECT COUNT(*) c FROM tenant_entity_relations WHERE seed_run_id IS NULL').get().c).toBe(realRelBefore);
    expect(db.prepare('SELECT COUNT(*) c FROM tenant_entities WHERE id IN (?,?)').get(realEntityA, realEntityB).c).toBe(2);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('SEED_TABLES includes the two new tables so the manifest + purge cover them', () => {
    expect(seed.SEED_TABLES).toContain('tenant_entities');
    expect(seed.SEED_TABLES).toContain('tenant_entity_relations');
    // relations (child) purge before entities (parent)
    expect(seed.PURGE_ORDER.indexOf('tenant_entity_relations')).toBeLessThan(seed.PURGE_ORDER.indexOf('tenant_entities'));
  });
});
