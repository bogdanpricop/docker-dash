'use strict';

process.env.APP_SECRET = 'test-secret-webhooks';
process.env.APP_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'WebhooksTest123!';

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
app.use('/api/webhooks', require('../routes/webhooks'));

let adminToken = null;

beforeAll(async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'WebhooksTest123!' });
  adminToken = res.body.token;
});

describe('GET /api/webhooks', () => {
  it('should return 200 with webhook list', async () => {
    const res = await request(app)
      .get('/api/webhooks')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body).toBeTruthy();
  });

  it('should return 401 without auth', async () => {
    await request(app).get('/api/webhooks').expect(401);
  });
});

describe('POST /api/webhooks', () => {
  it('should create a webhook', async () => {
    const res = await request(app)
      .post('/api/webhooks')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Test Webhook',
        url: 'https://example.com/webhook',
        events: 'container.start,container.stop',
        is_active: 1,
      })
      .expect(201);

    expect(res.body.id).toBeTruthy();
  });
});

describe('PUT /api/webhooks/:id', () => {
  it('should update a webhook', async () => {
    // Create first
    const createRes = await request(app)
      .post('/api/webhooks')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Update Me', url: 'https://example.com/hook2', events: 'alert.triggered', is_active: 1 });

    const webhookId = createRes.body.id;

    await request(app)
      .put(`/api/webhooks/${webhookId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Updated Webhook', is_active: 0 })
      .expect(200);
  });
});

describe('DELETE /api/webhooks/:id', () => {
  it('should delete a webhook', async () => {
    const createRes = await request(app)
      .post('/api/webhooks')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Delete Me', url: 'https://example.com/hook3', events: 'container.start', is_active: 1 });

    await request(app)
      .delete(`/api/webhooks/${createRes.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });
});

describe('GET /api/webhooks/:id', () => {
  it('should return 404 for non-existent webhook', async () => {
    await request(app)
      .get('/api/webhooks/99999')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });
});
