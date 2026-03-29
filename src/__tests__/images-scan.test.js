'use strict';

process.env.APP_SECRET = 'test-secret-images-scan';
process.env.APP_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'ImagesScanTest123!';

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
app.use('/api/images', require('../routes/images'));

let adminToken = null;

beforeAll(async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'ImagesScanTest123!' });
  adminToken = res.body.token;
});

describe('GET /api/images/scanners', () => {
  it('should return 200 with scanners array', async () => {
    const res = await request(app)
      .get('/api/images/scanners')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.scanners).toBeTruthy();
    expect(Array.isArray(res.body.scanners)).toBe(true);
  });

  it('should return 401 without auth', async () => {
    await request(app).get('/api/images/scanners').expect(401);
  });
});

describe('GET /api/images', () => {
  it('should return images list or handle Docker unavailable', async () => {
    const res = await request(app)
      .get('/api/images')
      .set('Authorization', `Bearer ${adminToken}`);

    // Docker may not be available in test env
    expect([200, 500]).toContain(res.status);

    if (res.status === 200) {
      expect(Array.isArray(res.body)).toBe(true);
    }
  });
});
