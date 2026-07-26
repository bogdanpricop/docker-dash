'use strict';

process.env.APP_SECRET = 'provider-console-test-secret-32-characters';
process.env.ENCRYPTION_KEY = 'provider-console-test-encryption-key';
process.env.DB_PATH = ':memory:';

const { getDb, closeDb } = require('../db');
const config = require('../config');
const { normalizeResource } = require('../services/provider-sdk/resource-schema');
const resourceSnapshots = require('../services/provider-sdk/resource-snapshots');
const broker = require('../services/provider-console/broker');
const access = require('../services/provider-console/access');

let database;
let host;
let userId;
let resource;

const registry = {
  capabilitiesForHost: jest.fn(async () => ({
    probe: { status: 'reachable' },
    features: { 'vm.console': { state: 'conditional', reason: 'live console' } },
  })),
  resourcesForHost: jest.fn(async () => ({ items: [resource] })),
};

beforeAll(() => {
  database = getDb();
  host = {
    id: Number(database.prepare(`INSERT INTO docker_hosts
      (name, connection_type, socket_path, is_active, is_default, daemon_type, daemon_config)
      VALUES ('Console Proxmox', 'tcp', '', 1, 0, 'proxmox', '{}')`).run().lastInsertRowid),
    daemon_type: 'proxmox',
  };
  userId = Number(database.prepare(`INSERT INTO users (username, password_hash, role)
    VALUES ('console-operator', 'hash', 'operator')`).run().lastInsertRowid);
  resource = normalizeResource({
    host, providerType: 'proxmox', kind: 'virtualMachine', observedAt: new Date().toISOString(), database,
    raw: { id: 'qemu/101', uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'app-01', status: 'running', node: 'pve-1' },
  });
  resourceSnapshots.rememberMany([resource], database);
});

beforeEach(() => {
  database.prepare('DELETE FROM provider_console_sessions').run();
  database.prepare('DELETE FROM provider_console_access_locks').run();
  config.features.providerVmConsole = true;
  config.providerConsole.accessOverride = 'managed';
  registry.capabilitiesForHost.mockClear();
});

afterAll(() => closeDb());

describe('provider VM console broker and emergency locks', () => {
  it('issues only a short one-time token and stores its hash', async () => {
    const launch = await broker.createForHost(host, resource.id, {
      database, registry, canOperate: true, userId,
    });
    expect(launch.token).toMatch(broker.TOKEN_RE);
    expect(launch.expiresAt).toBeTruthy();
    const row = database.prepare('SELECT * FROM provider_console_sessions WHERE id = ?').get(launch.id);
    expect(row.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(row)).not.toContain(launch.token);

    const consumed = broker.consume(launch.token, userId, { database });
    expect(consumed).toMatchObject({ id: launch.id, resource_id: resource.id, provider_type: 'proxmox' });
    expect(consumed.identity.nativeRef).toBe('qemu/101');
    expect(() => broker.consume(launch.token, userId, { database })).toThrow(/invalid or expired/i);
  });

  it('fails closed for release flag, permissions, VM state and locks', async () => {
    config.features.providerVmConsole = false;
    const disabled = await broker.preflightForHost(host, resource.id, { database, registry, canOperate: false });
    expect(disabled.ready).toBe(false);
    expect(disabled.blockers.map(item => item.type)).toEqual(expect.arrayContaining([
      'PERMISSION_BLOCKED', 'CONSOLE_ACCESS_LOCKED',
    ]));

    config.features.providerVmConsole = true;
    access.setVirtualMachine(host.id, resource.id, { locked: true, reason: 'Incident', userId }, database);
    const locked = await broker.preflightForHost(host, resource.id, { database, registry, canOperate: true });
    expect(locked.blockers).toContainEqual(expect.objectContaining({
      type: 'CONSOLE_ACCESS_LOCKED', reason: 'Incident',
    }));
  });

  it('supports global, provider and VM emergency lock precedence plus recovery override', () => {
    access.setVirtualMachine(host.id, resource.id, { locked: true, reason: 'VM lock', userId }, database);
    expect(access.effective(host.id, resource.id, database)).toMatchObject({ source: 'virtualMachine' });
    access.setHost(host.id, { locked: true, reason: 'Provider lock', userId }, database);
    expect(access.effective(host.id, resource.id, database)).toMatchObject({ source: 'host' });
    access.setGlobal({ locked: true, reason: 'Global lock', userId }, database);
    expect(access.effective(host.id, resource.id, database)).toMatchObject({ source: 'global' });

    config.providerConsole.accessOverride = 'allow';
    expect(access.effective(host.id, resource.id, database)).toMatchObject({
      locked: false, source: 'environment_recovery',
    });
    config.providerConsole.accessOverride = 'deny';
    expect(access.effective(host.id, resource.id, database)).toMatchObject({ locked: true, source: 'environment' });
  });
});
