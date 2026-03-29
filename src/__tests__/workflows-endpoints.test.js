'use strict';

process.env.APP_SECRET = 'test-secret-workflows';
process.env.APP_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'WorkflowsTest123!';

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

const { getDb } = require('../db');
getDb();

const authService = require('../services/auth');
authService.seedAdmin();

app.use('/api/auth', require('../routes/auth'));
app.use('/api/workflows', require('../routes/workflows'));

let adminToken = null;

beforeAll(async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'WorkflowsTest123!' });
  adminToken = res.body.token;
});

describe('GET /api/workflows', () => {
  it('should return 200 with workflow list', async () => {
    const res = await request(app)
      .get('/api/workflows')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
  });

  it('should return 401 without auth', async () => {
    await request(app).get('/api/workflows').expect(401);
  });
});

describe('GET /api/workflows/templates', () => {
  it('should return workflow templates', async () => {
    const res = await request(app)
      .get('/api/workflows/templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('POST /api/workflows', () => {
  it('should create a workflow rule', async () => {
    const res = await request(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Test CPU Rule',
        trigger_type: 'cpu_high',
        action_type: 'notify',
        target: '*',
        cooldown_seconds: 300,
        trigger_config: {},
        action_config: {},
      })
      .expect(201);

    expect(res.body.id).toBeTruthy();
  });
});

describe('PUT /api/workflows/:id', () => {
  it('should update a workflow', async () => {
    const createRes = await request(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Update Me',
        trigger_type: 'mem_high',
        action_type: 'notify',
        target: '*',
        cooldown_seconds: 600,
      });

    await request(app)
      .put(`/api/workflows/${createRes.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ is_active: false })
      .expect(200);
  });
});

describe('DELETE /api/workflows/:id', () => {
  it('should delete a workflow', async () => {
    const createRes = await request(app)
      .post('/api/workflows')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Delete Me',
        trigger_type: 'container_exit',
        action_type: 'restart',
        target: '*',
      });

    await request(app)
      .delete(`/api/workflows/${createRes.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });
});
