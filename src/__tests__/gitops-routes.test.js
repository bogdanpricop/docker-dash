'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-dash-gitops-routes-'));
process.env.APP_SECRET = 'gitops-routes-test-secret';
process.env.ENCRYPTION_KEY = 'gitops-routes-test-key-32-chars';
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
    ? next() : res.status(403).json({ error: 'Insufficient permissions' }),
  writeable: (_req, _res, next) => next(),
}));

const express = require('express');
const request = require('supertest');
const { getDb, closeDb } = require('../db');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api/gitops', require('../routes/gitops'));

let adminId;
let operatorId;
const auth = (id, role) => ({
  'x-test-user-id': String(id), 'x-test-role': role, 'x-test-username': `${role}-user`,
});

beforeAll(() => {
  adminId = Number(getDb().prepare(
    "INSERT INTO users (username, password_hash, role) VALUES ('gitops-route-admin', 'hash', 'admin')"
  ).run().lastInsertRowid);
  operatorId = Number(getDb().prepare(
    "INSERT INTO users (username, password_hash, role) VALUES ('gitops-route-operator', 'hash', 'operator')"
  ).run().lastInsertRowid);
});

afterAll(() => {
  closeDb();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

describe('GitOps HTTP API', () => {
  it('requires authentication and administrator role', async () => {
    await request(app).get('/api/gitops/export').expect(401);
    await request(app).get('/api/gitops/export').set(auth(operatorId, 'operator')).expect(403);
    await request(app).post('/api/gitops/plan').set(auth(operatorId, 'operator')).send({}).expect(403);
  });

  it('exports YAML, plans an unchanged document, and applies only its reviewed hash', async () => {
    const exported = await request(app).get('/api/gitops/export')
      .set(auth(adminId, 'admin')).expect(200);
    expect(exported.body.document.apiVersion).toBe('docker-dash.io/v1alpha1');
    expect(exported.body.yaml).toContain('kind: FleetConfiguration');

    const planned = await request(app).post('/api/gitops/plan')
      .set(auth(adminId, 'admin'))
      .send({ document: exported.body.yaml }).expect(200);
    expect(planned.body.summary.unchanged).toBeGreaterThan(0);
    expect(planned.body.planHash).toMatch(/^[a-f0-9]{64}$/);

    const missingHash = await request(app).post('/api/gitops/apply')
      .set(auth(adminId, 'admin'))
      .send({ document: exported.body.yaml }).expect(400);
    expect(missingHash.body.error).toMatch(/planHash/);

    const applied = await request(app).post('/api/gitops/apply')
      .set(auth(adminId, 'admin'))
      .send({ document: exported.body.yaml, planHash: planned.body.planHash }).expect(200);
    expect(applied.body).toMatchObject({ ok: true, results: [] });
    const actions = getDb().prepare("SELECT action FROM audit_log WHERE action LIKE 'gitops_%' ORDER BY id").all()
      .map(row => row.action);
    expect(actions).toEqual(['gitops_export', 'gitops_plan', 'gitops_apply']);
  });
});
