'use strict';

process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'test';

const express = require('express');
const request = require('supertest');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');

let mockLookupOffline = false;
jest.mock('../db', () => {
  const db = jest.requireActual('../db');
  return { ...db, getDb: () => {
    if (mockLookupOffline) throw new Error('fixture database offline');
    return db.getDb();
  } };
});
jest.mock('../middleware/auth', () => ({
  ...jest.requireActual('../middleware/auth'),
  requireAuth: (_req, _res, next) => next(),
}));
jest.mock('../middleware/hostId', () => {
  const { extractHostId } = jest.requireActual('../middleware/hostId');
  return { extractHostId: (req, res, next) => extractHostId(req, res, () => {
    // Observe the handoff without calling a daemon or carrying out a mutation.
    if (req.headers['x-test-stop-after-selection']) {
      return res.json({ hostId: req.hostId, resolvedHostId: req.resolvedHostId });
    }
    next();
  }) };
});

const { getDb, closeDb } = require('../db');
const docker = require('../services/docker');
const { dockerEvents } = require('../services/misc');
const hostPermissions = require('../services/host-permissions');

const workflows = [
  ['Container lifecycle', 'containers', 'POST', '/fixture/action'],
  ['Image management', 'images', 'POST', '/pull'],
  ['Volume management', 'volumes', 'DELETE', '/fixture'],
  ['Volume file browser', 'volume-browser', 'GET', '/fixture/browse'],
  ['Container networking', 'networks', 'POST', '/fixture/connect'],
  ['Swarm services', 'swarm', 'POST', '/services'],
  ['Docker event streaming', 'docker-events', 'GET', '/events'],
  ['Container metrics', 'stats', 'GET', '/overview'],
  ['Monitoring discovery', 'integrations', 'GET', '/uptime-kuma'],
  ['Container webhooks', 'container-webhooks', 'POST', '/fixture'],
  ['Stack bundle export', 'stackBundle', 'GET', '/export/stack/fixture'],
  ['Docker prune', 'system', 'POST', '/prune/all'],
  ['Compose deployment', 'system-stacks', 'POST', '/compose/fixture/up'],
  ['Scheduled container actions', 'system-schedules', 'POST', '/'],
  ['Database cleanup', 'system-database', 'POST', '/cleanup-aggressive'],
  ['Incus instances', 'incus', 'GET', '/instances'],
  ['Kubernetes workloads', 'kubernetes', 'GET', '/pods'],
  ['Nomad jobs', 'nomad', 'GET', '/jobs'],
  ['Proxmox inventory', 'proxmox', 'GET', '/nodes'],
  ['vSphere inventory', 'vsphere', 'GET', '/info'],
];

const cases = [
  ['default when omitted', '', undefined, 200, 0],
  ['explicit default', '?hostId=0', undefined, 200, 0],
  ['explicit query target', '?hostId=71', undefined, 200, 71],
  ['explicit header target', '', '71', 200, 71],
  ['matching selectors', '?hostId=071', '71', 200, 71],
  ['duplicate query', '?hostId=71&hostId=1', undefined, 400, 'INVALID_HOST_ID'],
  ['repeated identical query', '?hostId=71&hostId=71', undefined, 400, 'INVALID_HOST_ID'],
  ['blank query', '?hostId=', '71', 400, 'INVALID_HOST_ID'],
  ['bracketed query', '?hostId%5B%5D=71', undefined, 400, 'INVALID_HOST_ID'],
  ['case variant', '?HostId=71', undefined, 400, 'INVALID_HOST_ID'],
  ['partial number', '?hostId=71invalid', undefined, 400, 'INVALID_HOST_ID'],
  ['decimal number', '?hostId=71.5', undefined, 400, 'INVALID_HOST_ID'],
  ['negative number', '?hostId=-71', undefined, 400, 'INVALID_HOST_ID'],
  ['unsafe integer', '?hostId=9007199254740992', undefined, 400, 'INVALID_HOST_ID'],
  ['multi-value header', '', '71, 1', 400, 'INVALID_HOST_ID'],
  ['conflicting selectors', '?hostId=71', '1', 400, 'HOST_SELECTION_CONFLICT'],
  ['malformed header with a valid query', '?hostId=71', '71x', 400, 'INVALID_HOST_ID'],
  ['missing host', '?hostId=73', undefined, 404, 'HOST_NOT_FOUND'],
  ['inactive host', '?hostId=72', undefined, 400, 'HOST_INACTIVE'],
  ['lookup failure', '?hostId=71', undefined, 503, 'HOST_LOOKUP_UNAVAILABLE'],
];

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const role = req.headers['x-test-role'] || 'admin';
  req.user = { id: role === 'admin' ? 8 : 7, role, username: role };
  next();
});
for (const [, filename] of workflows) {
  const router = require('../routes/' + filename);
  app.use('/' + filename, router.mgmt || router);
}
app.use('/hosts', require('../routes/hosts'));
app.use('/host-permissions', require('../routes/host-permissions'));

