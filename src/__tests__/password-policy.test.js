'use strict';

// Test unified password policy enforcement across ALL password-related flows.
// Ensures consistent security: create user, change password, reset password, token reset.

process.env.APP_SECRET = 'test-secret-pw-policy';
process.env.APP_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'PwPolicy123!';

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

const { getDb } = require('../db');
const db = getDb();

const authService = require('../services/auth');
const { generateToken, sha256 } = require('../utils/crypto');

authService.seedAdmin();

app.use('/api/auth', require('../routes/auth'));

let adminToken = null;
let testUserId = null;

beforeAll(async () => {
  // Login as admin
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'PwPolicy123!' });
  adminToken = res.body.token;

  // Create a test user for password operations
  const createRes = await request(app)
    .post('/api/auth/users')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ username: 'pwtest', password: 'PwTestUser1!', role: 'viewer', email: 'pw@test.com' });
  testUserId = createRes.body.id;
});

describe('validatePassword service-level checks', () => {
  it('should reject passwords shorter than 8 chars', () => {
    expect(authService.validatePassword('Short1')).toMatch(/8 characters/);
  });

  it('should reject passwords without digits', () => {
    expect(authService.validatePassword('NoDigitsHere!')).toMatch(/number/);
  });

  it('should reject common passwords', () => {
    expect(authService.validatePassword('admin')).toBeTruthy();
    expect(authService.validatePassword('password')).toBeTruthy();
    expect(authService.validatePassword('12345678')).toBeTruthy();
  });

  it('should accept valid passwords', () => {
    expect(authService.validatePassword('SecureP4ss!')).toBeNull();
    expect(authService.validatePassword('MyStr0ngPwd')).toBeNull();
  });
});

describe('POST /api/auth/users — create user password policy', () => {
  it('should reject weak password (too short)', async () => {
    const res = await request(app)
      .post('/api/auth/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: 'weakuser1', password: 'Sh0rt', role: 'viewer' })
      .expect(400);
    expect(res.body.error).toMatch(/8 characters/);
  });

  it('should reject password without digit', async () => {
    const res = await request(app)
      .post('/api/auth/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: 'weakuser2', password: 'NoDigitsHere!', role: 'viewer' })
      .expect(400);
    expect(res.body.error).toMatch(/number/);
  });

  it('should reject common password', async () => {
    const res = await request(app)
      .post('/api/auth/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: 'weakuser3', password: 'password', role: 'viewer' })
      .expect(400);
    expect(res.body.error).toBeTruthy();
  });

  it('should accept valid password on create', async () => {
    const res = await request(app)
      .post('/api/auth/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: 'stronguser', password: 'SecureP4ss!', role: 'viewer' })
      .expect(201);
    expect(res.body.id).toBeTruthy();
  });
});

describe('POST /api/auth/change-password — password policy', () => {
  let userToken = null;

  beforeAll(async () => {
    // Login as the test user
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'pwtest', password: 'PwTestUser1!' });
    userToken = res.body.token;
  });

  it('should reject weak new password (too short)', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ currentPassword: 'PwTestUser1!', newPassword: 'Sh0rt' })
      .expect(400);
    expect(res.body.error).toMatch(/8 characters/);
  });

  it('should reject new password without digit', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ currentPassword: 'PwTestUser1!', newPassword: 'NoDigitsAtAll!' })
      .expect(400);
    expect(res.body.error).toMatch(/number/);
  });

  it('should accept valid new password', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ currentPassword: 'PwTestUser1!', newPassword: 'SecureP4ss!' })
      .expect(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('POST /api/auth/users/:id/reset-password — password policy', () => {
  it('should reject weak password on admin reset', async () => {
    const res = await request(app)
      .post(`/api/auth/users/${testUserId}/reset-password`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ password: 'weak' })
      .expect(400);
    expect(res.body.error).toMatch(/8 characters/);
  });

  it('should reject password without digit on admin reset', async () => {
    const res = await request(app)
      .post(`/api/auth/users/${testUserId}/reset-password`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ password: 'NoDigitsHere!' })
      .expect(400);
    expect(res.body.error).toMatch(/number/);
  });

  it('should accept valid password on admin reset', async () => {
    const res = await request(app)
      .post(`/api/auth/users/${testUserId}/reset-password`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ password: 'SecureP4ss!' })
      .expect(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('POST /api/auth/reset-password-token — password policy', () => {
  let resetToken = null;

  beforeAll(() => {
    // Manually create a valid reset token in the DB for testUserId
    resetToken = generateToken(32);
    const tokenHash = sha256(resetToken);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO password_reset_tokens (user_id, token_hash, type, expires_at) VALUES (?, ?, ?, ?)')
      .run(testUserId, tokenHash, 'reset', expiresAt);
  });

  it('should reject weak password on token reset', async () => {
    const res = await request(app)
      .post('/api/auth/reset-password-token')
      .send({ token: resetToken, newPassword: 'weak' })
      .expect(400);
    expect(res.body.error).toMatch(/8 characters/);
  });

  it('should reject password without digit on token reset', async () => {
    const res = await request(app)
      .post('/api/auth/reset-password-token')
      .send({ token: resetToken, newPassword: 'NoDigitsHere!' })
      .expect(400);
    expect(res.body.error).toMatch(/number/);
  });

  it('should accept valid password on token reset', async () => {
    const res = await request(app)
      .post('/api/auth/reset-password-token')
      .send({ token: resetToken, newPassword: 'SecureP4ss!' })
      .expect(200);
    expect(res.body.ok).toBe(true);
  });

  it('should reject reused (already consumed) token', async () => {
    const res = await request(app)
      .post('/api/auth/reset-password-token')
      .send({ token: resetToken, newPassword: 'AnotherP4ss!' })
      .expect(400);
    expect(res.body.error).toMatch(/invalid|expired/i);
  });
});
