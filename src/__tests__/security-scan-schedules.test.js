'use strict';

process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'test';

const { Router } = require('express');
const express = require('express');
const request = require('supertest');
const { getDb, closeDb } = require('../db');
const docker = require('../services/docker');
const admission = require('../services/image-admission');
const notifications = require('../services/notificationChannels');
const scans = require('../services/security-scan-schedules');

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, res, next) => req.user ? next() : res.sendStatus(401),
  requireRole: role => (req, res, next) => req.user.role === role ? next() : res.sendStatus(403),
  writeable: (_req, _res, next) => next(),
}));

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const role = req.get('x-test-role');
  if (role) req.user = { id: role === 'admin' ? 800 : 801, role, username: role };
  next();
});
const router = Router();
router.use('/security-schedules', require('../routes/security-schedules'));
router.use('/images', require('../routes/images'));
app.use(router);
app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));

const admin = method => url => request(app)[method](url).set('x-test-role', 'admin');
const imageId = char => 'sha256:' + char.repeat(64);
const first = imageId('a');
const second = imageId('b');
const shared = imageId('c');
const unassigned = imageId('d');
const hostId = 811;
const scheduleSettings = {
  name: 'Docker security', hostId, kind: 'images', imageScope: 'running', scanner: 'auto',
  cron: '* * * * *', channelId: 801,
};
let db;
beforeAll(() => {
  db = getDb();
  const add = db.prepare("INSERT INTO users (id,username,password_hash,role,is_active) VALUES (?,?,'fixture',?,1)");
  add.run(800, 'scheduled-admin', 'admin');
  add.run(801, 'scheduled-viewer', 'viewer');
  db.prepare("INSERT INTO docker_hosts (id,name,connection_type,daemon_type,is_active) VALUES (?, 'Fixture Docker', 'socket', 'docker', 1)").run(hostId);
  db.prepare("INSERT INTO docker_hosts (id,name,connection_type,daemon_type,is_active) VALUES (812, 'Fixture Provider', 'tcp', 'proxmox', 1)").run();
  db.prepare("INSERT INTO notification_channels (id,name,provider,config_encrypted,created_by) VALUES (801,'Reports','webhook','fixture',800)").run();
});
beforeEach(() => {
  db.prepare('DELETE FROM security_scan_schedules').run();
  db.prepare('DELETE FROM scan_results').run();
  db.prepare('UPDATE users SET is_active=1 WHERE id=800').run();
});
afterEach(() => jest.restoreAllMocks());
afterAll(closeDb);

test('schedules and reports require an administrator and reject non-Docker hosts and malformed intervals', async () => {
  await request(app).get('/security-schedules').expect(401);
  await request(app).post('/security-schedules').set('x-test-role','viewer').send(scheduleSettings).expect(403);
  await request(app).get('/security-schedules/runs/1').set('x-test-role','viewer').expect(403);
  await admin('post')('/security-schedules').send({ ...scheduleSettings, hostId: 812 }).expect(400);
  await admin('post')('/security-schedules').send({ ...scheduleSettings, cron: '* * * * * *' }).expect(400);
  await admin('get')('/security-schedules/preview?cron=0%202%20*%20*%20*').expect(200)
    .expect(res => expect(res.body.nextRuns).toHaveLength(5));
});