beforeAll(() => {
  getDb().exec(`
    INSERT INTO users (id, username, password_hash, role) VALUES
      (7, 'contract-viewer', 'unused', 'viewer'), (8, 'contract-admin', 'unused', 'admin');
    INSERT INTO docker_hosts (id, name, socket_path, is_active) VALUES
      (71, 'secondary-fixture', '/fixture-secondary.sock', 1),
      (72, 'inactive-fixture', '/fixture-inactive.sock', 0);
    INSERT INTO docker_hosts (id, name, daemon_type, socket_path) VALUES
      (74, 'provider-fixture', 'kubernetes', '/var/run/docker.sock');
  `);
});
afterEach(() => { mockLookupOffline = false; });
afterAll(closeDb);

describe.each(workflows)('%s', (_name, filename, method, endpoint) => {
  test.each(cases)('%s', async (_case, query, header, status, expected) => {
    mockLookupOffline = status === 503;
    const probe = request(app)[method.toLowerCase()]('/' + filename + endpoint + query);
    if (status === 200) probe.set('X-Test-Stop-After-Selection', 'true');
    if (header !== undefined) probe.set('X-Docker-Host', header);
    const response = await probe.expect(status);
    if (status === 200) expect(response.body).toEqual({ hostId: expected, resolvedHostId: expected || 1 });
    else expect(response.body.code).toBe(expected);
  });
});

test('admin default changes take effect on the next daemon lookup and preserve inactive-host protection', async () => {
  const initial = docker.getDocker(0);
  await request(app).post('/hosts/72/default').expect(400);
  await request(app).post('/hosts/71suffix/default').expect(400);
  expect(docker.getDocker(0)).toBe(initial);
  try {
    await request(app).post('/hosts/71/default').expect(200);
    expect(docker.getDocker(0)).not.toBe(initial);
    expect(docker.getDocker(0)).toBe(docker.getDocker(71));
    expect(hostPermissions.normalizeHostId(0)).toBe(71);
    expect(require('../services/terminal-access').normalizeHostId(0)).toBe(71);
  } finally {
    await request(app).post('/hosts/1/default').expect(200);
  }
});

test('Containers can request the resolved host without changing the legacy list shape or host grants', async () => {
  const rows = [{ id: 'fixture', name: 'demo', labels: {} }];
  const list = jest.spyOn(docker, 'listContainers').mockResolvedValue(rows);
  try {
    const legacy = await request(app).get('/containers').expect(200);
    expect(legacy.body).toEqual(rows);
    const local = await request(app).get('/containers?context=1&hostId=0').expect(200);
    expect(local.body).toMatchObject({ containers: rows, host: { id: 1, connectionType: 'socket' } });
    const selected = await request(app).get('/containers?context=1&hostId=71').expect(200);
    expect(selected.body).toEqual({ containers: rows, host: { id: 71, name: 'secondary-fixture', connectionType: 'socket' } });
    expect(list.mock.calls.map(([id]) => id)).toEqual([1, 1, 71]);
    await request(app).get('/containers?context=1&hostId=72').expect(400);
    expect(list).toHaveBeenCalledTimes(3);
  } finally {
    list.mockRestore();
  }
});

