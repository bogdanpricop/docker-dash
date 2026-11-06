'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-dash-procedure-routes-'));
process.env.APP_SECRET = 'procedure-routes-test-secret';
process.env.ENCRYPTION_KEY = 'procedure-routes-test-key-32-chars';
process.env.DB_PATH = ':memory:';
process.env.DATA_DIR = testDataDir;

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, res, next) => {
    if (!req.headers['x-test-user-id']) return res.status(401).json({ error: 'Authentication required' });
    req.user = {
      id: Number(req.headers['x-test-user-id']),
      username: req.headers['x-test-username'] || 'test-user',
      role: req.headers['x-test-role'] || 'viewer',
    };
    next();
  },
  requireRole: (...roles) => (req, res, next) => roles.includes(req.user.role)
    ? next()
    : res.status(403).json({ error: 'Insufficient permissions' }),
  writeable: (_req, _res, next) => next(),
}));

const express = require('express');
const request = require('supertest');
const { getDb, closeDb } = require('../db');
const procedures = require('../services/procedures');

const app = express();
app.use(express.json());
app.use('/api/procedures', require('../routes/procedures'));

let adminId;
let operatorId;
let otherOperatorId;

function auth(id, role, username) {
  return {
    'x-test-user-id': String(id),
    'x-test-role': role,
    'x-test-username': username,
  };
}

beforeAll(() => {
  const db = getDb();
  adminId = Number(db.prepare(
    "INSERT INTO users (username, password_hash, role) VALUES ('route-admin', 'hash', 'admin')"
  ).run().lastInsertRowid);
  operatorId = Number(db.prepare(
    "INSERT INTO users (username, password_hash, role) VALUES ('route-operator', 'hash', 'operator')"
  ).run().lastInsertRowid);
  otherOperatorId = Number(db.prepare(
    "INSERT INTO users (username, password_hash, role) VALUES ('route-other', 'hash', 'operator')"
  ).run().lastInsertRowid);
});

afterAll(async () => {
  await Promise.allSettled([...procedures._runPromises.values()]);
  closeDb();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

describe('procedure HTTP API', () => {
  let procedureId;
  let runId;

  it('requires authentication and administrator access for creation', async () => {
    await request(app).get('/api/procedures').expect(401);
    await request(app).post('/api/procedures')
      .set(auth(operatorId, 'operator', 'route-operator'))
      .send({ name: 'not-allowed', steps: [] })
      .expect(403);
  });

  it('creates a procedure and exposes templates to administrators', async () => {
    const templates = await request(app).get('/api/procedures/templates')
      .set(auth(adminId, 'admin', 'route-admin')).expect(200);
    expect(templates.body).toHaveLength(3);

    const created = await request(app).post('/api/procedures')
      .set(auth(adminId, 'admin', 'route-admin'))
      .send({
        name: 'route-procedure', description: 'HTTP contract',
        steps: [{ action_type: 'wait_seconds', action_config: { seconds: 0 }, on_error: 'stop' }],
      }).expect(201);
    procedureId = created.body.id;
    expect(created.body.steps[0].action_type).toBe('wait_seconds');
  });

  it('allows an operator to run and inspect history', async () => {
    const started = await request(app).post(`/api/procedures/${procedureId}/run`)
      .set(auth(operatorId, 'operator', 'route-operator')).expect(202);
    runId = started.body.id;
    const finished = await procedures.waitForRun(runId);
    expect(finished.status).toBe('success');

    const history = await request(app).get(`/api/procedures/${procedureId}/runs`)
      .set(auth(operatorId, 'operator', 'route-operator')).expect(200);
    expect(history.body.runs[0].id).toBe(runId);
  });

  it('retains deleted history but limits it to the initiator and administrators', async () => {
    await request(app).delete(`/api/procedures/${procedureId}`)
      .set(auth(adminId, 'admin', 'route-admin')).expect(200);

    await request(app).get(`/api/procedures/runs/${runId}`)
      .set(auth(otherOperatorId, 'operator', 'route-other')).expect(403);
    await request(app).get(`/api/procedures/runs/${runId}`)
      .set(auth(operatorId, 'operator', 'route-operator')).expect(200);
    await request(app).get(`/api/procedures/runs/${runId}`)
      .set(auth(adminId, 'admin', 'route-admin')).expect(200);
  });
});
