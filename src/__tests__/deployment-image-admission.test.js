'use strict';

Object.assign(process.env, { APP_ENV: 'test', APP_SECRET: 'image-admission-test', DB_PATH: ':memory:',
  ENCRYPTION_KEY: 'test-encryption-key-for-jest-32chars' });
jest.mock('../services/docker', () => ({ getDocker: jest.fn(), inspectContainer: jest.fn(), containerAction: jest.fn(), removeContainer: jest.fn(), isSelf: jest.fn(() => false) }));
jest.mock('../services/image-admission', () => ({ scanImage: jest.fn() }));
jest.mock('../utils/docker-pull', () => ({ pullImage: jest.fn(async () => {}) }));
jest.mock('../services/audit', () => ({ log: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = req.get('x-test-role') === 'operator' ? { id: 201, username: 'restricted', role: 'operator' } : { id: 1, username: 'admin', role: 'admin' }; next(); },
  requireRole: () => (req, res, next) => next(), writeable: (req, res, next) => next(),
  requireFeature: () => (req, res, next) => next(),
}));
jest.mock('../middleware/hostId', () => ({ extractHostId: (req, res, next) => { req.hostId = 42; next(); } }));
jest.mock('../middleware/hostAccess', () => ({ requireHostAccessForMethod: () => (req, res, next) => next() }));

const express = require('express');
const request = require('supertest');
const dockerService = require('../services/docker');
const admission = require('../services/image-admission');
const audit = require('../services/audit');
const pipelines = require('../services/pipeline');
const { getDb } = require('../db');
const { sealSnapshot, readSnapshot } = require('../utils/history-snapshot');
const app = express(); app.use(express.json()); app.use('/containers', require('../routes/containers'));
const imageId = `sha256:${'b'.repeat(64)}`;
const daemon = require('./helpers/replacement-daemon');
jest.setTimeout(20000);
let docker, old, fixture;

beforeEach(() => {
  jest.clearAllMocks(); getDb().prepare('DELETE FROM deployment_pipelines').run();
  getDb().prepare('DELETE FROM container_image_history').run();
  getDb().prepare("INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (201, 'restricted', 'test-only', 'operator')").run();
  getDb().prepare("INSERT OR REPLACE INTO stack_permissions (user_id, stack_name, permission) VALUES (201, 'restricted-stack', 'none')").run();
  dockerService.inspectContainer.mockResolvedValue({ id: 'old-container', name: 'old', labels: { 'com.docker.compose.project': 'restricted-stack' } });
  fixture = daemon(); ({ docker, old } = fixture);
  dockerService.getDocker.mockReturnValue(docker);
  admission.scanImage.mockResolvedValue({ imageId, scanner: 'trivy', passed: false, status: 'unavailable' });
});

test.each(['unavailable', 'blocked'])('pipeline leaves original container untouched when scan is %s', async status => {
  admission.scanImage.mockResolvedValue({ imageId, passed: false, status });
  const result = await pipelines.start({ containerId: 'old-container', hostId: 42, user: { username: 'admin' } });
  expect(result.status).toBe('failed');
  expect(result.stages.find(s => s.name === 'scan').status).toBe('failed');
  expect(old.stop).not.toHaveBeenCalled(); expect(old.remove).not.toHaveBeenCalled();
  expect(docker.createContainer).not.toHaveBeenCalled();
  expect(admission.scanImage).toHaveBeenCalledWith(docker, imageId);
  expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'pipeline_scan_blocked' }));
});

test('pipeline creates using the admitted ID, not the mutable tag', async () => {
  admission.scanImage.mockResolvedValue({ imageId, passed: true, critical: 0, high: 0, unknown: 0 });
  const result = await pipelines.start({ containerId: 'old-container', hostId: 42, skipVerify: true });
  expect(result.status).toBe('success'); expect(result.image_after).toBe(imageId);
  expect(docker.createContainer).toHaveBeenCalledWith(expect.objectContaining({ Image: imageId }));
});

test.each(['unavailable', 'blocked'])('safe update leaves original container untouched when scan is %s', async status => {
  admission.scanImage.mockResolvedValue({ imageId, passed: false, status });
  const response = await request(app).post('/containers/aaaaaaaaaaaa/safe-update').send({});
  expect(response.status).toBe(200); expect(response.body).toMatchObject({ ok: false, blocked: true });
  expect(old.stop).not.toHaveBeenCalled(); expect(old.remove).not.toHaveBeenCalled();
  expect(docker.createContainer).not.toHaveBeenCalled();
  expect(admission.scanImage).toHaveBeenCalledWith(docker, imageId);
  expect(dockerService.getDocker).toHaveBeenCalledWith(42);
});