test('event history only returns records for the authorized daemon', async () => {
  const getHistory = query => request(app).get('/system/events' + query).set('X-Test-Role', 'viewer');
  dockerEvents.store({ hostId: 1, eventType: 'container', action: 'start', actorName: 'hidden' });
  dockerEvents.store({ hostId: 71, eventType: 'container', action: 'start', actorName: 'visible' });
  hostPermissions.setLegacyDefault(false);
  hostPermissions.grant({ hostId: 71, userId: 7, permission: 'view' }, 8);
  try {
    await getHistory('').expect(403);
    const result = await getHistory('?hostId=71').expect(200);
    expect(result.body.map(event => event.actor_name)).toEqual(['visible']);
  } finally {
    hostPermissions.setLegacyDefault(true);
  }
});

test('Docker activity keeps audit records separate and on the resolved host', async () => {
  const audit = require('../services/audit');
  dockerEvents.store({ hostId: 71, eventType: 'container', action: 'die', actorId: 'b'.repeat(64),
    actorName: 'fixture-app', attributes: { 'com.docker.compose.project': 'fixture' } });
  audit.log({ userId: 8, username: 'contract-admin', action: 'compose_up', targetType: 'stack',
    targetId: 'fixture', details: { hostId: 71, sensitive: 'not in timeline' } });
  const admin = await request(app).get('/system/docker-activity?hostId=71&stack=fixture').expect(200);
  expect(admin.body.items.map(row => row.source).sort()).toEqual(['audit', 'docker']);
  expect(JSON.stringify(admin.body)).not.toContain('not in timeline');
  await request(app).get('/system/docker-activity?hostId=71&source=audit').set('X-Test-Role', 'viewer').expect(403);
  const other = await request(app).get('/system/docker-activity?hostId=1&stack=fixture').expect(200);
  expect(other.body.items).toEqual([]);
});

test('effective access explains a direct grant and still enforces the user role', async () => {
  const id = hostPermissions.grant({ hostId: 71, userId: 7, permission: 'operate' }, 8);
  try {
    const result = await request(app).get('/host-permissions/explain?hostId=71&userId=7').expect(200);
    expect(result.body).toMatchObject({
      permission: 'operate', sources: [{ kind: 'direct', permission: 'operate' }],
      actions: { viewContainers: true, operateContainers: false, manageHostSettings: false },
    });
    await request(app).get('/host-permissions/explain?hostId=71&userId=7').set('X-Test-Role', 'viewer').expect(403);
  } finally {
    hostPermissions.revoke(id);
  }
});

