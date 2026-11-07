'use strict';

process.env.APP_ENV = 'test';
process.env.DB_PATH = ':memory:';

const express = require('express');
const request = require('supertest');
jest.mock('../services/docker', () => ({ getDocker: jest.fn(), isSelf: jest.fn() }));
jest.mock('../utils/docker-pull', () => ({ pullImage: jest.fn() }));
jest.mock('../services/container-replacement', () => ({ replace: jest.fn() }));

const dockerService = require('../services/docker');
const { pullImage } = require('../utils/docker-pull');
const { replace } = require('../services/container-replacement');
const { getDb, closeDb } = require('../db');
const config = require('../config');
const auth = require('../services/auth');
const { mgmt, trigger } = require('../routes/container-webhooks');

const app = express();
app.use(express.json());
app.use(require('../middleware/csrf'));
app.use('/manage', mgmt);
app.use('/webhook/container', trigger);
const inspect = jest.fn();
const restart = jest.fn();
const imageId = 'sha256:' + 'a'.repeat(64);
const daemon = { getContainer: jest.fn(() => ({ inspect, restart })), getImage: () => ({ inspect: async () => ({ Id: imageId }) }) };
let admin, viewer;

beforeAll(() => {
  const db = getDb();
  db.exec("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'hooks-admin', 'unused', 'admin'), (2, 'hooks-viewer', 'unused', 'viewer')");
  const session = id => auth._createSession(db.prepare('SELECT * FROM users WHERE id = ?').get(id), '127.0.0.1', 'test').token;
  admin = session(1);
  viewer = session(2);
});
afterAll(closeDb);
beforeEach(() => {
  jest.clearAllMocks();
  dockerService.getDocker.mockReturnValue(daemon);
  dockerService.isSelf.mockReturnValue(false);
  inspect.mockImplementation(async () => ({ Id: daemon.getContainer.mock.lastCall[0], Config: { Image: 'fixture:latest' } }));
  pullImage.mockResolvedValue();
  restart.mockResolvedValue();
});

const create = (name, action) => request(app).post('/manage/' + name).set('Authorization', 'Bearer ' + admin).send({ action });

test('default host webhook stores the real daemon, hides its trigger token from viewers and only restarts', async () => {
  await create('wrong-action', 'typo').expect(400);
  const { body } = await create('restart-fixture', 'restart').expect('Cache-Control', 'no-store').expect(201);
  expect(getDb().prepare('SELECT host_id FROM container_webhooks WHERE id = ?').get(body.id).host_id).toBe(1);
  await request(app).get('/manage/restart-fixture').set('Authorization', 'Bearer ' + viewer).expect(403);
  await request(app).post('/webhook/container/' + body.token).expect(200);
  expect(dockerService.getDocker).toHaveBeenCalledWith(1);
  expect(restart).toHaveBeenCalledTimes(1);
  expect(pullImage).not.toHaveBeenCalled();
});

test('a failed pull never reports success or replaces the container', async () => {
  const { body } = await create('pull-fixture', 'pull-only').expect(201);
  pullImage.mockRejectedValueOnce(new Error('fixture registry offline'));
  await request(app).post('/webhook/container/' + body.token).expect(500);
  expect(pullImage).toHaveBeenCalledWith(daemon, 'fixture:latest');
  expect(restart).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
});

test('recreate uses the existing guarded replacement and advances the same webhook to the new container', async () => {
  const { body } = await create('recreate-fixture', 'recreate').expect(201);
  replace.mockImplementation(async ({ commit }) => {
    commit('replacement-fixture');
    return { operationId: 'op-fixture', cleanupRequired: false };
  });
  const result = await request(app).post('/webhook/container/' + body.token).expect(200);
  expect(result.body.operationId).toBe('op-fixture');
  expect(replace).toHaveBeenCalledWith(expect.objectContaining({ docker: daemon, imageId, hostId: 1 }));
  expect(getDb().prepare('SELECT container_id FROM container_webhooks WHERE token = ?').get(body.token).container_id).toBe('replacement-fixture');
});

test('read-only mode stops valid triggers before daemon access', async () => {
  const { body } = await create('read-only-fixture', 'restart').expect(201);
  const previous = config.features.readOnly;
  config.features.readOnly = true;
  try {
    await request(app).post('/webhook/container/' + body.token).expect(403);
    expect(dockerService.getDocker).not.toHaveBeenCalled();
  } finally { config.features.readOnly = previous; }
});

test('revoking a webhook during inspection prevents the pending restart', async () => {
  const { body } = await create('revocation-fixture', 'restart').expect(201);
  inspect.mockImplementationOnce(async () => {
    getDb().prepare('DELETE FROM container_webhooks WHERE id = ?').run(body.id);
    return { Id: 'revocation-fixture', Config: { Image: 'fixture:latest' } };
  });
  await request(app).post('/webhook/container/' + body.token).expect(409);
  expect(restart).not.toHaveBeenCalled();
});
