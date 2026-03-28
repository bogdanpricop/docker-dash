'use strict';

// Test role-based access control across endpoints.
// Verifies that viewer/operator/admin roles are enforced correctly.

process.env.APP_SECRET = 'test-secret-rbac';
process.env.APP_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'RbacTest123!';

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

// Register routes needed for RBAC tests
app.use('/api/auth', require('../routes/auth'));
app.use('/api/groups', require('../routes/groups'));
// Containers route requires Docker — we only test auth middleware blocking,
// so we register it but expect Docker errors (not auth errors) for allowed roles.
try { app.use('/api/containers', require('../routes/containers')); } catch {}

let adminToken = null;
let operatorToken = null;
let viewerToken = null;
let adminId = null;
let operatorId = null;
let viewerId = null;

beforeAll(async () => {
  // Login as admin
  const adminRes = await request(app)
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'RbacTest123!' });
  adminToken = adminRes.body.token;
  adminId = adminRes.body.user.id;

  // Create operator user
  await request(app)
    .post('/api/auth/users')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ username: 'operator1', password: 'Operator1Pass!', role: 'operator' });

  // Create viewer user
  await request(app)
    .post('/api/auth/users')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ username: 'viewer1', password: 'Viewer1Pass!!', role: 'viewer' });

  // Login as operator
  const opRes = await request(app)
    .post('/api/auth/login')
    .send({ username: 'operator1', password: 'Operator1Pass!' });
  operatorToken = opRes.body.token;
  operatorId = opRes.body.user.id;

  // Login as viewer
  const viewRes = await request(app)
    .post('/api/auth/login')
    .send({ username: 'viewer1', password: 'Viewer1Pass!!' });
  viewerToken = viewRes.body.token;
  viewerId = viewRes.body.user.id;
});

describe('Unauthenticated requests', () => {
  it('should return 401 for POST /api/auth/users without auth', async () => {
    await request(app)
      .post('/api/auth/users')
      .send({ username: 'hacker', password: 'HackPass1!', role: 'admin' })
      .expect(401);
  });

  it('should return 401 for DELETE /api/auth/users/:id without auth', async () => {
    await request(app)
      .delete('/api/auth/users/1')
      .expect(401);
  });

  it('should return 401 for GET /api/auth/users without auth', async () => {
    await request(app)
      .get('/api/auth/users')
      .expect(401);
  });

  it('should return 401 for POST /api/groups without auth', async () => {
    await request(app)
      .post('/api/groups')
      .send({ name: 'test' })
      .expect(401);
  });
});

describe('Viewer cannot access admin endpoints', () => {
  it('should return 403 for POST /api/auth/users (create user)', async () => {
    const res = await request(app)
      .post('/api/auth/users')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ username: 'newuser', password: 'NewUser123!', role: 'viewer' })
      .expect(403);
    expect(res.body.error).toMatch(/permission/i);
  });

  it('should return 403 for DELETE /api/auth/users/:id', async () => {
    const res = await request(app)
      .delete(`/api/auth/users/${operatorId}`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(403);
    expect(res.body.error).toMatch(/permission/i);
  });

  it('should return 403 for GET /api/auth/users (list users)', async () => {
    await request(app)
      .get('/api/auth/users')
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(403);
  });

  it('should return 403 for PUT /api/auth/users/:id', async () => {
    await request(app)
      .put(`/api/auth/users/${operatorId}`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ displayName: 'Hacked' })
      .expect(403);
  });

  it('should return 403 for POST /api/auth/users/:id/reset-password', async () => {
    await request(app)
      .post(`/api/auth/users/${operatorId}/reset-password`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ password: 'NewPass123!' })
      .expect(403);
  });
});

describe('Operator cannot access admin-only endpoints', () => {
  it('should return 403 for POST /api/auth/users (create user)', async () => {
    const res = await request(app)
      .post('/api/auth/users')
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ username: 'newuser2', password: 'NewUser123!', role: 'viewer' })
      .expect(403);
    expect(res.body.error).toMatch(/permission/i);
  });

  it('should return 403 for DELETE /api/auth/users/:id', async () => {
    await request(app)
      .delete(`/api/auth/users/${viewerId}`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(403);
  });
});

describe('Admin can do everything', () => {
  it('should allow GET /api/auth/users', async () => {
    const res = await request(app)
      .get('/api/auth/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(3);
  });

  it('should allow POST /api/auth/users (create user)', async () => {
    const res = await request(app)
      .post('/api/auth/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: 'admin_created', password: 'AdminNew123!', role: 'viewer' })
      .expect(201);
    expect(res.body.id).toBeTruthy();
  });

  it('should allow PUT /api/auth/users/:id', async () => {
    await request(app)
      .put(`/api/auth/users/${viewerId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ displayName: 'Updated Viewer' })
      .expect(200);
  });

  it('should allow POST /api/auth/users/:id/reset-password', async () => {
    // Use a throwaway user to avoid invalidating operatorToken (reset-password kills sessions)
    const tmpRes = await request(app)
      .post('/api/auth/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: 'reset_target', password: 'ResetTarget1!', role: 'viewer' });
    const tmpId = tmpRes.body.id;

    await request(app)
      .post(`/api/auth/users/${tmpId}/reset-password`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ password: 'ResetPass123!' })
      .expect(200);
  });

  it('should allow DELETE /api/auth/users/:id (not self)', async () => {
    // Create a throwaway user to delete
    const createRes = await request(app)
      .post('/api/auth/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: 'to_delete', password: 'ToDelete123!', role: 'viewer' });
    const deleteId = createRes.body.id;

    await request(app)
      .delete(`/api/auth/users/${deleteId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });

  it('should NOT allow admin to delete themselves', async () => {
    const res = await request(app)
      .delete(`/api/auth/users/${adminId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
    expect(res.body.error).toMatch(/yourself/i);
  });
});

describe('requireRole middleware combinations', () => {
  // Groups use requireRole('admin', 'operator') for POST, and requireRole('admin') for DELETE
  it('viewer cannot POST /api/groups (admin+operator only)', async () => {
    await request(app)
      .post('/api/groups')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ name: 'test-group' })
      .expect(403);
  });

  it('operator CAN POST /api/groups', async () => {
    const res = await request(app)
      .post('/api/groups')
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ name: 'operator-group' })
      .expect(201);
    expect(res.body.id).toBeTruthy();
  });

  it('admin CAN POST /api/groups', async () => {
    const res = await request(app)
      .post('/api/groups')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'admin-group' })
      .expect(201);
    expect(res.body.id).toBeTruthy();
  });

  it('viewer CAN GET /api/groups (read is allowed for all)', async () => {
    const res = await request(app)
      .get('/api/groups')
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
