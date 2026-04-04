'use strict';

// 📚 WHY: Integration tests catch bugs that unit tests miss — routing errors,
// middleware ordering, auth bypass, response shape mismatches.
// We test the REAL Express app with supertest (no mocks).

process.env.APP_SECRET = 'test-secret-for-integration-tests';
process.env.APP_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'IntegrationTest123!';

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');

// Build a minimal test app with the routes we want to test
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// Initialize DB (runs migrations)
const { getDb } = require('../db');
getDb();

// Seed admin
const authService = require('../services/auth');
authService.seedAdmin();

// Register routes we want to test
app.use('/api/auth', require('../routes/auth'));
try { app.use('/api/status-page', require('../routes/statusPage')); } catch {}
app.use('/api', require('../routes/misc'));

let authToken = null;

// Login before tests
beforeAll(async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'IntegrationTest123!' });
  authToken = res.body.token;
});

describe('GET /api/health', () => {
  // 📚 HAPPY PATH: health check should always work, no auth
  it('should return 200 with status ok', async () => {
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.timestamp).toBeTruthy();
  });
});

describe('POST /api/auth/login', () => {
  // 📚 HAPPY PATH: valid credentials
  it('should return token and user on valid login', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'IntegrationTest123!' })
      .expect(200);

    expect(res.body.token).toBeTruthy();
    expect(res.body.user).toBeTruthy();
    expect(res.body.user.username).toBe('admin');
    expect(res.body.user.role).toBe('admin');
  });

  // 📚 SECURITY: wrong password returns error
  it('should return error on wrong password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'WrongPassword' })
      .expect(401);

    expect(res.body.error).toBeTruthy();
    expect(res.body.token).toBeUndefined();
  });

  // 📚 SECURITY: missing credentials returns error (401 not 200)
  it('should reject empty credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({});

    expect([400, 401]).toContain(res.status);
    expect(res.body.token).toBeUndefined();
  });
});

describe('GET /api/auth/me', () => {
  // 📚 HAPPY PATH: authenticated user info
  it('should return user when authenticated', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200);

    expect(res.body.user.username).toBe('admin');
  });

  // 📚 SECURITY: no auth returns 401
  it('should return 401 without auth', async () => {
    await request(app).get('/api/auth/me').expect(401);
  });

  // 📚 SECURITY: invalid token returns 401
  it('should return 401 with invalid token', async () => {
    await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer invalid-token-here')
      .expect(401);
  });
});

describe('GET /api/health (semantic)', () => {
  // 📚 RELIABILITY: health check verifies DB connection
  it('should verify database is accessible', async () => {
    const res = await request(app).get('/api/health').expect(200);
    // If DB was down, this would return 503
    expect(res.body.status).toBe('ok');
  });
});

describe('GET /api/compare', () => {
  // 📚 PUBLIC: comparison matrix needs no auth
  it('should return feature comparison without auth', async () => {
    const res = await request(app).get('/api/compare').expect(200);

    expect(res.body.features).toBeTruthy();
    expect(Array.isArray(res.body.features)).toBe(true);
    expect(res.body.features.length).toBeGreaterThan(50); // 60 features across 8 tools
    expect(res.body.summary).toBeTruthy();
    expect(res.body.summary.dockerDash.exclusive).toBeGreaterThan(10); // ~19 exclusive vs 8 tools
  });

  // 📚 STRUCTURE: each feature has the right shape
  it('should have correct feature shape', async () => {
    const res = await request(app).get('/api/compare').expect(200);
    const feature = res.body.features[0];
    expect(feature).toHaveProperty('feature');
    expect(feature).toHaveProperty('dockerDash');
    expect(feature).toHaveProperty('portainerCE');
    expect(feature).toHaveProperty('dockge');
    expect(feature).toHaveProperty('dockhand');
  });
});

describe('GET /api/footprint', () => {
  // 📚 SECURITY: requires auth
  it('should return 401 without auth', async () => {
    await request(app).get('/api/footprint').expect(401);
  });

  // 📚 HAPPY PATH: returns process info
  it('should return footprint when authenticated', async () => {
    const res = await request(app)
      .get('/api/footprint')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200);

    expect(res.body.memory).toBeTruthy();
    expect(res.body.memory.rss).toBeGreaterThan(0);
    expect(res.body.uptime).toBeGreaterThanOrEqual(0);
    expect(res.body.nodeVersion).toBeTruthy();
  });
});

describe('GET /api/settings', () => {
  // 📚 SECURITY: admin only
  it('should return settings for admin', async () => {
    const res = await request(app)
      .get('/api/settings')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200);

    expect(typeof res.body).toBe('object');
  });
});

describe('GET /api/search', () => {
  // 📚 VALIDATION: requires minimum query length
  it('should return empty for short query', async () => {
    const res = await request(app)
      .get('/api/search?q=a')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200);

    expect(res.body.results).toEqual([]);
  });

  // 📚 SECURITY: requires auth
  it('should return 401 without auth', async () => {
    await request(app).get('/api/search?q=test').expect(401);
  });
});

describe('GET /api/metrics', () => {
  // 📚 PUBLIC: Prometheus metrics accessible without auth
  it('should return Prometheus-format metrics', async () => {
    const res = await request(app).get('/api/metrics').expect(200);

    expect(res.text).toContain('docker_dash_');
    expect(res.headers['content-type']).toContain('text/plain');
  });
});

describe('GET /api/status-page/public', () => {
  // 📚 PUBLIC: status page disabled by default
  it('should return 404 when status page is disabled', async () => {
    // Status page is disabled by default
    await request(app).get('/api/status-page/public').expect(404);
  });
});
