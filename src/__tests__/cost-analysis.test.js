'use strict';

// Integration tests for cost analysis, cost settings, and recommendations endpoints.
// These test the /api/stats/cost-analysis, /api/stats/cost-settings, and
// /api/stats/recommendations routes.

process.env.APP_SECRET = 'test-secret-for-cost-tests';
process.env.APP_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'CostTest123!';

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// Initialize DB (runs migrations)
const { getDb } = require('../db');
getDb();

// Seed admin
const authService = require('../services/auth');
authService.seedAdmin();

// Register routes
app.use('/api/auth', require('../routes/auth'));
app.use('/api/stats', require('../routes/stats'));

let adminToken = null;

beforeAll(async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'CostTest123!' });
  adminToken = res.body.token;
});

describe('GET /api/stats/cost-analysis', () => {
  it('should return cost breakdown structure with default fallback', async () => {
    const res = await request(app)
      .get('/api/stats/cost-analysis')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // Should have the expected shape even with no containers
    expect(res.body).toHaveProperty('monthly_total');
    expect(res.body).toHaveProperty('containers');
    expect(res.body).toHaveProperty('recommendations');
    expect(res.body).toHaveProperty('savings_potential');
    expect(res.body).toHaveProperty('idle_count');
    expect(res.body).toHaveProperty('idle_cost');
    expect(res.body).toHaveProperty('unallocated');

    // Default monthly cost is $50 when no setting exists
    expect(res.body.monthly_total).toBe(50);
    expect(Array.isArray(res.body.containers)).toBe(true);
    expect(Array.isArray(res.body.recommendations)).toBe(true);
    expect(typeof res.body.savings_potential).toBe('number');
  });

  it('should accept monthly_cost as query parameter', async () => {
    const res = await request(app)
      .get('/api/stats/cost-analysis?monthly_cost=100')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.monthly_total).toBe(100);
  });

  it('should return 401 without auth', async () => {
    await request(app).get('/api/stats/cost-analysis').expect(401);
  });
});

describe('POST /api/stats/cost-settings', () => {
  it('should save monthly cost setting', async () => {
    const res = await request(app)
      .post('/api/stats/cost-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monthly_cost: 75 })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.monthly_cost).toBe(75);
  });

  it('should persist and be used by cost-analysis', async () => {
    const res = await request(app)
      .get('/api/stats/cost-analysis')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // Should use the saved setting (75) instead of default (50)
    expect(res.body.monthly_total).toBe(75);
  });

  it('should return 400 for missing monthly_cost', async () => {
    const res = await request(app)
      .post('/api/stats/cost-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(400);

    expect(res.body.error).toBeTruthy();
  });

  it('should return 400 for NaN monthly_cost', async () => {
    const res = await request(app)
      .post('/api/stats/cost-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monthly_cost: 'not-a-number' })
      .expect(400);

    expect(res.body.error).toBeTruthy();
  });

  it('should accept zero as valid cost', async () => {
    const res = await request(app)
      .post('/api/stats/cost-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ monthly_cost: 0 })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.monthly_cost).toBe(0);
  });

  it('should return 401 without auth', async () => {
    await request(app)
      .post('/api/stats/cost-settings')
      .send({ monthly_cost: 50 })
      .expect(401);
  });
});

describe('GET /api/stats/recommendations', () => {
  it('should return recommendations array with expected shape', async () => {
    const res = await request(app)
      .get('/api/stats/recommendations')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body).toHaveProperty('recommendations');
    expect(res.body).toHaveProperty('analyzed');
    expect(res.body).toHaveProperty('period');
    expect(Array.isArray(res.body.recommendations)).toBe(true);
    expect(typeof res.body.analyzed).toBe('number');
    expect(res.body.period).toBe('24h');
  });

  it('should return empty recommendations when no stats data', async () => {
    const res = await request(app)
      .get('/api/stats/recommendations')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // No container stats in test DB, so no recommendations
    expect(res.body.recommendations.length).toBe(0);
    expect(res.body.analyzed).toBe(0);
  });

  it('should return 401 without auth', async () => {
    await request(app).get('/api/stats/recommendations').expect(401);
  });
});
