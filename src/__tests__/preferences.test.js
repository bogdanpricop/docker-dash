'use strict';

// Integration tests for user preferences endpoints.
// Uses supertest against the real Express app with in-memory DB.

process.env.APP_SECRET = 'test-secret-for-preferences';
process.env.APP_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'PrefsTest123!';

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
app.use('/api', require('../routes/misc'));

let authToken = null;

beforeAll(async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'PrefsTest123!' });
  authToken = res.body.token;
});

describe('GET /api/preferences', () => {
  it('should return empty object for new user', async () => {
    const res = await request(app)
      .get('/api/preferences')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200);

    expect(res.body).toEqual({});
  });

  it('should return 401 without auth', async () => {
    await request(app).get('/api/preferences').expect(401);
  });
});

describe('PUT /api/preferences', () => {
  it('should save a preference', async () => {
    const res = await request(app)
      .put('/api/preferences')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ key: 'theme', value: 'light' })
      .expect(200);

    expect(res.body.ok).toBe(true);
  });

  it('should return saved preference on GET', async () => {
    const res = await request(app)
      .get('/api/preferences')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200);

    expect(res.body.theme).toBe('light');
  });

  it('should overwrite existing key', async () => {
    await request(app)
      .put('/api/preferences')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ key: 'theme', value: 'dark' })
      .expect(200);

    const res = await request(app)
      .get('/api/preferences')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200);

    expect(res.body.theme).toBe('dark');
  });

  it('should store multiple keys independently', async () => {
    await request(app)
      .put('/api/preferences')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ key: 'language', value: 'en' })
      .expect(200);

    await request(app)
      .put('/api/preferences')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ key: 'timezone', value: 'UTC' })
      .expect(200);

    const res = await request(app)
      .get('/api/preferences')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200);

    expect(res.body.language).toBe('en');
    expect(res.body.timezone).toBe('UTC');
    expect(res.body.theme).toBe('dark'); // Previously set key still present
  });

  it('should reject missing key', async () => {
    await request(app)
      .put('/api/preferences')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ value: 'test' })
      .expect(400);
  });

  it('should require authentication', async () => {
    await request(app)
      .put('/api/preferences')
      .send({ key: 'theme', value: 'dark' })
      .expect(401);
  });
});
