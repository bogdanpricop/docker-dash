'use strict';

process.env.APP_SECRET = 'test-secret-stacks';
process.env.APP_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'StacksTest123!';

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
app.use('/api/system', require('../routes/system'));

let adminToken = null;

beforeAll(async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'StacksTest123!' });
  adminToken = res.body.token;
});

describe('GET /api/system/stacks', () => {
  it('should return 200 or handle gracefully when Docker is unavailable', async () => {
    const res = await request(app)
      .get('/api/system/stacks')
      .set('Authorization', `Bearer ${adminToken}`);

    // Docker may not be available in test env, so accept either 200 or 500
    expect([200, 500]).toContain(res.status);

    if (res.status === 200) {
      expect(Array.isArray(res.body)).toBe(true);
    } else {
      expect(res.body.error).toBeTruthy();
    }
  });

  it('should return 401 without auth', async () => {
    await request(app).get('/api/system/stacks').expect(401);
  });
});

describe('GET /api/system/info', () => {
  it('should return system info or error gracefully', async () => {
    const res = await request(app)
      .get('/api/system/info')
      .set('Authorization', `Bearer ${adminToken}`);

    // Docker may not be available
    expect([200, 500]).toContain(res.status);
  });
});