test('safe update creates using the admitted ID', async () => {
  admission.scanImage.mockResolvedValue({ imageId, passed: true, critical: 0, high: 0, unknown: 0 });
  const response = await request(app).post('/containers/aaaaaaaaaaaa/safe-update').send({});
  expect(response.status).toBe(200);
  expect(docker.createContainer).toHaveBeenCalledWith(expect.objectContaining({ Image: imageId }));
});

test('string-valued false cannot bypass required scanning', async () => {
  const response = await request(app).post('/containers/aaaaaaaaaaaa/pipeline/start').send({ skipScan: 'false' });
  expect(response.status).toBe(400); expect(docker.getContainer).not.toHaveBeenCalled();
});


test.each(['exited', 'unhealthy', 'unavailable'])('pipeline cannot report success when replacement is %s', async state => {
  jest.useFakeTimers();
  try {
    admission.scanImage.mockResolvedValue({ imageId, passed: true, critical: 0, high: 0, unknown: 0 });
    const create = docker.createContainer.getMockImplementation();
    docker.createContainer.mockImplementation(async opts => {
      const handle = await create(opts);
      if (opts.name === 'old') {
        const inspect = handle.inspect.getMockImplementation();
        handle.inspect.mockImplementationOnce(async () => {
          if (state === 'unavailable') throw new Error('Docker unreachable');
          const value = await inspect();
          value.State = state === 'exited' ? { Running: false } : { Running: true, Health: { Status: 'unhealthy' } };
          return value;
        });
      }
      return handle;
    });
    const pending = pipelines.start({ containerId: 'old-container', hostId: 42 });
    await jest.runAllTimersAsync();
    const result = await pending;
    expect(result.status).toBe('failed');
    expect(result.stages.find(s => s.name === 'verify').status).toBe('failed');
    expect(audit.log).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'pipeline_deploy' }));
  } finally { jest.useRealTimers(); }
});


test.each(['safe-update', 'update', 'smart-restart', 'rollback', 'pipeline/start', 'files/upload'])('stack restriction denies %s before touching the container', async endpoint => {
  const response = await request(app).post(`/containers/aaaaaaaaaaaa/${endpoint}`).set('x-test-role', 'operator').send({});
  expect(response.status).toBe(403);
  expect(old.stop).not.toHaveBeenCalled(); expect(old.remove).not.toHaveBeenCalled();
  expect(docker.createContainer).not.toHaveBeenCalled(); expect(admission.scanImage).not.toHaveBeenCalled();
});

test('container inspect does not disclose a forbidden stack', async () => {
  const response = await request(app).get('/containers/aaaaaaaaaaaa/inspect').set('x-test-role', 'operator');
  expect(response.status).toBe(403); expect(response.body.labels).toBeUndefined();
});

test.each(['logs', 'isolation', 'stats', 'export', 'deploy-preview', 'diagnose', 'doctor',
  'dependencies', 'files', 'files/content', 'files/download', 'diff', 'history',
  'pipeline/history', 'pipeline/status/1', 'meta'])('stack restriction denies read endpoint %s', async endpoint => {
  const response = await request(app).get(`/containers/aaaaaaaaaaaa/${endpoint}`).set('x-test-role', 'operator');
  expect(response.status).toBe(403);
  expect(docker.getContainer).not.toHaveBeenCalled();
  expect(response.body).toEqual({ error: expect.stringMatching(/stack permissions/) });
});

function pipelineRow(containerId = 'old-container', hostId = 42) {
  return getDb().prepare(`INSERT INTO deployment_pipelines
    (container_id, container_name, host_id, status, stages_json, started_by, image_before)
    VALUES (?, 'old', ?, 'failed', '[]', 'admin', 'private-image')`).run(containerId, hostId).lastInsertRowid;
}

test.each([['other host', 'old-container', 43], ['other container', 'other-container', 42]])(
  'pipeline status cannot disclose an execution from %s', async (_name, id, host) => {
    const execution = pipelineRow(id, host);
    const response = await request(app).get(`/containers/old-container/pipeline/status/${execution}`);
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Pipeline not found' });
    expect(JSON.stringify(response.body)).not.toContain('private-image');
  });

test('pipeline status accepts the exact original container on the selected host', async () => {
  const execution = pipelineRow();
  const response = await request(app).get(`/containers/old-container/pipeline/status/${execution}`);
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ id: Number(execution), container_id: 'old-container', host_id: 42 });
});

