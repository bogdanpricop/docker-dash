'use strict';

// Integration tests for custom templates CRUD endpoints.
// Tests built-in listing, custom creation, override, reset, delete, and RBAC.

process.env.APP_SECRET = 'test-secret-for-templates-tests';
process.env.APP_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'TemplateTest123!';

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// Initialize DB (runs migrations)
const { getDb } = require('../db');
getDb();

// Seed admin + create a viewer user for RBAC tests
const authService = require('../services/auth');
authService.seedAdmin();

// Register routes
app.use('/api/auth', require('../routes/auth'));
app.use('/api/templates', require('../routes/templates'));

let adminToken = null;
let viewerToken = null;

beforeAll(async () => {
  // Login as admin
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'TemplateTest123!' });
  adminToken = res.body.token;

  // Create a viewer user for RBAC tests
  await request(app)
    .post('/api/auth/users')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ username: 'viewer1', password: 'ViewerPass123!', role: 'viewer' });

  const viewerRes = await request(app)
    .post('/api/auth/login')
    .send({ username: 'viewer1', password: 'ViewerPass123!' });
  viewerToken = viewerRes.body.token;
});

describe('GET /api/templates', () => {
  // Happy path: returns built-in templates
  it('should return built-in templates for authenticated user', async () => {
    const res = await request(app)
      .get('/api/templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.templates).toBeTruthy();
    expect(Array.isArray(res.body.templates)).toBe(true);
    expect(res.body.templates.length).toBeGreaterThan(10);
    expect(res.body.categories).toBeTruthy();
    expect(res.body.total).toBeGreaterThan(10);

    // Each template has expected shape
    const t = res.body.templates[0];
    expect(t).toHaveProperty('id');
    expect(t).toHaveProperty('name');
    expect(t).toHaveProperty('category');
    expect(t).toHaveProperty('compose');
    expect(t.isBuiltin).toBe(true);
  });

  // Security: requires authentication
  it('should return 401 without auth', async () => {
    await request(app).get('/api/templates').expect(401);
  });
});

describe('POST /api/templates — create custom template', () => {
  it('should create a custom template', async () => {
    const res = await request(app)
      .post('/api/templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        id: 'my-custom-app',
        name: 'My Custom App',
        category: 'Custom',
        compose: 'services:\n  app:\n    image: myapp:latest',
      })
      .expect(201);

    expect(res.body.ok).toBe(true);
    expect(res.body.id).toBe('my-custom-app');
  });

  // Verify custom template appears in list
  it('should include custom template in list', async () => {
    const res = await request(app)
      .get('/api/templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const custom = res.body.templates.find(t => t.id === 'my-custom-app');
    expect(custom).toBeTruthy();
    expect(custom.isCustom).toBe(true);
    expect(custom.name).toBe('My Custom App');
  });

  // Duplicate custom ID returns 409
  it('should return 409 for duplicate custom ID', async () => {
    const res = await request(app)
      .post('/api/templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        id: 'my-custom-app',
        name: 'Duplicate',
        compose: 'services:\n  dup:\n    image: dup:latest',
      })
      .expect(409);

    expect(res.body.error).toContain('already exists');
  });

  // Built-in ID conflict returns 409
  it('should return 409 when using a built-in template ID', async () => {
    const res = await request(app)
      .post('/api/templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        id: 'nginx',
        name: 'My Nginx',
        compose: 'services:\n  nginx:\n    image: nginx:custom',
      })
      .expect(409);

    expect(res.body.error).toContain('built-in');
  });

  // Validation: missing required fields
  it('should return 400 when missing required fields', async () => {
    const res = await request(app)
      .post('/api/templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ id: 'incomplete' })
      .expect(400);

    expect(res.body.error).toBeTruthy();
  });

  // RBAC: viewer cannot create
  it('should return 403 for viewer role', async () => {
    await request(app)
      .post('/api/templates')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({
        id: 'viewer-template',
        name: 'Viewer Template',
        compose: 'services:\n  v:\n    image: v:latest',
      })
      .expect(403);
  });
});

describe('PUT /api/templates/:id — update template', () => {
  // Update custom template
  it('should update a custom template', async () => {
    const res = await request(app)
      .put('/api/templates/my-custom-app')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Updated Custom App',
        compose: 'services:\n  app:\n    image: myapp:v2',
      })
      .expect(200);

    expect(res.body.ok).toBe(true);
  });

  // Override built-in template
  it('should create an override for a built-in template', async () => {
    const res = await request(app)
      .put('/api/templates/redis')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Custom Redis',
        category: 'Custom DB',
        compose: 'services:\n  redis:\n    image: redis:custom',
      })
      .expect(200);

    expect(res.body.ok).toBe(true);

    // Verify the override shows in list
    const listRes = await request(app)
      .get('/api/templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const redis = listRes.body.templates.find(t => t.id === 'redis');
    expect(redis.isModified).toBe(true);
    expect(redis.isBuiltin).toBe(true);
    expect(redis.name).toBe('Custom Redis');
  });

  // 404 for nonexistent template
  it('should return 404 for nonexistent template', async () => {
    await request(app)
      .put('/api/templates/nonexistent-xyz')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'X', compose: 'services:\n  x:\n    image: x:1' })
      .expect(404);
  });
});

describe('POST /api/templates/:id/reset — reset built-in override', () => {
  it('should remove the built-in override', async () => {
    const res = await request(app)
      .post('/api/templates/redis/reset')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.ok).toBe(true);

    // Verify redis is back to original
    const listRes = await request(app)
      .get('/api/templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const redis = listRes.body.templates.find(t => t.id === 'redis');
    expect(redis.isModified).toBeFalsy();
    expect(redis.isBuiltin).toBe(true);
  });

  // Non-built-in template returns 400
  it('should return 400 for non-built-in template', async () => {
    const res = await request(app)
      .post('/api/templates/my-custom-app/reset')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);

    expect(res.body.error).toContain('built-in');
  });
});

describe('DELETE /api/templates/:id — delete custom template', () => {
  // Delete custom template
  it('should delete a custom template', async () => {
    const res = await request(app)
      .delete('/api/templates/my-custom-app')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.ok).toBe(true);
  });

  // Cannot delete built-in
  it('should return 400 when deleting a built-in template', async () => {
    const res = await request(app)
      .delete('/api/templates/nginx')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);

    expect(res.body.error).toContain('built-in');
  });

  // 404 for nonexistent (not a built-in, so the delete query finds 0 rows)
  it('should return 404 for nonexistent custom template', async () => {
    await request(app)
      .delete('/api/templates/does-not-exist')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });
});

describe('Templates RBAC enforcement', () => {
  it('should allow viewer to GET templates', async () => {
    await request(app)
      .get('/api/templates')
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(200);
  });

  it('should block viewer from PUT', async () => {
    await request(app)
      .put('/api/templates/nginx')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ name: 'Hacked', compose: 'services:\n  h:\n    image: h:1' })
      .expect(403);
  });

  it('should block viewer from DELETE', async () => {
    await request(app)
      .delete('/api/templates/nginx')
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(403);
  });

  it('should block viewer from POST reset', async () => {
    await request(app)
      .post('/api/templates/nginx/reset')
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(403);
  });
});
