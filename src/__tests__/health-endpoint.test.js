'use strict';

// Integration tests for the health endpoint.
// Verifies response shape, version matching, and timestamp format.

process.env.APP_SECRET = 'test-secret-for-health-tests';
process.env.APP_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'HealthTest123!';

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// Initialize DB (runs migrations)
const { getDb } = require('../db');
getDb();

// Register routes
app.use('/api', require('../routes/misc'));

// Read expected version from package.json
const expectedVersion = require('../../package.json').version;

describe('GET /api/health', () => {
  it('should return 200 with status ok', async () => {
    const res = await request(app).get('/api/health').expect(200);

    expect(res.body.status).toBe('ok');
    expect(res.body).toHaveProperty('version');
    expect(res.body).toHaveProperty('timestamp');
  });

  it('should return version matching package.json', async () => {
    const res = await request(app).get('/api/health').expect(200);

    expect(res.body.version).toBe(expectedVersion);
    expect(res.body.version).toBe('4.2.0');
  });

  it('should return a valid ISO timestamp', async () => {
    const res = await request(app).get('/api/health').expect(200);

    const timestamp = res.body.timestamp;
    expect(timestamp).toBeTruthy();

    // Validate it parses as a valid date
    const parsed = new Date(timestamp);
    expect(parsed.toString()).not.toBe('Invalid Date');

    // Validate ISO 8601 format
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    // Should be recent (within last 10 seconds)
    const diff = Math.abs(Date.now() - parsed.getTime());
    expect(diff).toBeLessThan(10000);
  });

  it('should not require authentication', async () => {
    // No auth header, should still work
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('should verify database connectivity', async () => {
    const res = await request(app).get('/api/health').expect(200);

    // The health endpoint runs SELECT 1 to verify DB.
    // If it succeeds, status is 'ok'. If DB is down, it would be 503.
    expect(res.body.status).toBe('ok');
  });

  it('should respond quickly (under 500ms)', async () => {
    const start = Date.now();
    await request(app).get('/api/health').expect(200);
    const duration = Date.now() - start;
    expect(duration).toBeLessThan(500);
  });
});
