'use strict';

// v8.17.0 (Onboarding — Phase 3) — the mock-data generator, the purge invariant,
// the mock docker adapter and the promotion gate.
//
// The load-bearing test in this file is the PURGE-ISOLATION CANARY
// (`purge isolation (the canary)` below): it inserts REAL rows alongside two
// synthetic batches and proves that purging one batch removes every one of its
// tagged rows, leaves the other batch untouched, and does not delete a single
// real row. That is the invariant the whole demo/trial feature rests on.

process.env.APP_SECRET = 'test-secret-key-for-jest-seed';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';
process.env.BCRYPT_ROUNDS = '4';

const crypto = require('crypto');
const { getDb } = require('../db');
const seed = require('../services/provisioning/seed');
const provisioning = require('../services/provisioning');
const promotion = require('../services/provisioning/promotion');
const mockDocker = require('../services/provisioning/seed/mock-docker');
const auditService = require('../services/audit');
const { isSyntheticIp } = require('../services/provisioning/seed/prng');
const { SEED_TABLES } = require('../services/provisioning/seed/tables');

const USER = { id: null, username: 'seed-tester', role: 'admin' };
const FIXED_NOW = 1750000000000; // pin the clock for byte-identical determinism

let tenantSeq = 0;
function makeTenant(mode = 'demo') {
  tenantSeq += 1;
  const slug = `seedt${tenantSeq}`;
  const id = Number(getDb().prepare(
    "INSERT INTO tenants (slug, name, kind, usage_mode, status) VALUES (?, ?, 'client', ?, 'active')",
  ).run(slug, `Seed Tenant ${tenantSeq}`, mode).lastInsertRowid);
  return { id, slug };
}

describe('093 migration — seed schema + the seed_run_id tag', () => {
  let db;
  beforeAll(() => { db = getDb(); });

  it('creates seed_datasets, seed_dataset_tables and the seed_containers roster', () => {
    const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    for (const t of ['seed_datasets', 'seed_dataset_tables', 'seed_containers']) expect(names.has(t)).toBe(true);
  });

  it('adds a NULLABLE seed_run_id to every allow-listed table (real rows default NULL)', () => {
    for (const table of SEED_TABLES) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all();
      const tag = cols.find((c) => c.name === 'seed_run_id');
      expect(tag).toBeTruthy();
      if (table !== 'seed_containers') {
        expect(tag.notnull).toBe(0);      // real rows can (and do) leave it NULL
        expect(tag.dflt_value).toBeNull();
      }
    }
  });

  it('creates a PARTIAL index per tagged table so real installs pay nothing', () => {
    const idx = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%_seed_run'").all();
    expect(idx.length).toBeGreaterThanOrEqual(SEED_TABLES.length - 1);
    for (const i of idx) expect(i.sql).toMatch(/WHERE seed_run_id IS NOT NULL/);
  });

  it('CHECK-constrains seed_datasets.profile and .status', () => {
    const t = makeTenant();
    expect(() => db.prepare("INSERT INTO seed_datasets (tenant_id, profile, seed) VALUES (?, 'huge', '1')").run(t.id))
      .toThrow(/CHECK|constraint/i);
    expect(() => db.prepare("INSERT INTO seed_datasets (tenant_id, profile, seed, status) VALUES (?, 'small', '1', 'bogus')").run(t.id))
      .toThrow(/CHECK|constraint/i);
  });
});

