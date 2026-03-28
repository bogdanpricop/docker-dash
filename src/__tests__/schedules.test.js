'use strict';

// Integration tests for scheduled actions CRUD endpoints.
// Tests create, list, update, delete, toggle, history, and cron validation.

process.env.APP_SECRET = 'test-secret-for-schedules-tests';
process.env.APP_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'ScheduleTest123!';

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
app.use('/api/system', require('../routes/system'));

let adminToken = null;
let createdScheduleId = null;

beforeAll(async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'ScheduleTest123!' });
  adminToken = res.body.token;
});

describe('GET /api/system/schedules', () => {
  it('should return empty list initially', async () => {
    const res = await request(app)
      .get('/api/system/schedules')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(0);
  });

  it('should return 401 without auth', async () => {
    await request(app).get('/api/system/schedules').expect(401);
  });
});

describe('POST /api/system/schedules — create schedule', () => {
  it('should create a schedule', async () => {
    const res = await request(app)
      .post('/api/system/schedules')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        containerId: 'abc123',
        containerName: 'test-container',
        action: 'restart',
        cron: '0 3 * * *',
        description: 'Nightly restart',
      })
      .expect(201);

    expect(res.body.id).toBeTruthy();
    expect(res.body.containerId).toBe('abc123');
    expect(res.body.action).toBe('restart');
    expect(res.body.cron).toBe('0 3 * * *');
    expect(res.body.enabled).toBe(true);
    createdScheduleId = res.body.id;
  });

  // Validation: missing required fields
  it('should return 400 when missing containerId', async () => {
    const res = await request(app)
      .post('/api/system/schedules')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action: 'restart', cron: '0 3 * * *' })
      .expect(400);

    expect(res.body.error).toBeTruthy();
  });

  it('should return 400 when missing action', async () => {
    await request(app)
      .post('/api/system/schedules')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ containerId: 'abc', cron: '0 3 * * *' })
      .expect(400);
  });

  it('should return 400 when missing cron', async () => {
    await request(app)
      .post('/api/system/schedules')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ containerId: 'abc', action: 'restart' })
      .expect(400);
  });
});

describe('GET /api/system/schedules — list after create', () => {
  it('should return the created schedule', async () => {
    const res = await request(app)
      .get('/api/system/schedules')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.length).toBe(1);
    expect(res.body[0].id).toBe(createdScheduleId);
    expect(res.body[0].containerName).toBe('test-container');
    expect(res.body[0].action).toBe('restart');
    expect(res.body[0].enabled).toBe(true);
  });
});

describe('PUT /api/system/schedules/:id — update schedule', () => {
  it('should update schedule cron and action', async () => {
    const res = await request(app)
      .put(`/api/system/schedules/${createdScheduleId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ cron: '30 4 * * *', action: 'stop' })
      .expect(200);

    expect(res.body.cron).toBe('30 4 * * *');
    expect(res.body.action).toBe('stop');
  });

  it('should toggle enabled/disabled', async () => {
    const res = await request(app)
      .put(`/api/system/schedules/${createdScheduleId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: false })
      .expect(200);

    expect(res.body.enabled).toBe(false);
  });

  it('should re-enable', async () => {
    const res = await request(app)
      .put(`/api/system/schedules/${createdScheduleId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: true })
      .expect(200);

    expect(res.body.enabled).toBe(true);
  });

  it('should return 404 for nonexistent schedule', async () => {
    await request(app)
      .put('/api/system/schedules/nonexistent-id')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: false })
      .expect(404);
  });
});

describe('GET /api/system/schedules/preview — cron preview', () => {
  it('should return next runs for valid cron', async () => {
    const res = await request(app)
      .get('/api/system/schedules/preview?cron=0 3 * * *')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.cron).toBe('0 3 * * *');
    expect(Array.isArray(res.body.nextRuns)).toBe(true);
    expect(res.body.nextRuns.length).toBeGreaterThan(0);
    expect(res.body.nextRuns.length).toBeLessThanOrEqual(5);
  });

  it('should return 400 for missing cron param', async () => {
    await request(app)
      .get('/api/system/schedules/preview')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('should return 400 for invalid cron (too few parts)', async () => {
    await request(app)
      .get('/api/system/schedules/preview?cron=0 3')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });
});

describe('GET /api/system/schedules/:id/history — schedule history', () => {
  it('should return empty history for new schedule', async () => {
    const res = await request(app)
      .get(`/api/system/schedules/${createdScheduleId}/history`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(0);
  });
});

describe('POST /api/system/schedules/:id/run-now — manual trigger', () => {
  // This will fail because Docker is not running in test env,
  // but we can verify it finds the schedule and attempts execution
  it('should return 404 for nonexistent schedule', async () => {
    await request(app)
      .post('/api/system/schedules/nonexistent-id/run-now')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });

  it('should attempt to run and return 500 (no Docker in test)', async () => {
    const res = await request(app)
      .post(`/api/system/schedules/${createdScheduleId}/run-now`)
      .set('Authorization', `Bearer ${adminToken}`);

    // Without Docker, it should error (500) but not crash
    expect([200, 500]).toContain(res.status);
    if (res.status === 500) {
      expect(res.body.error).toBeTruthy();
    }
  });
});

describe('DELETE /api/system/schedules/:id — delete schedule', () => {
  it('should delete the schedule', async () => {
    const res = await request(app)
      .delete(`/api/system/schedules/${createdScheduleId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.ok).toBe(true);
  });

  it('should return empty list after deletion', async () => {
    const res = await request(app)
      .get('/api/system/schedules')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.length).toBe(0);
  });

  it('should return 404 for already-deleted schedule', async () => {
    await request(app)
      .delete(`/api/system/schedules/${createdScheduleId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });
});
