'use strict';

process.env.APP_SECRET = 'governance-route-test-secret';
process.env.ENCRYPTION_KEY = 'governance-route-test-key-32chars';
process.env.DB_PATH = ':memory:';

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => {
    req.user = { id: 951, username: 'route-governance-admin', role: 'admin' };
    next();
  },
  requireFeature: () => (_req, _res, next) => next(),
  writeable: (_req, _res, next) => next(),
}));

const express = require('express');
const request = require('supertest');
const { getDb, closeDb } = require('../db');

const app = express();
app.use(express.json());
app.use('/api/governance', require('../routes/governance'));

describe('governance routes', () => {
  beforeAll(() => {
    const db = getDb();
    db.prepare(`INSERT OR IGNORE INTO users (id, username, email, password_hash, role, is_active)
      VALUES (951, 'route-governance-admin', 'route-admin@example.test', 'not-used-in-test', 'admin', 1)`).run();
  });

  afterAll(() => closeDb());

  test('exposes the catalog and creates a project through the audited API', async () => {
    const catalog = await request(app).get('/api/governance/catalog').expect(200);
    expect(catalog.body.permissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ permission_key: 'project.quotas.manage', key: 'project.quotas.manage' }),
    ]));
    expect(catalog.body.globalAdmin).toBe(true);

    const slug = `route-project-${Date.now()}`;
    const created = await request(app).post('/api/governance/projects').send({
      slug, name: 'Route project', parentScopeId: 1,
    }).expect(201);
    expect(created.body.project).toEqual(expect.objectContaining({ slug, parentScopeId: 1 }));

    const detail = await request(app).get(`/api/governance/projects/${created.body.project.id}`).expect(200);
    expect(detail.body.project).toEqual(expect.objectContaining({
      usageMode: 'production', permissions: ['*'], memberCount: 1,
    }));
    expect(detail.body.project.quotas.cpu_millicores).toEqual(expect.objectContaining({
      used: 0, state: 'within-limit',
    }));
    expect(detail.body.project.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ user_id: 951, is_owner: true, isOwner: true }),
    ]));
  });
});
