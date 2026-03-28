'use strict';

// Test groups route authorization — RBAC enforcement for all /api/groups endpoints.

process.env.APP_SECRET = 'test-secret-groups-rbac';
process.env.APP_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'GroupsRbac1!';

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
app.use('/api/groups', require('../routes/groups'));

let adminToken = null;
let operatorToken = null;
let viewerToken = null;
let testGroupId = null;

beforeAll(async () => {
  // Login as admin
  const adminRes = await request(app)
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'GroupsRbac1!' });
  adminToken = adminRes.body.token;

  // Create operator
  await request(app)
    .post('/api/auth/users')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ username: 'grp_operator', password: 'GrpOper123!', role: 'operator' });

  // Create viewer
  await request(app)
    .post('/api/auth/users')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ username: 'grp_viewer', password: 'GrpView123!', role: 'viewer' });

  // Login as operator
  const opRes = await request(app)
    .post('/api/auth/login')
    .send({ username: 'grp_operator', password: 'GrpOper123!' });
  operatorToken = opRes.body.token;

  // Login as viewer
  const viewRes = await request(app)
    .post('/api/auth/login')
    .send({ username: 'grp_viewer', password: 'GrpView123!' });
  viewerToken = viewRes.body.token;

  // Create a test group as admin for update/delete tests
  const groupRes = await request(app)
    .post('/api/groups')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: 'test-group-rbac', color: '#ff0000' });
  testGroupId = groupRes.body.id;
});

describe('GET /api/groups — all authenticated roles', () => {
  it('should work for admin', async () => {
    const res = await request(app)
      .get('/api/groups')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('should work for operator', async () => {
    const res = await request(app)
      .get('/api/groups')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('should work for viewer', async () => {
    const res = await request(app)
      .get('/api/groups')
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('should return 401 without auth', async () => {
    await request(app)
      .get('/api/groups')
      .expect(401);
  });
});

describe('POST /api/groups — admin or operator only', () => {
  it('should allow admin to create group', async () => {
    const res = await request(app)
      .post('/api/groups')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'admin-created-group' })
      .expect(201);
    expect(res.body.id).toBeTruthy();
  });

  it('should allow operator to create group', async () => {
    const res = await request(app)
      .post('/api/groups')
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ name: 'operator-created-group' })
      .expect(201);
    expect(res.body.id).toBeTruthy();
  });

  it('should return 403 for viewer', async () => {
    const res = await request(app)
      .post('/api/groups')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ name: 'viewer-attempt' })
      .expect(403);
    expect(res.body.error).toMatch(/permission/i);
  });

  it('should return 401 without auth', async () => {
    await request(app)
      .post('/api/groups')
      .send({ name: 'unauth-attempt' })
      .expect(401);
  });
});

describe('PUT /api/groups/:id — admin or operator only', () => {
  it('should allow admin to update group', async () => {
    await request(app)
      .put(`/api/groups/${testGroupId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'updated-by-admin' })
      .expect(200);
  });

  it('should allow operator to update group', async () => {
    await request(app)
      .put(`/api/groups/${testGroupId}`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ name: 'updated-by-operator' })
      .expect(200);
  });

  it('should return 403 for viewer', async () => {
    const res = await request(app)
      .put(`/api/groups/${testGroupId}`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ name: 'viewer-update-attempt' })
      .expect(403);
    expect(res.body.error).toMatch(/permission/i);
  });
});

describe('DELETE /api/groups/:id — admin only', () => {
  let groupToDelete = null;

  beforeAll(async () => {
    // Create a group specifically for the delete test
    const res = await request(app)
      .post('/api/groups')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'to-be-deleted' });
    groupToDelete = res.body.id;
  });

  it('should return 403 for viewer', async () => {
    const res = await request(app)
      .delete(`/api/groups/${groupToDelete}`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(403);
    expect(res.body.error).toMatch(/permission/i);
  });

  it('should return 403 for operator', async () => {
    const res = await request(app)
      .delete(`/api/groups/${groupToDelete}`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(403);
    expect(res.body.error).toMatch(/permission/i);
  });

  it('should allow admin to delete group', async () => {
    await request(app)
      .delete(`/api/groups/${groupToDelete}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });
});

describe('POST /api/groups/:id/containers — admin or operator only', () => {
  it('should allow admin to add containers', async () => {
    const res = await request(app)
      .post(`/api/groups/${testGroupId}/containers`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ containerIds: ['abc123'] });
    // 200 means it got past auth (may fail on actual container logic, but auth passed)
    expect([200]).toContain(res.status);
  });

  it('should allow operator to add containers', async () => {
    const res = await request(app)
      .post(`/api/groups/${testGroupId}/containers`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ containerIds: ['def456'] });
    expect([200]).toContain(res.status);
  });

  it('should return 403 for viewer', async () => {
    const res = await request(app)
      .post(`/api/groups/${testGroupId}/containers`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ containerIds: ['ghi789'] })
      .expect(403);
    expect(res.body.error).toMatch(/permission/i);
  });
});

describe('GET /api/groups/:id — all authenticated roles', () => {
  it('should work for admin', async () => {
    const res = await request(app)
      .get(`/api/groups/${testGroupId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.id).toBe(testGroupId);
  });

  it('should work for operator', async () => {
    const res = await request(app)
      .get(`/api/groups/${testGroupId}`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);
    expect(res.body.id).toBe(testGroupId);
  });

  it('should work for viewer', async () => {
    const res = await request(app)
      .get(`/api/groups/${testGroupId}`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(200);
    expect(res.body.id).toBe(testGroupId);
  });

  it('should return 404 for nonexistent group', async () => {
    await request(app)
      .get('/api/groups/99999')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });
});