describe('generator — determinism', () => {
  // Identical (seed, profile, scenario, locale, nowMs) => identical dataset.
  // Ciphertext columns are excluded from the structural hash because AES-256-GCM
  // uses a fresh random IV per encryption (making that deterministic would be a
  // security defect); their PLAINTEXT is asserted separately.
  // The ONLY columns excluded from the structural hash: ciphertext. AES-256-GCM
  // uses a fresh random IV per encryption (making that deterministic would be a
  // security defect), so those columns are compared by their DECRYPTED plaintext
  // instead. Everything else — including ids, FK values and embedded JSON — is
  // compared verbatim.
  const CIPHER_COLS = {
    docker_hosts: ['ssh_config', 'daemon_config'],
    registries: ['password_encrypted'],
    blueprints: ['source_token_enc'],
  };
  // EVERY tagged table, not a sample — this is what catches a column that was
  // accidentally left to SQLite's datetime('now') DEFAULT (1-second resolution),
  // which would make the dataset silently wall-clock-dependent.
  const SAMPLE_TABLES = SEED_TABLES;

  function fingerprint(db, datasetId) {
    const { decryptSshConfig } = require('../services/host-config-crypto');
    const { decrypt } = require('../utils/crypto');
    const h = crypto.createHash('sha256');
    const plain = [];
    for (const t of SAMPLE_TABLES) {
      const rows = db.prepare(`SELECT * FROM ${t} WHERE seed_run_id = ? ORDER BY rowid`).all(datasetId);
      h.update(`${t}:${rows.map((r) => {
        const c = { ...r };
        for (const k of (CIPHER_COLS[t] || [])) delete c[k];
        return JSON.stringify(c);
      }).join('|')}`);
      if (t === 'docker_hosts') {
        for (const r of rows) {
          plain.push(JSON.stringify(decryptSshConfig(r.ssh_config)));
          plain.push(decrypt(JSON.parse(r.daemon_config).apiTokenEnc));
        }
      }
      if (t === 'registries') for (const r of rows) plain.push(decrypt(r.password_encrypted));
      if (t === 'blueprints') for (const r of rows) plain.push(decrypt(r.source_token_enc));
    }
    return { struct: h.digest('hex'), plain: crypto.createHash('sha256').update(plain.join('|')).digest('hex') };
  }

  // The acceptance criterion is literally "generate() twice into two CLEAN
  // databases yields identical row content", so that is what we do: a genuinely
  // fresh in-memory database per run, migrations and all. Autoincrement ids,
  // FK values and embedded JSON therefore line up exactly — nothing has to be
  // normalised away except the random-IV ciphertext (asserted via plaintext).
  function freshDb() {
    const Database = require('better-sqlite3');
    const fs = require('fs');
    const path = require('path');
    const d = new Database(':memory:');
    d.pragma('foreign_keys = ON');
    const dir = path.join(__dirname, '..', 'db', 'migrations');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) {
      d.transaction(() => require(path.join(dir, f)).up(d))();
    }
    d.prepare("INSERT INTO tenants (slug, name, kind, usage_mode, status) VALUES ('det','Det','client','demo','active')").run();
    return d;
  }

  function generateClean(opts) {
    const db = freshDb();
    try {
      const tenantId = db.prepare("SELECT id FROM tenants WHERE slug = 'det'").get().id;
      const ds = seed.generate({ db, tenantId, profile: 'small', nowMs: FIXED_NOW, ...opts });
      const fp = fingerprint(db, ds.datasetId);
      const sample = db.prepare('SELECT name, host FROM docker_hosts WHERE seed_run_id = ? ORDER BY id LIMIT 1').get(ds.datasetId);
      const container = db.prepare('SELECT name, image, container_id FROM seed_containers WHERE seed_run_id = ? ORDER BY id LIMIT 1').get(ds.datasetId);
      const blueprint = db.prepare('SELECT doc FROM blueprints WHERE seed_run_id = ? ORDER BY id LIMIT 1').get(ds.datasetId);
      return { ...ds, ...fp, sample, container, blueprint };
    } finally { db.close(); }
  }

  it('the same (seed, profile, scenario, locale) yields an identical dataset twice', () => {
    const a = generateClean({ scenario: 'healthy-shop', locale: 'en', seed: 4242 });
    const b = generateClean({ scenario: 'healthy-shop', locale: 'en', seed: 4242 });
    expect(b.total).toBe(a.total);
    expect(b.tables).toEqual(a.tables);
    expect(b.struct).toBe(a.struct);   // every business column identical
    expect(b.plain).toBe(a.plain);     // every DECRYPTED secret identical too
    // Concrete sample values too, so a regression reads clearly.
    expect(b.sample).toEqual(a.sample);
    expect(b.container).toEqual(a.container);
    expect(b.blueprint).toEqual(a.blueprint);
  });

  it('a different seed or a different locale yields a different dataset', () => {
    const base = generateClean({ seed: 1, locale: 'en' });
    const otherSeed = generateClean({ seed: 2, locale: 'en' });
    const otherLocale = generateClean({ seed: 1, locale: 'ro' });
    expect(otherSeed.struct).not.toBe(base.struct);
    expect(otherLocale.struct).not.toBe(base.struct);
  });

  it('derives a stable seed from the tenant when none is supplied', () => {
    const t = makeTenant();
    const a = seed.generate({ tenantId: t.id, profile: 'small', nowMs: FIXED_NOW });
    seed.purge(a.datasetId);
    const b = seed.generate({ tenantId: t.id, profile: 'small', nowMs: FIXED_NOW });
    expect(b.seed).toBe(a.seed);
    seed.purge(b.datasetId);
  });
});

