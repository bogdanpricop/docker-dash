'use strict';

jest.mock('../db', () => ({ getDb: jest.fn(() => { throw new Error('test must provide its database'); }) }));

const Database = require('better-sqlite3');
const migration = require('../db/migrations/155_storage_repository_health');
const { StorageRepositoryHealthService, _internals } = require('../services/storage-repository-health');

const admin = { id: 1, username: 'admin', role: 'admin' };
const viewer = { id: 2, username: 'viewer', role: 'viewer' };

function database() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY,username TEXT);
    INSERT INTO users VALUES (1,'admin'),(2,'viewer');
    CREATE TABLE secrets_vault (id INTEGER PRIMARY KEY,name TEXT NOT NULL,value_encrypted TEXT NOT NULL);
    INSERT INTO secrets_vault VALUES (9,'nas-login','not-used-by-test');`);
  migration.up(db);
  return db;
}

function payload(overrides = {}) {
  return {
    name: 'Primary backups', protocol: 'nfs', hostname: 'nas.internal', port: 2049,
    repositoryPath: '/exports/backups', secretId: 9, writeTestEnabled: false,
    warningLatencyMs: 500, criticalLatencyMs: 2000, intervalMinutes: 60, isEnabled: true,
    ...overrides,
  };
}

function service(db, extras = {}) {
  return new StorageRepositoryHealthService({ dbProvider: () => db,
    resolver: jest.fn().mockResolvedValue([{ address: '10.0.0.20', family: 4 }]),
    connector: jest.fn().mockResolvedValue({ latencyMs: 12 }), ...extras });
}

describe('NFS/SMB repository health', () => {
  let db;
  beforeEach(() => { db = database(); });
  afterEach(() => db.close());

  test('registers only normalized endpoints and hides vault identifiers from viewers', () => {
    const monitor = service(db);
    const created = monitor.create(payload(), admin, db);
    expect(created).toEqual(expect.objectContaining({ protocol: 'nfs', hostname: 'nas.internal',
      repositoryPath: '/exports/backups', secretId: 9, credentialConfigured: true, version: 1 }));
    const listed = monitor.list(viewer, { database: db });
    expect(listed.repositories[0]).not.toHaveProperty('secretId');
    expect(listed.repositories[0]).not.toHaveProperty('secretName');
    expect(listed.repositories[0].credentialConfigured).toBe(true);
    expect(() => monitor.create(payload({ name: 'bad', hostname: 'smb://user:pass@nas/share' }), admin, db)).toThrow(/scheme/);
    expect(() => monitor.create(payload({ name: 'bad', repositoryPath: '/exports/../root' }), admin, db)).toThrow(/traversal/);
    expect(() => monitor.create({ ...payload({ name: 'bad' }), password: 'forbidden' }, admin, db)).toThrow(expect.objectContaining({ code: 'SECRET_FIELD' }));
  });

  test('reports real DNS and TCP evidence as unknown without claiming auth or list health', async () => {
    const monitor = service(db);
    const repository = monitor.create(payload(), admin, db);
    const result = await monitor.probe(repository.id, admin, { database: db, now: '2026-07-30T10:00:00Z' });
    expect(result).toEqual(expect.objectContaining({ state: 'unknown', latencyMs: 12, writeTest: false }));
    expect(result.stages).toEqual(expect.objectContaining({
      dns: expect.objectContaining({ state: 'pass', code: 'DNS_RESOLVED' }),
      tcp: expect.objectContaining({ state: 'pass', code: 'TCP_CONNECTED' }),
      auth: { state: 'unknown', code: 'ADAPTER_UNAVAILABLE' },
      list: { state: 'unknown', code: 'ADAPTER_UNAVAILABLE' },
    }));
    expect(result).not.toHaveProperty('secret');
    expect(monitor.list(admin, { database: db, now: '2026-07-30T10:01:00Z' }).summary.states.unknown).toBe(1);
  });

  test('sanitizes DNS and TCP failures into bounded unavailable evidence', async () => {
    const monitor = service(db, { resolver: jest.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND secret.internal')) });
    const repository = monitor.create(payload(), admin, db);
    const result = await monitor.probe(repository.id, admin, { database: db });
    expect(result).toEqual(expect.objectContaining({ state: 'unavailable', addresses: [] }));
    expect(result.stages.dns).toEqual({ state: 'fail', code: 'DNS_FAILED' });
    expect(JSON.stringify(result)).not.toContain('secret.internal');
  });

  test('applies warning and critical network latency without claiming protocol health', async () => {
    const monitor = service(db, { connector: jest.fn().mockResolvedValue({ latencyMs: 2500 }) });
    const repository = monitor.create(payload(), admin, db);
    const result = await monitor.probe(repository.id, admin, { database: db });
    expect(result.state).toBe('critical');
    expect(result.stages.auth.state).toBe('unknown');
  });

  test('alerts only when a prior repository state worsens', async () => {
    let readEvidence = { auth: { state: 'pass', code: 'AUTH_OK' }, list: { state: 'pass', code: 'LIST_OK' } };
    const notifications = { create: jest.fn() };
    const audit = { log: jest.fn() };
    const adapter = { probeRead: jest.fn(async () => readEvidence) };
    const monitor = service(db, { adapter, notifications, audit, secretResolver: jest.fn().mockResolvedValue('{}') });
    const repository = monitor.create(payload(), admin, db);
    expect((await monitor.probe(repository.id, admin, { database: db, now: '2026-07-30T10:00:00Z' })).state).toBe('healthy');
    expect(notifications.create).not.toHaveBeenCalled();
    readEvidence = { auth: { state: 'fail', code: 'AUTH_DENIED' }, list: { state: 'not_run', code: 'LIST_NOT_RUN' } };
    expect((await monitor.probe(repository.id, admin, { database: db, now: '2026-07-30T11:00:00Z' })).state).toBe('degraded');
    expect(notifications.create).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'storage_repository_health_regression' }));
    await monitor.probe(repository.id, admin, { database: db, now: '2026-07-30T12:00:00Z' });
    expect(notifications.create).toHaveBeenCalledTimes(1);
  });

  test('requires opt-in and typed confirmation, and treats unproven cleanup as critical', async () => {
    const adapter = {
      probeRead: jest.fn().mockResolvedValue({ auth: { state: 'pass', code: 'AUTH_OK' }, list: { state: 'pass', code: 'LIST_OK' } }),
      probeWrite: jest.fn().mockResolvedValue({ write: { state: 'pass', code: 'WRITE_OK' }, cleanup: { state: 'fail', code: 'CLEANUP_FAILED' } }),
    };
    const monitor = service(db, { adapter, secretResolver: jest.fn().mockResolvedValue('{}'),
      notifications: { create: jest.fn() }, audit: { log: jest.fn() } });
    const disabled = monitor.create(payload({ name: 'Disabled write' }), admin, db);
    await expect(monitor.writeTest(disabled.id, { confirmation: 'WRITE Disabled write' }, admin, { database: db }))
      .rejects.toMatchObject({ code: 'WRITE_TEST_DISABLED' });
    const repository = monitor.create(payload({ name: 'Writable test', writeTestEnabled: true }), admin, db);
    await expect(monitor.writeTest(repository.id, { confirmation: 'wrong' }, admin, { database: db }))
      .rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    const result = await monitor.writeTest(repository.id, { confirmation: 'WRITE Writable test' }, admin,
      { database: db, now: '2026-07-30T13:00:00Z' });
    expect(result).toEqual(expect.objectContaining({ state: 'critical', writeTest: true, cleanupProven: false }));
    expect(result.stages.cleanup).toEqual({ state: 'fail', code: 'CLEANUP_FAILED' });
    expect(adapter.probeWrite).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      marker: expect.stringMatching(/^dd-health-[a-f0-9]{24}\.tmp$/), maxBytes: 4096,
    }));
  });

  test('scheduler respects repository intervals and never calls the write adapter', async () => {
    const adapter = { probeRead: jest.fn().mockResolvedValue({ auth: { state: 'pass', code: 'AUTH_OK' }, list: { state: 'pass', code: 'LIST_OK' } }), probeWrite: jest.fn() };
    const monitor = service(db, { adapter, secretResolver: jest.fn().mockResolvedValue('{}') });
    monitor.create(payload(), admin, db);
    const first = await monitor.captureAll({ database: db, now: '2026-07-30T10:00:00Z' });
    const second = await monitor.captureAll({ database: db, now: '2026-07-30T10:30:00Z' });
    expect(first.results).toEqual([expect.objectContaining({ ok: true, state: 'healthy' })]);
    expect(second.results).toEqual([]);
    expect(adapter.probeWrite).not.toHaveBeenCalled();
  });

  test('migration and address guards keep the evidence model bounded', () => {
    const tables = ['storage_repository_endpoints', 'storage_repository_observations', 'storage_repository_states'];
    expect(tables.every(name => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))).toBe(true);
    expect(_internals.isSafeAddress('10.0.0.2')).toBe(true);
    expect(_internals.isSafeAddress('0.0.0.0')).toBe(false);
    expect(_internals.isSafeAddress('239.1.1.1')).toBe(false);
    expect(_internals.CONTROL_LIMITS.MAX_REPOSITORIES).toBe(200);
  });
});
