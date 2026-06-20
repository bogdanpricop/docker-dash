'use strict';

process.env.APP_SECRET = 'test-secret-alerts';
process.env.APP_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'AlertsTest123!';

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
app.use('/api/alerts', require('../routes/alerts'));

let adminToken = null;
let viewerToken = null;

beforeAll(async () => {
  require('./helpers/seedTestAdmin').clearMustChange('admin');
  // Login as admin
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'AlertsTest123!' });
  adminToken = res.body.token;

  // Create a viewer user
  await request(app)
    .post('/api/auth/users')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ username: 'viewer1', password: 'ViewerPass123!', role: 'viewer' });

  const viewerRes = await request(app)
    .post('/api/auth/login')
    .send({ username: 'viewer1', password: 'ViewerPass123!' });
  viewerToken = viewerRes.body.token;
});

describe('GET /api/alerts/rules', () => {
  it('should return 200 with an array', async () => {
    const res = await request(app)
      .get('/api/alerts/rules')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
  });

  it('should return 401 without auth', async () => {
    await request(app).get('/api/alerts/rules').expect(401);
  });
});

describe('POST /api/alerts/rules', () => {
  it('should create a rule when admin', async () => {
    const res = await request(app)
      .post('/api/alerts/rules')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Test CPU Alert',
        metric: 'cpu',
        operator: '>',
        threshold: 90,
        duration_seconds: 60,
        severity: 'warning',
        cooldown_seconds: 300,
        target: '*',
        is_active: 1,
      })
      .expect(201);

    expect(res.body.id).toBeTruthy();
  });

  it('should return 403 for viewer role', async () => {
    await request(app)
      .post('/api/alerts/rules')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ name: 'Blocked Rule', metric: 'cpu', operator: '>', threshold: 80, is_active: 1 })
      .expect(403);
  });
});

describe('PUT /api/alerts/rules/:id (v8.7.17 — column allowlist)', () => {
  let ruleId;
  beforeEach(async () => {
    const res = await request(app)
      .post('/api/alerts/rules')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Allowlist Test Rule',
        metric: 'cpu', operator: '>', threshold: 50,
        duration_seconds: 60, severity: 'warning',
        cooldown_seconds: 300, target: '*', is_active: 1,
      });
    ruleId = res.body.id;
  });

  it('updates allowed fields normally', async () => {
    await request(app)
      .put(`/api/alerts/rules/${ruleId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ threshold: 95, severity: 'critical' })
      .expect(200);
  });

  it('silently ignores non-allowlisted column names (no SQL injection via key)', async () => {
    // Attempt to inject a multi-column SET via a crafted key. Before
    // v8.7.17 this rendered to SQL as:
    //   SET name='pwn', is_active=0, target = ? WHERE id = ?
    // — bypassing the per-field intent. After v8.7.17 the key is not in
    // the ALLOWED list so it is silently dropped; the route still
    // succeeds because of the legitimate "threshold" update.
    const beforeRule = (await request(app)
      .get('/api/alerts/rules')
      .set('Authorization', `Bearer ${adminToken}`)
    ).body.find(r => r.id === ruleId);
    await request(app)
      .put(`/api/alerts/rules/${ruleId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        threshold: 75,
        "name='pwn', is_active=0, target": 'x',
      })
      .expect(200);
    const afterRule = (await request(app)
      .get('/api/alerts/rules')
      .set('Authorization', `Bearer ${adminToken}`)
    ).body.find(r => r.id === ruleId);
    expect(afterRule.threshold).toBe(75);
    expect(afterRule.name).toBe(beforeRule.name);          // unchanged
    expect(afterRule.is_active).toBe(beforeRule.is_active); // unchanged
    expect(afterRule.target).toBe(beforeRule.target);       // unchanged
  });

  it('rejects audit-trail tampering via created_by / created_at', async () => {
    const beforeRule = (await request(app)
      .get('/api/alerts/rules')
      .set('Authorization', `Bearer ${adminToken}`)
    ).body.find(r => r.id === ruleId);
    await request(app)
      .put(`/api/alerts/rules/${ruleId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ created_by: 9999, created_at: '1999-01-01T00:00:00Z', threshold: 80 })
      .expect(200);
    const afterRule = (await request(app)
      .get('/api/alerts/rules')
      .set('Authorization', `Bearer ${adminToken}`)
    ).body.find(r => r.id === ruleId);
    expect(afterRule.threshold).toBe(80);
    expect(afterRule.created_by).toBe(beforeRule.created_by);
    expect(afterRule.created_at).toBe(beforeRule.created_at);
  });
});

describe('DELETE /api/alerts/rules/:id', () => {
  it('should require admin role', async () => {
    // Create a rule first
    const createRes = await request(app)
      .post('/api/alerts/rules')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'To Delete', metric: 'cpu', operator: '>', threshold: 95, severity: 'critical', is_active: 1 });

    const ruleId = createRes.body.id;

    // Viewer cannot delete
    await request(app)
      .delete(`/api/alerts/rules/${ruleId}`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(403);

    // Admin can delete
    await request(app)
      .delete(`/api/alerts/rules/${ruleId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });
});

describe('GET /api/alerts/active', () => {
  it('should return 200 with an array', async () => {
    const res = await request(app)
      .get('/api/alerts/active')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('GET /api/alerts/history', () => {
  it('should return 200 with paginated results', async () => {
    const res = await request(app)
      .get('/api/alerts/history?page=1&limit=10')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body).toBeTruthy();
  });
});