test('configuration backup preview lists overwrites, skips API key metadata and rejects a stale review', async () => {
  const db = getDb();
  const save = db.prepare("INSERT INTO settings (key, value) VALUES ('test_restore_setting', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  save.run('previous');
  const exported = await request(app).get('/system/backup/config').expect(200);
  expect(exported.body).toMatchObject({ settings: expect.any(Array), users: expect.any(Array), apiKeys: expect.any(Array) });
  const backup = { version: '8.96.30', settings: [{ key: 'test_restore_setting', value: 'next' }], apiKeys: [{ id: 1 }] };
  const plan = (await request(app).post('/system/backup/restore/plan').send(backup).expect(200)).body;
  expect(plan).toMatchObject({ replaces: ['test_restore_setting'], apiKeysSkipped: 1 });
  expect(JSON.stringify(plan)).not.toContain('previous');
  save.run('concurrent');
  await request(app).post('/system/backup/restore').send({ ...backup, planId: plan.planId }).expect(409);
  const fresh = (await request(app).post('/system/backup/restore/plan').send(backup).expect(200)).body;
  await request(app).post('/system/backup/restore').send({ ...backup, planId: fresh.planId }).expect(200);
  expect(db.prepare("SELECT value FROM settings WHERE key = 'test_restore_setting'").get().value).toBe('next');
});

test('only the reviewed database copy is deleted, even when another location uses the same name', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-delete-copy-'));
  const scheduled = path.join(root, 'backups');
  const originalDataDir = process.env.DATA_DIR;
  const config = require('../config');
  const originalDbPath = config.db.path;
  process.env.DATA_DIR = root;
  fs.mkdirSync(scheduled);
  try {
    const name = 'backup-copy.db.enc';
    const active = 'backup-active.db';
    config.db.path = path.join(root, active);
    fs.writeFileSync(config.db.path, 'database');
    fs.writeFileSync(path.join(root, name), 'manual copy');
    fs.writeFileSync(path.join(scheduled, name), 'scheduled copy');
    const inventory = () => request(app).get('/system/backup/list').expect(200);
    const remove = (location, file, revision) => request(app)
      .delete(`/system/backup/local/${location}/${encodeURIComponent(file)}`).send({ revision });

    const { body: { files } } = await inventory();
    expect(files.map(file => [file.location, file.name]).sort()).toEqual([['local', name], ['scheduled', name]]);
    const selected = files.find(file => file.location === 'scheduled');
    await remove('scheduled', name, selected.revision).set('X-Test-Role', 'viewer').expect(403);
    await remove('scheduled', '../' + name, selected.revision).expect(400);
    await remove('local', active, selected.revision).expect(404);
    fs.appendFileSync(path.join(scheduled, name), ' replaced');
    await remove('scheduled', name, selected.revision).expect(409);
    const fresh = (await inventory()).body.files.find(file => file.location === 'scheduled');
    await remove('scheduled', name, fresh.revision).expect(200, { ok: true });
    await remove('scheduled', name, fresh.revision).expect(404);
    expect(fs.readFileSync(path.join(root, name), 'utf8')).toBe('manual copy');
    expect(fs.readFileSync(config.db.path, 'utf8')).toBe('database');
    const audit = getDb().prepare('SELECT target_id, details FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1')
      .get('database_backup_deleted');
    expect(audit.target_id).toBe(name);
    expect(JSON.parse(audit.details).location).toBe('scheduled');
  } finally {
    config.db.path = originalDbPath;
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bulk backup deletion checks every selection before deleting and reports per-copy failures', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-delete-copies-'));
  const originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = root;
  try {
    const manual = path.join(root, 'backup-same.db.enc');
    const scheduled = path.join(root, 'backups', 'backup-same.db.enc');
    const untouched = path.join(root, 'backup-keep.db');
    fs.mkdirSync(path.dirname(scheduled));
    for (const file of [manual, scheduled, untouched]) fs.writeFileSync(file, 'fixture');
    const list = async () => (await request(app).get('/system/backup/list').expect(200)).body.files
      .filter(file => file.name === 'backup-same.db.enc').map(({ name, location, revision }) => ({ name, location, revision }));
    const remove = copies => request(app).delete('/system/backup/local/bulk').send({ copies });
    const copies = await list();
    await remove(copies).set('X-Test-Role', 'viewer').expect(403);
    await remove([copies[0], copies[0]]).expect(400);
    await remove([copies[0], { ...copies[1], name: '../backup-keep.db' }]).expect(400);
    fs.appendFileSync(scheduled, ' updated');
    const stale = await remove(copies).expect(409);
    expect(stale.body.conflicts).toMatchObject([{ location: 'scheduled', status: 409 }]);
    expect(fs.existsSync(manual)).toBe(true);

    const fresh = await list();
    const unlink = fs.unlinkSync;
    const failingUnlink = jest.spyOn(fs, 'unlinkSync').mockImplementation(file => {
      if (file === scheduled) throw Object.assign(new Error('fixture failure'), { code: 'EACCES' });
      return unlink(file);
    });
    try {
      const partial = await remove(fresh).expect(200);
      expect(partial.body.deleted).toEqual([{ location: 'local', name: 'backup-same.db.enc' }]);
      expect(partial.body.failed).toMatchObject([{ location: 'scheduled', status: 403 }]);
    } finally { failingUnlink.mockRestore(); }
    expect(fs.existsSync(manual)).toBe(false);
    expect(fs.existsSync(scheduled)).toBe(true);

    fs.writeFileSync(manual, 'fresh manual copy');
    const all = await remove(await list()).expect(200);
    expect(all.body.deleted.map(copy => copy.location).sort()).toEqual(['local', 'scheduled']);
    expect(all.body.failed).toEqual([]);
    expect(fs.existsSync(manual) || fs.existsSync(scheduled)).toBe(false);
    expect(fs.existsSync(untouched)).toBe(true);
  } finally {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('administrators can download reviewed local and encrypted backup bytes without exposing the active database', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-download-copy-'));
  const originalDataDir = process.env.DATA_DIR;
  const config = require('../config');
  const originalDbPath = config.db.path;
  process.env.DATA_DIR = root;
  try {
    const active = 'backup-active.db';
    const manual = 'backup-manual.db';
    const encrypted = 'backup-encoded.db.enc';
    const plain = Buffer.from('SQLite format 3\0fixture');
    const ciphertext = Buffer.from([0, 123, 255, 9, 200, 0]);
    config.db.path = path.join(root, active);
    fs.mkdirSync(path.join(root, 'backups'));
    fs.writeFileSync(config.db.path, 'active');
    fs.writeFileSync(path.join(root, manual), plain);
    fs.writeFileSync(path.join(root, 'backups', encrypted), ciphertext);
    const inventory = (await request(app).get('/system/backup/list').expect(200)).body.files;
    const url = ({ location, name, revision }) =>
      `/system/backup/local/${location}/${encodeURIComponent(name)}/download?hostId=0&revision=${revision}`;
    for (const [name, bytes] of [[manual, plain], [encrypted, ciphertext]]) {
      const copy = inventory.find(file => file.name === name);
      await request(app).head(url(copy)).expect(200).expect('Content-Length', String(bytes.length));
      const downloaded = await request(app).get(url(copy)).expect(200)
        .expect('Content-Type', 'application/octet-stream')
        .expect('Cache-Control', 'no-store');
      expect(downloaded.headers['content-disposition'].replaceAll('"', '')).toBe(`attachment; filename=${name}`);
      expect(downloaded.body).toEqual(bytes);
    }
    const copy = inventory.find(file => file.name === encrypted);
    await request(app).get(url(copy)).set('X-Test-Role', 'viewer').expect(403);
    await request(app).get(url({ ...copy, name: '../' + manual })).expect(400);
    await request(app).get(url({ ...copy, location: 'local', name: active })).expect(404);
    fs.appendFileSync(path.join(root, 'backups', encrypted), ' changed');
    await request(app).get(url(copy)).expect(409);
    const audit = getDb().prepare("SELECT target_id FROM audit_log WHERE action = 'database_backup_download' ORDER BY id").all();
    expect(audit.map(entry => entry.target_id)).toEqual([manual, encrypted]);
  } finally {
    config.db.path = originalDbPath;
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scheduled actions keep their original daemon and enforce access on the saved target', async () => {
  const created = await request(app).post('/system-schedules').send({
    containerId: 'fixture', action: 'stop', cron: '0 3 * * *', enabled: false,
  }).expect(201);
  expect(created.body.hostId).toBe(1);
  const route = '/system-schedules/' + created.body.id;
  const action = jest.spyOn(docker, 'containerAction').mockResolvedValue();
  hostPermissions.setLegacyDefault(false);
  hostPermissions.grant({ hostId: 71, userId: 7, permission: 'operate' }, 8);
  try {
    await request(app).post('/hosts/71/default').expect(200);
    await request(app).get('/system-schedules').set('X-Test-Role', 'operator').expect(200, []);
    await request(app).put(route).set('X-Test-Role', 'operator').send({ enabled: true }).expect(403);
    await request(app).post(route + '/run-now').set('X-Test-Role', 'operator').expect(403);
    expect(action).not.toHaveBeenCalled();
    await request(app).post(route + '/run-now').expect(200);
    expect(action).toHaveBeenCalledWith('fixture', 'stop', 1);
  } finally {
    action.mockRestore();
    hostPermissions.setLegacyDefault(true);
    await request(app).post('/hosts/1/default').expect(200);
  }
});

test('a prune request reaches exactly the selected host and lookup failure dispatches nothing', async () => {
  const prune = jest.spyOn(docker, 'prune').mockResolvedValue({ protection: {} });
  try {
    await request(app).post('/system/prune/images?hostId=71').expect(200);
    expect(prune).toHaveBeenCalledWith({ images: true }, 71);
    mockLookupOffline = true;
    await request(app).post('/system/prune/images?hostId=71').expect(503);
    expect(prune).toHaveBeenCalledTimes(1);
  } finally {
    mockLookupOffline = false;
    prune.mockRestore();
  }
});

test('a provider record with a Docker socket path cannot be used to prune the local daemon', async () => {
  expect(() => docker.getDocker(74)).toThrow(/requires a Docker-compatible host/);
  await request(app).post('/system/prune/images?hostId=74').expect(400);
});

test('prune rejects ambiguous false values and reports known completed phases', async () => {
  const failure = Object.assign(new Error('Connection lost'), {
    recoveryRequired: true, pruneProgress: { failedStage: 'volumes', completed: ['images'], spaceReclaimed: 123 },
  });
  const prune = jest.spyOn(docker, 'prune').mockRejectedValue(failure);
  try {
    await request(app).post('/system/prune').send({ volumes: 'false' }).expect(400);
    expect(prune).not.toHaveBeenCalled();
    const response = await request(app).post('/system/prune/all?hostId=71').expect(500);
    expect(response.body).toMatchObject({ recoveryRequired: true, progress: failure.pruneProgress });
  } finally { prune.mockRestore(); }
});

test('Docker SSE checks upstream before committing headers and keeps split UTF-8 events intact', async () => {
  const open = jest.spyOn(docker, 'getEventStream').mockRejectedValueOnce(new Error('private upstream endpoint'));
  try {
    await request(app).get('/docker-events/events?hostId=71').expect(503, {
      error: 'Docker event stream is unavailable', code: 'EVENT_STREAM_UNAVAILABLE',
    });
    await request(app).get('/docker-events/events?hostId=71&filter=container&filter=image').expect(400);
    expect(open).toHaveBeenCalledTimes(1);
    const stream = new PassThrough();
    open.mockResolvedValueOnce(stream);
    const wire = Buffer.from('{"Type":"container","name":"ș"}\n{"Type":"image","name":"ignore"}\n');
    const utf8 = wire.indexOf(Buffer.from('ș'));
    stream.write(wire.subarray(0, utf8 + 1));
    stream.end(wire.subarray(utf8 + 1));
    const result = await request(app).get('/docker-events/events?hostId=71&filter=container').expect(200);
    expect(result.text).toContain('{"Type":"container","name":"ș"}');
    expect(result.text).not.toContain('ignore');
    expect(result.text).toContain('event: end');
    expect(open).toHaveBeenLastCalledWith(71, { abortSignal: expect.any(AbortSignal) });
  } finally { open.mockRestore(); }
});

test('aggressive retention rejects malformed input and preserves strict-mode audit history', async () => {
  const db = getDb();
  const config = require('../config');
  const previous = config.security.isStrict;
  const entry = db.prepare("INSERT INTO audit_log (action, created_at) VALUES ('strict-fixture', '2020-01-01')").run();
  config.security.isStrict = true;
  try {
    await request(app).post('/system-database/cleanup-aggressive').send({ hours: -1 }).expect(400);
    await request(app).post('/system-database/cleanup-aggressive').send({ hours: '1e2' }).expect(400);
    await request(app).post('/system-database/cleanup-aggressive').send({ hours: 24 }).expect(200);
    expect(db.prepare('SELECT action FROM audit_log WHERE id = ?').get(entry.lastInsertRowid).action).toBe('strict-fixture');
  } finally { config.security.isStrict = previous; }
});

test('provider inventory enforces per-host grants before connecting or disclosing provider type', async () => {
  hostPermissions.setLegacyDefault(false);
  try {
    const routes = ['/incus/info', '/kubernetes/pods', '/nomad/jobs', '/proxmox/nodes', '/vsphere/info'];
    for (const route of routes) {
      await request(app).get(route + '?hostId=1').set('X-Test-Role', 'viewer').expect(403);
    }
    await request(app).get('/kubernetes/kubeconfig?hostId=71').set('X-Test-Role', 'viewer').expect(403);
  } finally {
    hostPermissions.setLegacyDefault(true);
  }
});

test('browser does not overwrite an explicit target with the selected host', () => {
  const code = fs.readFileSync(path.join(__dirname, '../../public/js/api.js'), 'utf8');
  const api = vm.runInNewContext(code + '\nApi;', { URLSearchParams, window: {} });
  api._currentHostId = 71;
  expect(api._appendHostId('/swarm/services/from-container?containerId=abc&hostId=0')).toBe('/swarm/services/from-container?containerId=abc&hostId=0');
  expect(api._appendHostId('/containers?limit=20')).toBe('/containers?limit=20&hostId=71');
});