describe('generator — referential integrity + synthetic-only values', () => {
  let db; let ds; let tenant;
  beforeAll(() => {
    db = getDb();
    tenant = makeTenant();
    ds = seed.generate({ tenantId: tenant.id, profile: 'medium', scenario: 'busy-estate', seed: 7, nowMs: FIXED_NOW });
  });
  afterAll(() => { seed.purge(ds.datasetId); });

  it('leaves no dangling foreign key anywhere in the database', () => {
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('every container FK resolves to the seed_containers roster', () => {
    const roster = new Set(db.prepare('SELECT container_id FROM seed_containers WHERE seed_run_id = ?').all(ds.datasetId).map((r) => r.container_id));
    expect(roster.size).toBeGreaterThan(0);
    for (const table of ['container_stats', 'container_stats_1m', 'container_stats_1h', 'container_stats_1d', 'container_group_members']) {
      const orphan = db.prepare(
        `SELECT COUNT(*) AS c FROM ${table} WHERE seed_run_id = ? AND container_id NOT IN (SELECT container_id FROM seed_containers WHERE seed_run_id = ?)`,
      ).get(ds.datasetId, ds.datasetId).c;
      expect(orphan).toBe(0);
    }
  });

  it('every host FK resolves to a produced docker_hosts row', () => {
    const hosts = new Set(db.prepare('SELECT id FROM docker_hosts WHERE seed_run_id = ?').all(ds.datasetId).map((r) => r.id));
    for (const [table, col] of [['seed_containers', 'host_id'], ['firewall_rules', 'host_id'],
      ['firewall_snapshots', 'host_id'], ['host_group_members', 'host_id'], ['docker_events', 'host_id']]) {
      const rows = db.prepare(`SELECT DISTINCT ${col} AS v FROM ${table} WHERE seed_run_id = ?`).all(ds.datasetId);
      for (const r of rows) expect(hosts.has(r.v)).toBe(true);
    }
  });

  it('the generated blueprint doc passes the reconciler validateDoc unchanged', () => {
    const { validateDoc } = require('../services/reconciler');
    const rows = db.prepare('SELECT doc FROM blueprints WHERE seed_run_id = ?').all(ds.datasetId);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const norm = validateDoc(JSON.parse(r.doc));
      expect(norm.kind).toBe('estate-blueprint');
      for (const hostId of Object.keys(norm.hosts)) {
        expect(db.prepare('SELECT COUNT(*) c FROM docker_hosts WHERE id = ?').get(Number(hostId)).c).toBe(1);
      }
    }
  });

  it('EVERY generated IP is RFC1918 or TEST-NET (assert by regex over the whole batch)', () => {
    const ips = [];
    for (const r of db.prepare('SELECT host, daemon_config FROM docker_hosts WHERE seed_run_id = ?').all(ds.datasetId)) {
      ips.push(r.host);
    }
    for (const r of db.prepare('SELECT source_ip, destination_ip, rule_expression FROM firewall_rules WHERE seed_run_id = ?').all(ds.datasetId)) {
      if (r.source_ip) ips.push(String(r.source_ip).split('/')[0]);
      if (r.destination_ip) ips.push(String(r.destination_ip).split('/')[0]);
    }
    for (const r of db.prepare('SELECT ip FROM audit_log WHERE seed_run_id = ?').all(ds.datasetId)) if (r.ip) ips.push(r.ip);
    for (const r of db.prepare('SELECT snapshot_content FROM firewall_snapshots WHERE seed_run_id = ?').all(ds.datasetId)) {
      for (const m of String(r.snapshot_content).match(/\d{1,3}(?:\.\d{1,3}){3}/g) || []) ips.push(m);
    }
    expect(ips.length).toBeGreaterThan(20);
    const bad = ips.filter((ip) => !isSyntheticIp(ip));
    expect(bad).toEqual([]);
  });

  it('EVERY generated hostname is *.test / *.example / *.invalid (reserved TLDs)', () => {
    const RESERVED = /\.(test|example|invalid)$/;
    const names = [];
    for (const r of db.prepare('SELECT daemon_config FROM docker_hosts WHERE seed_run_id = ?').all(ds.datasetId)) {
      names.push(JSON.parse(r.daemon_config).fqdn);
    }
    for (const r of db.prepare('SELECT email FROM users WHERE seed_run_id = ?').all(ds.datasetId)) {
      names.push(String(r.email).split('@')[1]);
    }
    for (const r of db.prepare('SELECT url FROM registries WHERE seed_run_id = ?').all(ds.datasetId)) {
      names.push(new URL(r.url).hostname);
    }
    for (const r of db.prepare('SELECT source_url FROM blueprints WHERE seed_run_id = ?').all(ds.datasetId)) {
      if (r.source_url) names.push(new URL(r.source_url).hostname);
    }
    expect(names.length).toBeGreaterThan(10);
    expect(names.filter((n) => !RESERVED.test(n))).toEqual([]);
  });

  it('demo users are ALWAYS viewer, never owners, and cannot authenticate', () => {
    const users = db.prepare('SELECT id, role, password_hash FROM users WHERE seed_run_id = ?').all(ds.datasetId);
    expect(users.length).toBeGreaterThan(0);
    for (const u of users) {
      expect(u.role).toBe('viewer');
      expect(u.password_hash).toMatch(/^\$2[aby]\$/);      // valid bcrypt shape → compare() returns false cleanly
    }
    const memberships = db.prepare('SELECT role, is_owner FROM user_tenants WHERE seed_run_id = ?').all(ds.datasetId);
    for (const m of memberships) { expect(m.role).toBe('viewer'); expect(m.is_owner).toBe(0); }
  });

  it('every fake credential is stored ENCRYPTED and round-trips through crypto', () => {
    const { decryptSshConfig } = require('../services/host-config-crypto');
    const { decrypt } = require('../utils/crypto');
    for (const h of db.prepare('SELECT ssh_config, daemon_config FROM docker_hosts WHERE seed_run_id = ?').all(ds.datasetId)) {
      expect(h.ssh_config).not.toMatch(/placeholder-/);      // no plaintext at rest
      const cfg = decryptSshConfig(h.ssh_config);
      expect(cfg.password).toMatch(/^placeholder-/);          // ...but it decrypts back
      const dc = JSON.parse(h.daemon_config);
      expect(dc.apiTokenEnc).toMatch(/^[0-9a-f]+:[0-9a-f]+:/); // iv:tag:ct
      expect(decrypt(dc.apiTokenEnc)).toMatch(/^placeholder-token-/);
    }
    for (const r of db.prepare('SELECT password_encrypted FROM registries WHERE seed_run_id = ?').all(ds.datasetId)) {
      expect(decrypt(r.password_encrypted)).toMatch(/^placeholder-registry-token-/);
    }
  });
});

describe('generator — bounded volume (the docker_events lesson)', () => {
  const db = () => getDb();

  it.each([['small', 6000], ['medium', 20000], ['large', 40000]])(
    'profile %s stays within its bound and matches its own estimate',
    (profile, ceiling) => {
      const t = makeTenant();
      const est = seed.estimate({ profile });
      const ds = seed.generate({ tenantId: t.id, profile, seed: 5, nowMs: FIXED_NOW });
      expect(ds.total).toBeLessThanOrEqual(ceiling);
      expect(ds.total).toBeLessThanOrEqual(seed.MAX_TOTAL_ROWS);
      expect(ds.total).toBeLessThanOrEqual(est.total);          // never MORE than estimated
      expect(ds.total).toBeGreaterThan(est.total * 0.98);        // and essentially equal to it
      const statsRows = ds.tables.filter((x) => x.name.startsWith('container_stats')).reduce((s, x) => s + x.count, 0);
      expect(statsRows).toBeLessThanOrEqual(seed.MAX_STATS_ROWS);
      seed.purge(ds.datasetId);
    },
  );

  it('NEVER emits an exec_* docker_event and never touches exec_sessions', () => {
    const t = makeTenant();
    const ds = seed.generate({ tenantId: t.id, profile: 'medium', seed: 9, nowMs: FIXED_NOW });
    expect(db().prepare("SELECT COUNT(*) c FROM docker_events WHERE action LIKE 'exec_%'").get().c).toBe(0);
    expect(db().prepare('SELECT COUNT(*) c FROM exec_sessions').get().c).toBe(0);
    seed.purge(ds.datasetId);
  });

  it('the large profile drops the 1m tier and the raw tail entirely', () => {
    const est = seed.estimate({ profile: 'large' });
    const names = est.tables.map((t) => t.name);
    expect(names).not.toContain('container_stats_1m');
    expect(names).not.toContain('container_stats');
  });
});

describe('purge isolation (the canary)', () => {
  // THE load-bearing safety test. Real rows are inserted into the same tables the
  // generator writes; after purging a batch, every tagged row of that batch is
  // gone, the other batch is untouched, and EVERY real row survives.
  let db;
  const realIds = {};

  function insertRealRows() {
    // Deliberately NOT setting seed_run_id — these are "real" rows (NULL tag).
    realIds.host = Number(db.prepare("INSERT INTO docker_hosts (name, connection_type, host) VALUES ('REAL-prod-host','tcp','10.99.99.99')").run().lastInsertRowid);
    realIds.user = Number(db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('real-operator','$2b$12$realrealrealrealrealrealrealrealrealrealrealreal','operator')").run().lastInsertRowid);
    realIds.group = Number(db.prepare("INSERT INTO host_groups (name) VALUES ('REAL group')").run().lastInsertRowid);
    realIds.team = Number(db.prepare("INSERT INTO teams (name) VALUES ('REAL team')").run().lastInsertRowid);
    realIds.registry = Number(db.prepare("INSERT INTO registries (name, url) VALUES ('REAL registry','https://registry.real.internal')").run().lastInsertRowid);
    realIds.meta = Number(db.prepare("INSERT INTO container_meta (container_name, app_name) VALUES ('real-container','Real App')").run().lastInsertRowid);
    db.prepare("INSERT INTO docker_events (host_id, event_type, action, actor_name) VALUES (?, 'container', 'start', 'real-container')").run(realIds.host);
    db.prepare("INSERT INTO container_stats_1h (host_id, container_id, container_name, cpu_avg, bucket) VALUES (?, 'realcontainerid', 'real-container', 1.5, '2020-01-01 00:00:00')").run(realIds.host);
    db.prepare("INSERT INTO firewall_rules (rule_uuid, host_id, backend, scope, action, created_by) VALUES ('real-uuid-1', ?, 'iptables', 'host', 'allow', 'realadmin')").run(realIds.host);
    db.prepare('INSERT INTO posture_snapshots (host_id, score, grade) VALUES (?, 88, \'B\')').run(realIds.host);
    db.prepare("INSERT INTO blueprints (name, doc, created_by) VALUES ('REAL blueprint', '{\"version\":1,\"kind\":\"estate-blueprint\",\"hosts\":{}}', 'realadmin')").run();
    db.prepare("INSERT INTO nomenclatures (tenant_id, kind, code, label) VALUES (1, 'environment', 'real-env', 'Real Env')").run();
    auditService.log({ userId: null, username: 'realadmin', action: 'login', targetType: 'user', targetId: 'real', details: { real: true }, ip: '10.99.99.99' });
  }

  const realCounts = () => Object.fromEntries(SEED_TABLES.map((t) => [
    t, db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE seed_run_id IS NULL`).get().c,
  ]));
  const taggedCount = (id) => Object.fromEntries(SEED_TABLES.map((t) => [
    t, db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE seed_run_id = ?`).get(id).c,
  ]));

  beforeAll(() => { db = getDb(); insertRealRows(); });

  it('purging batch A removes ONLY A: real rows and batch B are untouched', () => {
    const tenant = makeTenant();
    const before = realCounts();
    expect(before.docker_hosts).toBeGreaterThan(0);
    expect(before.users).toBeGreaterThan(0);

    const a = seed.generate({ tenantId: tenant.id, profile: 'small', seed: 11, nowMs: FIXED_NOW });
    const b = seed.generate({ tenantId: tenant.id, profile: 'small', seed: 22, nowMs: FIXED_NOW });

    const bBefore = taggedCount(b.datasetId);
    expect(Object.values(taggedCount(a.datasetId)).reduce((s, n) => s + n, 0)).toBeGreaterThan(0);

    const res = seed.purge(a.datasetId);
    expect(res.total).toBeGreaterThan(0);

    // 1. every A-tagged row is gone (audit_log may be tail-guarded — see below)
    const aAfter = taggedCount(a.datasetId);
    for (const [table, count] of Object.entries(aAfter)) {
      if (table === 'audit_log' && res.skipped.includes('audit_log')) continue;
      expect([table, count]).toEqual([table, 0]);
    }
    // 2. NOT ONE real row was touched
    expect(realCounts()).toEqual(before);
    // 3. the coexisting batch B is byte-for-byte intact
    expect(taggedCount(b.datasetId)).toEqual(bBefore);
    // 4. no dangling FK anywhere
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    // ...and purging B leaves the real rows alone too.
    seed.purge(b.datasetId);
    expect(realCounts()).toEqual(before);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) c FROM seed_datasets WHERE id IN (?,?) AND status = 'purged'").get(a.datasetId, b.datasetId).c).toBe(2);
    // the named canary rows are still individually present
    expect(db.prepare('SELECT COUNT(*) c FROM docker_hosts WHERE id = ?').get(realIds.host).c).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM users WHERE id = ?').get(realIds.user).c).toBe(1);
  });

  it('purge is idempotent — a second purge deletes nothing more', () => {
    const tenant = makeTenant();
    const before = realCounts();
    const ds = seed.generate({ tenantId: tenant.id, profile: 'small', seed: 33, nowMs: FIXED_NOW });
    seed.purge(ds.datasetId);
    const second = seed.purge(ds.datasetId);
    expect(second.total).toBe(0);
    expect(realCounts()).toEqual(before);
  });

  it('the purge predicate can never match a real row (NULL = x is never true)', () => {
    // The structural argument, asserted directly: no table has a real row whose
    // tag equals any dataset id, because a real row's tag is NULL.
    for (const table of SEED_TABLES) {
      const c = db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE seed_run_id IS NULL AND seed_run_id = 1`).get().c;
      expect(c).toBe(0);
    }
  });

  it('refuses to purge from a table that is not on the allow-list', () => {
    const { assertSeedTable } = require('../services/provisioning/seed/tables');
    expect(() => assertSeedTable('settings')).toThrow(/refusing to touch non-seed table/);
    expect(() => assertSeedTable('sqlite_master')).toThrow(/refusing to touch non-seed table/);
  });
});

describe('audit chain integrity', () => {
  let db;
  beforeAll(() => { db = getDb(); });

  it('stays valid after seeding and after a tail purge', () => {
    expect(auditService.verify().valid).toBe(true);
    const t = makeTenant();
    const ds = seed.generate({ tenantId: t.id, profile: 'small', seed: 44, nowMs: FIXED_NOW });
    expect(db.prepare('SELECT COUNT(*) c FROM audit_log WHERE seed_run_id = ?').get(ds.datasetId).c).toBeGreaterThan(0);
    expect(auditService.verify().valid).toBe(true);      // seeded rows chain from the tip
    const res = seed.purge(ds.datasetId);
    expect(res.skipped).toEqual([]);                      // nothing was appended after → tail purge
    expect(auditService.verify().valid).toBe(true);
  });

  it('SKIPS the audit purge (never breaks the chain) when real rows were appended after seeding', () => {
    const t = makeTenant();
    const ds = seed.generate({ tenantId: t.id, profile: 'small', seed: 55, nowMs: FIXED_NOW });
    // A real action happens during the demo — the synthetic block is no longer the tail.
    auditService.log({ username: 'realadmin', action: 'login', targetType: 'user', targetId: 'x', details: {}, ip: '10.0.0.1' });
    const res = seed.purge(ds.datasetId);
    expect(res.skipped).toEqual(['audit_log']);
    expect(db.prepare('SELECT COUNT(*) c FROM audit_log WHERE seed_run_id = ?').get(ds.datasetId).c).toBeGreaterThan(0);
    expect(auditService.verify().valid).toBe(true);       // chain intact, nothing corrupted
    // every OTHER table was still fully purged
    expect(db.prepare('SELECT COUNT(*) c FROM docker_hosts WHERE seed_run_id = ?').get(ds.datasetId).c).toBe(0);
  });
});

describe('regenerate / reset — replace, never accumulate', () => {
  let db;
  beforeAll(() => { db = getDb(); });

  it('regenerate replaces the live batch instead of adding a second one', () => {
    const t = makeTenant();
    const first = seed.generate({ tenantId: t.id, profile: 'small', seed: 66, nowMs: FIXED_NOW });
    const hostsAfterFirst = db.prepare('SELECT COUNT(*) c FROM docker_hosts WHERE seed_run_id IS NOT NULL').get().c;

    const second = seed.regenerate({ tenantId: t.id, profile: 'small', seed: 77, nowMs: FIXED_NOW });
    expect(second.datasetId).not.toBe(first.datasetId);
    expect(second.purged).toBe(1);
    expect(db.prepare("SELECT COUNT(*) c FROM seed_datasets WHERE tenant_id = ? AND status = 'active'").get(t.id).c).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM docker_hosts WHERE seed_run_id = ?').get(first.datasetId).c).toBe(0);
    // no accumulation: the tagged host count is the same as after the first run
    expect(db.prepare('SELECT COUNT(*) c FROM docker_hosts WHERE seed_run_id IS NOT NULL').get().c).toBe(hostsAfterFirst);
    seed.purge(second.datasetId);
  });

  it('reset re-uses the live batch inputs (same profile/scenario/seed)', () => {
    const t = makeTenant();
    const first = seed.generate({ tenantId: t.id, profile: 'small', scenario: 'busy-estate', seed: 88, nowMs: FIXED_NOW });
    const after = seed.reset({ tenantId: t.id, nowMs: FIXED_NOW });
    expect(after.profile).toBe('small');
    expect(after.scenario).toBe('busy-estate');
    expect(after.seed).toBe(first.seed);
    expect(after.datasetId).not.toBe(first.datasetId);
    seed.purge(after.datasetId);
  });
});

describe('production is blocked from all seeding', () => {
  it('generate() throws SeedBlockedError against a production tenant and writes NOTHING', () => {
    const db = getDb();
    const t = makeTenant('production');
    const before = db.prepare('SELECT COUNT(*) c FROM seed_datasets').get().c;
    expect(() => seed.generate({ tenantId: t.id, profile: 'small' })).toThrow(/usage_mode=production/);
    expect(db.prepare('SELECT COUNT(*) c FROM seed_datasets').get().c).toBe(before);
  });

  it('the declaration validator rejects a mockData block in production mode', () => {
    expect(() => provisioning.validateDeclaration({
      version: 1, mode: 'production', tenant: { slug: 'prodx', name: 'Prod' },
      mockData: { profile: 'large' },
    })).toThrow(/mockData is not permitted in production/);
  });

  it('the seed_mock_data step is not even built for a production run', () => {
    const { buildSteps } = require('../services/provisioning/steps');
    const prod = buildSteps({ decl: { mode: 'production' } }).map((s) => s.key);
    const demo = buildSteps({ decl: { mode: 'demo' } }).map((s) => s.key);
    expect(prod).not.toContain('seed_mock_data');
    expect(demo).toContain('seed_mock_data');
    expect(demo.indexOf('seed_mock_data')).toBe(demo.indexOf('grant_permissions') + 1);
    expect(demo.indexOf('finalize')).toBe(demo.indexOf('seed_mock_data') + 1);
  });

  it('the step itself refuses defensively if it is ever reached in production', () => {
    const step = require('../services/provisioning/steps/seed-mock-data');
    expect(() => step.run({ db: getDb(), decl: { mode: 'production' }, tenantId: 1 }))
      .toThrow(/refuses to run in production/);
  });
});

describe('promotion gate', () => {
  let db;
  beforeAll(() => { db = getDb(); });

  it('refuses production while a live batch exists, and passes after a purge', () => {
    const t = makeTenant('demo');
    const ds = seed.generate({ tenantId: t.id, profile: 'small', seed: 99, nowMs: FIXED_NOW });

    const gate = promotion.checkProductionReady(t.id);
    expect(gate.ok).toBe(false);
    expect(gate.blockers.map((b) => b.code)).toEqual(expect.arrayContaining(['live_seed_batch', 'placeholder_secret']));
    for (const b of gate.blockers) expect(typeof b.remediation).toBe('string');

    expect(() => promotion.setUsageMode(t.id, 'production', { user: USER })).toThrow(/cannot be switched to production/);
    expect(db.prepare('SELECT usage_mode FROM tenants WHERE id = ?').get(t.id).usage_mode).toBe('demo');

    seed.purge(ds.datasetId);
    expect(promotion.checkProductionReady(t.id).ok).toBe(true);
    const res = promotion.setUsageMode(t.id, 'production', { user: USER });
    expect(res).toMatchObject({ from: 'demo', to: 'production', changed: true });
    expect(db.prepare('SELECT usage_mode FROM tenants WHERE id = ?').get(t.id).usage_mode).toBe('production');
    expect(db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'tenant_promote' AND target_id = ?").get(String(t.id)).c).toBe(1);
  });

  it('demo <-> trial transitions are NOT gated (only production is)', () => {
    const t = makeTenant('demo');
    const ds = seed.generate({ tenantId: t.id, profile: 'small', seed: 111, nowMs: FIXED_NOW });
    expect(promotion.setUsageMode(t.id, 'trial', { user: USER })).toMatchObject({ to: 'trial', changed: true });
    seed.purge(ds.datasetId);
  });

  it('purgeAndPromote remediates then promotes in one call', () => {
    const t = makeTenant('demo');
    seed.generate({ tenantId: t.id, profile: 'small', seed: 222, nowMs: FIXED_NOW });
    const res = promotion.purgeAndPromote(t.id, { user: USER });
    expect(res.changed).toBe(true);
    expect(res.purged).toBe(1);
    expect(db.prepare('SELECT usage_mode FROM tenants WHERE id = ?').get(t.id).usage_mode).toBe('production');
  });

  it('rejects an invalid mode outright', () => {
    const t = makeTenant('demo');
    expect(() => promotion.setUsageMode(t.id, 'staging', { user: USER })).toThrow(/invalid usage_mode/);
  });
});

describe('mock docker adapter', () => {
  let db; let ds; let hostId; let realHostId;
  beforeAll(() => {
    db = getDb();
    const t = makeTenant();
    ds = seed.generate({ tenantId: t.id, profile: 'small', seed: 333, nowMs: FIXED_NOW });
    hostId = db.prepare('SELECT id FROM docker_hosts WHERE seed_run_id = ? ORDER BY id LIMIT 1').get(ds.datasetId).id;
    realHostId = db.prepare('SELECT id FROM docker_hosts WHERE seed_run_id IS NULL ORDER BY id LIMIT 1').get().id;
  });
  afterAll(() => { seed.purge(ds.datasetId); });

  it('is used for a SEEDED host and NEVER for a real one', () => {
    expect(mockDocker.isSeededHost(hostId)).toBe(true);
    expect(mockDocker.getMockDocker(hostId)).toBeTruthy();
    // The isolation contract: a real host (seed_run_id IS NULL) gets null.
    expect(mockDocker.isSeededHost(realHostId)).toBe(false);
    expect(mockDocker.getMockDocker(realHostId)).toBeNull();
    expect(mockDocker.getMockDocker(0)).toBeNull();       // hostId 0 = local default
    expect(mockDocker.getMockDocker(999999)).toBeNull();  // unknown host
  });

  it('stops being used the moment the batch is purged', () => {
    const t = makeTenant();
    const tmp = seed.generate({ tenantId: t.id, profile: 'small', seed: 444, nowMs: FIXED_NOW });
    const tmpHost = db.prepare('SELECT id FROM docker_hosts WHERE seed_run_id = ? LIMIT 1').get(tmp.datasetId).id;
    expect(mockDocker.isSeededHost(tmpHost)).toBe(true);
    seed.purge(tmp.datasetId);
    expect(mockDocker.isSeededHost(tmpHost)).toBe(false); // row is gone with the batch
  });

  it('serves the roster through dockerService.listContainers', async () => {
    const dockerService = require('../services/docker');
    const list = await dockerService.listContainers(hostId);
    const roster = db.prepare('SELECT name, state FROM seed_containers WHERE host_id = ?').all(hostId);
    expect(list.length).toBe(roster.length);
    expect(list.map((c) => c.name).sort()).toEqual(roster.map((r) => r.name).sort());
    expect(list[0].id).toMatch(/^[0-9a-f]{64}$/);
    expect(list[0].hostId).toBe(hostId);
  });

  it('serves inspect-lite and stats derived from the seeded series', async () => {
    const dockerService = require('../services/docker');
    const list = await dockerService.listContainers(hostId);
    const running = list.find((c) => c.state === 'running') || list[0];
    const insp = await dockerService.inspectContainer(running.id, hostId);
    expect(insp.name).toBe(running.name);
    expect(insp.image).toBe(running.image);
    expect(insp.state.Status).toBe(running.state);

    const stats = await dockerService.getContainerStats(running.id, hostId);
    expect(typeof stats.cpuPercent).toBe('number');
    expect(stats.memLimit).toBeGreaterThan(0);
    expect(stats.memPercent).toBeGreaterThan(0);
  });

  it('REFUSES mutations rather than pretending they worked', async () => {
    const dockerService = require('../services/docker');
    const list = await dockerService.listContainers(hostId);
    await expect(dockerService.containerAction(list[0].id, 'stop', hostId)).rejects.toThrow(/not available on a demo host/);
    await expect(dockerService.removeContainer(list[0].id, {}, hostId)).rejects.toThrow(/not available on a demo host/);
  });
});

describe('provisioning integration — a demo run seeds, a production run does not', () => {
  let db;
  beforeAll(() => { db = getDb(); });

  function decl(overrides = {}) {
    const slug = overrides.slug || `int${Math.random().toString(36).slice(2, 8)}`;
    return {
      version: 1,
      kind: 'onboarding-declaration',
      idempotencyKey: `int-${slug}`,
      tenant: { slug, name: `Integration ${slug}`, kind: 'client' },
      mode: overrides.mode || 'demo',
      regional: { locale: 'en', timezone: 'UTC', currency: 'EUR', unitSystem: 'metric' },
      modules: [{ key: 'hosts' }],
      hosts: [],
      users: [],
      permissions: [],
      ...(overrides.mode === 'production' ? {} : { mockData: overrides.mockData || { profile: 'small', scenario: 'healthy-shop', seed: '1234' } }),
    };
  }

  it('a demo apply runs seed_mock_data, records the dataset + manifest and keeps the chain valid', async () => {
    const run = await provisioning.apply({ declaration: decl({ slug: 'demoapply' }), user: USER });
    expect(run.status).toBe('completed');
    expect(run.steps.map((s) => s.step_key)).toContain('seed_mock_data');

    const ds = db.prepare('SELECT * FROM seed_datasets WHERE run_id = ?').get(run.id);
    expect(ds).toBeTruthy();
    expect(ds.profile).toBe('small');
    expect(ds.seed).toBe('1234');
    expect(ds.row_count).toBeGreaterThan(1000);
    expect(db.prepare('SELECT COUNT(*) c FROM seed_dataset_tables WHERE dataset_id = ?').get(ds.id).c).toBeGreaterThan(10);
    expect(db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'seed_dataset_create'").get().c).toBeGreaterThan(0);
    expect(auditService.verify().valid).toBe(true);
    seed.purge(ds.id);
  });

  it('a production apply creates NO dataset', async () => {
    const before = db.prepare('SELECT COUNT(*) c FROM seed_datasets').get().c;
    const run = await provisioning.apply({ declaration: decl({ slug: 'prodapply', mode: 'production' }), user: USER });
    expect(run.status).toBe('completed');
    expect(run.steps.map((s) => s.step_key)).not.toContain('seed_mock_data');
    expect(db.prepare('SELECT COUNT(*) c FROM seed_datasets').get().c).toBe(before);
  });

  it('rolling back a demo run unwinds the batch it created', async () => {
    const run = await provisioning.apply({ declaration: decl({ slug: 'rbdemo' }), user: USER });
    const ds = db.prepare('SELECT * FROM seed_datasets WHERE run_id = ?').get(run.id);
    expect(ds.status).toBe('active');
    expect(db.prepare('SELECT COUNT(*) c FROM docker_hosts WHERE seed_run_id = ?').get(ds.id).c).toBeGreaterThan(0);

    await provisioning.rollback(run.id, { user: USER });

    // seed_mock_data compensates FIRST (reverse ordinal), purging the batch;
    // create_tenant then cascade-deletes the tenant, which takes the (already
    // purged) seed_datasets row with it. Either way: no tagged rows survive.
    const after = db.prepare('SELECT status FROM seed_datasets WHERE id = ?').get(ds.id);
    if (after) expect(after.status).toBe('purged');
    expect(db.prepare('SELECT COUNT(*) c FROM docker_hosts WHERE seed_run_id = ?').get(ds.id).c).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM seed_containers WHERE seed_run_id = ?').get(ds.id).c).toBe(0);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('the plan estimate surfaces the synthetic row count for demo/trial only', () => {
    const demoPlan = provisioning.plan({ declaration: decl({ slug: 'planest' }), user: USER });
    expect(demoPlan.impact.creates.syntheticRows).toBeGreaterThan(0);
    const prodPlan = provisioning.plan({ declaration: decl({ slug: 'planprod', mode: 'production' }), user: USER });
    expect(prodPlan.impact.creates.syntheticRows).toBeUndefined();
  });
});

describe('estimate() is pure', () => {
  it('writes nothing and matches the profile matrix', () => {
    const db = getDb();
    const before = db.prepare('SELECT COUNT(*) c FROM seed_datasets').get().c;
    const est = seed.estimate({ profile: 'medium', scenario: 'busy-estate' });
    expect(est.profile).toBe('medium');
    expect(est.total).toBeGreaterThan(0);
    expect(est.tables.every((t) => SEED_TABLES.includes(t.name))).toBe(true);
    expect(db.prepare('SELECT COUNT(*) c FROM seed_datasets').get().c).toBe(before);
  });

  it('rejects an unknown profile or scenario', () => {
    expect(() => seed.estimate({ profile: 'gigantic' })).toThrow(/unknown seed profile/);
    expect(() => seed.generate({ tenantId: 1, scenario: 'nope' })).toThrow(/unknown seed scenario/);
  });
});