test.each(['1garbage', '1.5', '0', '-1', '9007199254740992'])('pipeline status rejects malformed execution ID %s', async execution => {
  pipelineRow();
  const response = await request(app).get(`/containers/old-container/pipeline/status/${execution}`);
  expect(response.status).toBe(404);
  expect(response.body).toEqual({ error: 'Pipeline not found' });
});

test('new pipeline persists the canonical original ID even when requested by name', async () => {
  const result = await pipelines.start({ containerId: 'old', hostId: 42 });
  expect(result.container_id).toBe('old-container');
});

function historyRow({ name = 'old', host = 42, snapshot = JSON.stringify({
  Env: ['TOKEN=private-history-secret'], Labels: { 'com.docker.compose.project': 'allowed-stack' }, HostConfig: {},
}) } = {}) {
  return getDb().prepare(`INSERT INTO container_image_history
    (container_name, container_id, host_id, image_name, image_id, action, config_snapshot)
    VALUES (?, 'previous-container', ?, 'previous-image', ?, 'update', ?)`)
    .run(name, host, imageId, snapshot === null ? null : sealSnapshot(snapshot, { container_name: name, host_id: host, image_id: imageId, container_id: 'previous-container' })).lastInsertRowid;
}

test.each([{ name: 'other-container' }, { host: 43 }])('rollback rejects unrelated history %j before mutations', async fields => {
  const historyId = historyRow(fields);
  const response = await request(app).post('/containers/old-container/rollback').send({ historyId });
  expect(response.status).toBe(404);
  expect(response.body).toEqual({ error: 'History entry not found' });
  expect(docker.getImage).not.toHaveBeenCalled();
  expect(old.stop).not.toHaveBeenCalled(); expect(old.remove).not.toHaveBeenCalled();
  expect(docker.createContainer).not.toHaveBeenCalled();
});

test.each(['{invalid', 'null', '[]'])('invalid historical configuration %s is rejected before stopping', async snapshot => {
  const historyId = historyRow({ snapshot });
  const response = await request(app).post('/containers/old-container/rollback').send({ historyId });
  expect(response.status).toBe(400);
  expect(old.stop).not.toHaveBeenCalled(); expect(old.remove).not.toHaveBeenCalled();
});

test.each([null, JSON.stringify({ Labels: { 'com.docker.compose.project': 'restricted-stack' } })])(
  'operator cannot restore missing or historically restricted configuration', async snapshot => {
    dockerService.inspectContainer.mockResolvedValue({ id: 'old-container', labels: { 'com.docker.compose.project': 'allowed-stack' } });
    const historyId = historyRow({ snapshot });
    const response = await request(app).post('/containers/old-container/rollback').set('x-test-role', 'operator').send({ historyId });
    expect(response.status).toBe(403);
    expect(old.stop).not.toHaveBeenCalled(); expect(docker.createContainer).not.toHaveBeenCalled();
  });

test('operator can restore authorized configuration belonging to this container and host', async () => {
  dockerService.inspectContainer.mockResolvedValue({ id: 'old-container', labels: { 'com.docker.compose.project': 'allowed-stack' } });
  const historyId = historyRow();
  const response = await request(app).post('/containers/old-container/rollback').set('x-test-role', 'operator').send({ historyId });
  expect(response.status).toBe(200); expect(response.body.ok).toBe(true);
  expect(docker.createContainer).toHaveBeenCalledWith(expect.objectContaining({ Image: imageId, name: 'old' }));
  expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'container_rollback' }));
});

test('self rollback is refused before mutations', async () => {
  const historyId = historyRow();
  dockerService.isSelf.mockReturnValueOnce(true);
  const response = await request(app).post('/containers/old-container/rollback').send({ historyId });
  expect(response.status).toBe(403);
  expect(old.stop).not.toHaveBeenCalled(); expect(old.remove).not.toHaveBeenCalled();
});

test('history response omits secret-bearing configuration while preserving the rollback record', async () => {
  const historyId = historyRow();
  const response = await request(app).get('/containers/old-container/history');
  expect(response.status).toBe(200);
  expect(response.body.entries).toEqual([expect.objectContaining({ id: Number(historyId), imageAvailable: true })]);
  expect(response.body.entries[0]).not.toHaveProperty('config_snapshot');
  expect(JSON.stringify(response.body)).not.toContain('private-history-secret');
  const stored = getDb().prepare('SELECT * FROM container_image_history WHERE id = ?').get(historyId);
  expect(stored.config_snapshot).not.toContain('private-history-secret');
  expect(readSnapshot(stored).Env).toEqual(['TOKEN=private-history-secret']);
});

