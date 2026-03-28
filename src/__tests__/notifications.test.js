'use strict';

// Integration tests for notifications endpoints.
// Uses supertest against the real Express app with in-memory DB.

process.env.APP_SECRET = 'test-secret-for-notifications';
process.env.APP_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'NotifTest123!';

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

const { getDb } = require('../db');
const db = getDb();

const authService = require('../services/auth');
authService.seedAdmin();

app.use('/api/auth', require('../routes/auth'));
app.use('/api', require('../routes/misc'));

let authToken = null;
let adminUserId = null;

beforeAll(async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'NotifTest123!' });
  authToken = res.body.token;
  adminUserId = res.body.user.id;
});

// Seed some notifications for testing
function seedNotifications() {
  const stmt = db.prepare('INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)');
  stmt.run(adminUserId, 'info', 'Container started', 'my-app started successfully');
  stmt.run(adminUserId, 'error', 'Container crashed', 'my-app exited with code 1');
  stmt.run(adminUserId, 'warning', 'High memory', 'my-app using 90% memory');
  stmt.run(adminUserId, 'info', 'Image pulled', 'node:18 pulled successfully');
  stmt.run(null, 'info', 'System update', 'Docker Dash updated to v4.2.0'); // Global notification
}

describe('GET /api/notifications', () => {
  beforeAll(() => {
    seedNotifications();
  });

  it('should return paginated results', async () => {
    const res = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200);

    expect(res.body.items).toBeTruthy();
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.total).toBeGreaterThanOrEqual(5);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(50);
  });

  it('should filter by type', async () => {
    const res = await request(app)
      .get('/api/notifications?type=error')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200);

    expect(res.body.items.length).toBeGreaterThanOrEqual(1);
    for (const item of res.body.items) {
      expect(item.type).toBe('error');
    }
  });

  it('should include global notifications (user_id IS NULL)', async () => {
    const res = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200);

    const globalNotif = res.body.items.find(n => n.title === 'System update');
    expect(globalNotif).toBeTruthy();
  });

  it('should support pagination with limit', async () => {
    const res = await request(app)
      .get('/api/notifications?limit=2&page=1')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200);

    expect(res.body.items.length).toBeLessThanOrEqual(2);
    expect(res.body.limit).toBe(2);
  });

  it('should require authentication', async () => {
    await request(app).get('/api/notifications').expect(401);
  });
});

describe('GET /api/notifications/count', () => {
  it('should return unread count', async () => {
    const res = await request(app)
      .get('/api/notifications/count')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200);

    expect(typeof res.body.count).toBe('number');
    expect(res.body.count).toBeGreaterThanOrEqual(5);
  });
});

describe('POST /api/notifications/:id/read', () => {
  it('should mark a notification as read', async () => {
    // Get the first notification
    const list = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${authToken}`);
    const notifId = list.body.items[0].id;

    await request(app)
      .post(`/api/notifications/${notifId}/read`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200);

    // Verify unread count decreased
    const countBefore = list.body.total;
    const countRes = await request(app)
      .get('/api/notifications?unreadOnly=true')
      .set('Authorization', `Bearer ${authToken}`);
    expect(countRes.body.total).toBeLessThan(countBefore);
  });
});

describe('POST /api/notifications/read-all', () => {
  it('should mark all notifications as read', async () => {
    await request(app)
      .post('/api/notifications/read-all')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200);

    const res = await request(app)
      .get('/api/notifications/count')
      .set('Authorization', `Bearer ${authToken}`);
    expect(res.body.count).toBe(0);
  });
});

describe('DELETE /api/notifications/:id', () => {
  it('should delete a notification', async () => {
    // Seed a fresh one
    db.prepare('INSERT INTO notifications (user_id, type, title) VALUES (?, ?, ?)')
      .run(adminUserId, 'info', 'To be deleted');

    const list = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${authToken}`);
    const target = list.body.items.find(n => n.title === 'To be deleted');
    expect(target).toBeTruthy();

    await request(app)
      .delete(`/api/notifications/${target.id}`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200);

    // Verify it is gone
    const after = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${authToken}`);
    const found = after.body.items.find(n => n.id === target.id);
    expect(found).toBeUndefined();
  });
});

describe('POST /api/notifications/bulk', () => {
  it('should bulk mark-read notifications', async () => {
    // Seed two unread notifications
    db.prepare('INSERT INTO notifications (user_id, type, title) VALUES (?, ?, ?)').run(adminUserId, 'info', 'Bulk 1');
    db.prepare('INSERT INTO notifications (user_id, type, title) VALUES (?, ?, ?)').run(adminUserId, 'info', 'Bulk 2');

    const list = await request(app)
      .get('/api/notifications?unreadOnly=true')
      .set('Authorization', `Bearer ${authToken}`);
    const ids = list.body.items.slice(0, 2).map(n => n.id);

    await request(app)
      .post('/api/notifications/bulk')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ ids, action: 'read' })
      .expect(200);
  });

  it('should bulk delete notifications', async () => {
    db.prepare('INSERT INTO notifications (user_id, type, title) VALUES (?, ?, ?)').run(adminUserId, 'info', 'BulkDel 1');
    db.prepare('INSERT INTO notifications (user_id, type, title) VALUES (?, ?, ?)').run(adminUserId, 'info', 'BulkDel 2');

    const list = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${authToken}`);
    const targets = list.body.items.filter(n => n.title.startsWith('BulkDel'));
    const ids = targets.map(n => n.id);

    await request(app)
      .post('/api/notifications/bulk')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ ids, action: 'delete' })
      .expect(200);

    // Verify they are deleted
    const after = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${authToken}`);
    const remaining = after.body.items.filter(n => n.title.startsWith('BulkDel'));
    expect(remaining.length).toBe(0);
  });

  it('should reject invalid action', async () => {
    await request(app)
      .post('/api/notifications/bulk')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ ids: [1], action: 'invalid' })
      .expect(400);
  });

  it('should reject missing ids', async () => {
    await request(app)
      .post('/api/notifications/bulk')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ action: 'read' })
      .expect(400);
  });

  it('should require authentication', async () => {
    await request(app)
      .post('/api/notifications/bulk')
      .send({ ids: [1], action: 'read' })
      .expect(401);
  });
});