test('automatic runs claim one cron slot, scan exact images once and send the persisted report', async () => {
  const fixture = { listContainers: jest.fn().mockResolvedValue([
    { Id: 'first', State: 'running', ImageID: first, Image: 'app:first' },
    { Id: 'same-image', State: 'running', ImageID: first, Image: 'app:alias' },
    { Id: 'second', State: 'running', ImageID: second, Image: 'app:second' },
  ]) };
  const connection = jest.spyOn(docker, 'getDocker').mockReturnValue(fixture);
  const scanner = jest.spyOn(admission, 'scanImageReport')
    .mockResolvedValueOnce({ scanner: 'trivy', data: { Results: [{ Vulnerabilities: [
      { VulnerabilityID: 'CVE-1', PkgName: 'openssl', InstalledVersion: '1', FixedVersion: '2', Severity: 'HIGH' },
      { VulnerabilityID: 'CVE-2', PkgName: 'libc', FixedVersion: 'not fixed', Severity: 'LOW' },
    ] }] } }).mockRejectedValueOnce(new Error('No scanner could verify a complete report for this image'));
  const deliver = jest.spyOn(notifications, 'send').mockImplementation(async (_id, message) => {
    const report = db.prepare('SELECT status,report_json FROM security_scan_runs').get();
    expect(report.status).toBe('partial');
    expect(JSON.parse(report.report_json).summary.fixable).toBe(1);
    expect(message.text).toContain('2 (1 with fixes available)');
    expect(message.text).toMatch(/#\/security\/schedules\/\d+/);
  });
  const created = await admin('post')('/security-schedules').send(scheduleSettings).expect(201);
  const id = created.body.id;
  const now = new Date('2026-11-13T22:00:00Z');
  scans.enqueueDue(now);
  scans.enqueueDue(now);
  await admin('post')('/security-schedules/' + id + '/run-now').expect(409);
  await Promise.all([scans.processNext(now), scans.processNext(now)]);
  scans.enqueueDue(now);
  expect(scanner.mock.calls.map(call => call[1])).toEqual([first, second]);
  expect(connection).toHaveBeenCalledWith(hostId);
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(deliver).toHaveBeenCalledWith(801, expect.any(Object), { diagnostics: true });
  const history = await admin('get')('/security-schedules/' + id + '/history').expect(200);
  expect(history.body).toEqual([expect.objectContaining({ status: 'partial', deliveryStatus: 'sent', trigger: 'automatic',
    summary: expect.objectContaining({ selected: 2, scanned: 1, failed: 1, total: 2, fixable: 1, high: 1 }) })]);
  const run = await admin('get')('/security-schedules/runs/' + history.body[0].id).expect(200);
  expect(run.body.report.images[0]).toMatchObject({ id: first, scanId: expect.any(Number), fixable: 1 });
  expect(db.prepare('SELECT host_id,verified_image_id,security_run_id FROM scan_results').get()).toMatchObject({
    host_id: hostId, verified_image_id: first, security_run_id: run.body.id,
  });
});

test('a manual CIS run reports incomplete coverage and preserves its result when delivery fails', async () => {
  jest.spyOn(docker, 'getDocker').mockReturnValue({
    info: async () => ({ LoggingDriver: 'json-file' }),
    listContainers: async () => [{ Id: 'running-a' }, { Id: 'running-b' }],
    getContainer: id => ({ inspect: async () => {
      if (id === 'running-b') throw Error('Fixture container disappeared');
      return { Name: '/fixture', Config: {}, HostConfig: { Privileged: true } };
    } }),
  });
  jest.spyOn(notifications, 'send').mockRejectedValue(new Error('fixture provider outage'));
  const schedule = await admin('post')('/security-schedules').send({ ...scheduleSettings, kind: 'cis', enabled: false }).expect(201);
  const queued = await admin('post')('/security-schedules/' + schedule.body.id + '/run-now').expect(202);
  await scans.processNext();
  const detail = await admin('get')('/security-schedules/runs/' + queued.body.id).expect(200);
  expect(detail.body).toMatchObject({ status: 'partial', deliveryStatus: 'error', deliveryError: 'Notification delivery failed',
    summary: { selected: 2, checked: 1, fail: 1 }, report: { checks: expect.arrayContaining([expect.objectContaining({ status: 'fail' })]) } });
});

test('editing invalidates a queued run and deactivating its owner stops automatic execution', async () => {
  const created = await admin('post')('/security-schedules').send(scheduleSettings).expect(201);
  const url = '/security-schedules/' + created.body.id;
  const queued = await admin('post')(url + '/run-now').expect(202);
  await admin('put')(url).send({ ...scheduleSettings, channelId: null }).expect(200);
  await scans.processNext();
  const cancelled = await admin('get')('/security-schedules/runs/' + queued.body.id).expect(200);
  expect(cancelled.body).toMatchObject({ status: 'error', deliveryStatus: 'none' });
  db.prepare('UPDATE users SET is_active=0 WHERE id=800').run();
  scans.enqueueDue();
  const data = scans.list();
  expect(data.schedules[0].enabled).toBe(false);
  expect(scans.history(created.body.id)).toHaveLength(1);
});

test('secondary-only images are excluded before history pagination and shared images stay visible', async () => {
  require('../services/stack-display-preferences').setSecondaryStack(800, hostId, 'demo', true);
  jest.spyOn(docker, 'listImages').mockResolvedValue([first, shared, unassigned].map(id => ({ id })));
  jest.spyOn(docker, 'listContainers').mockResolvedValue([
    { id: 'demo-only', stack: 'demo', imageIdFull: first },
    { id: 'demo-shared', stack: 'demo', imageIdFull: shared },
    { id: 'primary-shared', stack: 'primary', imageIdFull: shared },
  ]);
  const insert = db.prepare("INSERT INTO scan_results(image_id,verified_image_id,image_name,scanner,results_json,host_id) VALUES (?,?,?,'trivy','[]',?)");
  insert.run(shared, shared, 'shared', hostId);
  insert.run(first, first, 'demo', hostId);
  const suffix = '?hostId=' + hostId;
  const filtered = await admin('get')('/images' + suffix + '&secondary=hide').expect(200);
  expect(filtered.body.map(image => image.id)).toEqual([shared, unassigned]);
  const all = await admin('get')('/images' + suffix).expect(200);
  expect(all.body.map(image => image.id)).toContain(first);
  const history = await admin('get')('/images/scan-history' + suffix + '&secondary=hide&limit=1').expect(200);
  expect(history.body.map(row => row.image_id)).toEqual([shared]);
  const triage = await admin('get')('/images/scan-triage' + suffix + '&secondary=hide').expect(200);
  expect(triage.body.scans).toEqual([expect.objectContaining({
    verified_image_id: shared, consumers: [expect.objectContaining({ stack: 'primary' })],
  })]);
});