test('bulk action applies stack permissions to each container', async () => {
  dockerService.inspectContainer.mockImplementation(async id => ({ labels: { 'com.docker.compose.project': id === 'allowed' ? 'allowed-stack' : 'restricted-stack' } }));
  const response = await request(app).post('/containers/bulk').set('x-test-role', 'operator').send({ ids: ['forbidden', 'allowed'], action: 'restart' });
  expect(response.status).toBe(200);
  expect(response.body.results).toEqual([expect.objectContaining({ id: 'forbidden', ok: false }), { id: 'allowed', ok: true }]);
  expect(dockerService.containerAction).toHaveBeenCalledTimes(1);
  expect(dockerService.containerAction).toHaveBeenCalledWith('allowed', 'restart', 42);
});

test('operator cannot use bulk remove to bypass administrator-only deletion', async () => {
  const response = await request(app).post('/containers/bulk').set('x-test-role', 'operator').send({ ids: ['allowed'], action: 'remove' });
  expect(response.status).toBe(403); expect(dockerService.removeContainer).not.toHaveBeenCalled();
});


test.each(['update', 'safe-update', 'rollback', 'pipeline'])('%s persists an encrypted, usable snapshot', async endpoint => {
  const inspect = await old.inspect(); inspect.Config.Env = ['TOKEN=current-secret'];
  old.inspect.mockResolvedValue(inspect);
  admission.scanImage.mockResolvedValue({ imageId, passed: true });
  if (endpoint === 'pipeline') {
    const result = await pipelines.start({ containerId: 'old-container', hostId: 42, skipVerify: true });
    expect(result.status).toBe('success');
  } else {
    const historyId = endpoint === 'rollback' ? historyRow() : undefined;
    const result = await request(app).post(`/containers/old-container/${endpoint}`).send({ historyId });
    expect(result.status).toBe(200);
  }
  const row = getDb().prepare('SELECT * FROM container_image_history ORDER BY id DESC LIMIT 1').get();
  expect(row.action).toBe(endpoint); expect(row.config_snapshot).toMatch(/^dd-history:v1:/);
  expect(row.config_snapshot).not.toContain('current-secret'); expect(readSnapshot(row).Env).toEqual(['TOKEN=current-secret']);
});

test.each(['update', 'safe-update', 'rollback', 'pipeline'])('%s aborts before workload mutation if history persistence fails', async endpoint => {
  const historyId = endpoint === 'rollback' ? historyRow() : undefined;
  admission.scanImage.mockResolvedValue({ imageId, passed: true });
  const db = getDb();
  db.exec("CREATE TEMP TRIGGER fail_history_insert BEFORE INSERT ON container_image_history BEGIN SELECT RAISE(FAIL, 'fixture history storage unavailable'); END");
  try {
    if (endpoint === 'pipeline') {
      const result = await pipelines.start({ containerId: 'old-container', hostId: 42, skipVerify: true });
      expect(result.status).toBe('failed'); expect(result.error).toContain('storage unavailable');
    } else {
      const result = await request(app).post(`/containers/old-container/${endpoint}`).send({ historyId });
      expect(result.status).toBe(502);
    }
    expect(old.stop).not.toHaveBeenCalled(); expect(old.remove).not.toHaveBeenCalled();
    expect(docker.createContainer.mock.calls.every(([opts]) => opts.name.startsWith('dd-replacement-lock-'))).toBe(true);
    expect(fixture.states.size).toBe(1);
  } finally { db.exec('DROP TRIGGER fail_history_insert'); }
});

test.each(['plaintext', 'damaged', 'wrong-context'])('rollback rejects %s snapshot before Docker mutation', async kind => {
  const historyId = historyRow();
  const db = getDb(); const row = db.prepare('SELECT * FROM container_image_history WHERE id = ?').get(historyId);
  const value = kind === 'plaintext' ? JSON.stringify({ Env: ['TOKEN=unexpected-secret'] })
    : kind === 'damaged' ? row.config_snapshot + 'ff'
    : sealSnapshot(JSON.stringify({ Env: ['TOKEN=unexpected-secret'] }), { ...row, host_id: 99 });
  db.prepare('UPDATE container_image_history SET config_snapshot = ? WHERE id = ?').run(value, historyId);
  const result = await request(app).post('/containers/old-container/rollback').send({ historyId });
  expect(result.status).toBe(400); expect(result.body).toEqual({ error: 'Rollback configuration is invalid' });
  expect(old.stop).not.toHaveBeenCalled(); expect(old.remove).not.toHaveBeenCalled();
  expect(docker.getImage).not.toHaveBeenCalled(); expect(docker.createContainer).not.toHaveBeenCalled();
});
