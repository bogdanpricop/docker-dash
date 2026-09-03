'use strict';

process.env.APP_SECRET = 'provider-inventory-view-test-secret';
process.env.ENCRYPTION_KEY = 'provider-inventory-view-test-key-32chars';
process.env.DB_PATH = ':memory:';

const mockAudit = jest.fn();

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, res, next) => {
    const id = Number(req.get('x-test-user'));
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(401).json({ error: 'Authentication required' });
    req.user = { id, username: `inventory-user-${id}`, role: 'viewer' };
    next();
  },
  writeable: (_req, _res, next) => next(),
}));

jest.mock('../services/audit', () => ({
  log: (...args) => mockAudit(...args),
}));

const express = require('express');
const request = require('supertest');
const { getDb, closeDb } = require('../db');

const app = express();
app.use(express.json());
app.use('/api/providers/inventory-views', require('../routes/provider-inventory-views'));

function payload(overrides = {}) {
  return {
    name: 'Production VMs',
    resourceType: 'virtual-machines',
    providerHostId: null,
    filters: { query: 'owner:platform', powerState: 'running' },
    columns: ['name', 'powerState', 'cpu', 'memory'],
    sort: { field: 'cpu', direction: 'desc' },
    isDefault: true,
    ...overrides,
  };
}

describe('personal provider inventory views', () => {
  beforeAll(() => {
    const db = getDb();
    const insert = db.prepare(`INSERT INTO users (id, username, email, password_hash, role, is_active)
      VALUES (?, ?, ?, 'not-used-in-test', 'viewer', 1)`);
    insert.run(971, 'inventory-user-971', 'inventory-971@example.test');
    insert.run(972, 'inventory-user-972', 'inventory-972@example.test');
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM provider_inventory_views').run();
    mockAudit.mockClear();
  });

  afterAll(() => closeDb());

  test('migration creates the ownership and default-view constraints', () => {
    const db = getDb();
    const columns = db.prepare('PRAGMA table_info(provider_inventory_views)').all().map(row => row.name);
    const indexes = db.prepare('PRAGMA index_list(provider_inventory_views)').all().map(row => row.name);
    expect(columns).toEqual(expect.arrayContaining(['user_id', 'resource_type', 'version', 'is_default']));
    expect(indexes).toEqual(expect.arrayContaining([
      'idx_provider_inventory_views_user_name',
      'idx_provider_inventory_views_default',
    ]));
  });

  test('creates, lists and audits a personal view without recording its query', async () => {
    const created = await request(app).post('/api/providers/inventory-views')
      .set('x-test-user', '971').send(payload()).expect(201);

    expect(created.body.view).toEqual(expect.objectContaining({
      name: 'Production VMs', isDefault: true, version: 1,
      filters: { query: 'owner:platform', powerState: 'running' },
      sort: { field: 'cpu', direction: 'desc' },
    }));

    const listed = await request(app).get('/api/providers/inventory-views')
      .query({ resourceType: 'virtual-machines' }).set('x-test-user', '971').expect(200);
    expect(listed.body.views).toHaveLength(1);

    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'provider_inventory_view_create',
      targetId: String(created.body.view.id),
      details: expect.not.objectContaining({ query: expect.anything(), filters: expect.anything() }),
    }));
    expect(JSON.stringify(mockAudit.mock.calls)).not.toContain('owner:platform');
  });

  test('isolates view ownership for reads, updates and deletes', async () => {
    const created = await request(app).post('/api/providers/inventory-views')
      .set('x-test-user', '971').send(payload()).expect(201);
    const id = created.body.view.id;

    const otherList = await request(app).get('/api/providers/inventory-views')
      .query({ resourceType: 'virtual-machines' }).set('x-test-user', '972').expect(200);
    expect(otherList.body.views).toEqual([]);

    await request(app).put(`/api/providers/inventory-views/${id}`)
      .set('x-test-user', '972').send({ ...payload(), version: 1 }).expect(404);
    await request(app).delete(`/api/providers/inventory-views/${id}`)
      .set('x-test-user', '972').expect(404);
  });

  test('moves the single default marker between views', async () => {
    const first = await request(app).post('/api/providers/inventory-views')
      .set('x-test-user', '971').send(payload({ name: 'First' })).expect(201);
    const second = await request(app).post('/api/providers/inventory-views')
      .set('x-test-user', '971').send(payload({ name: 'Second' })).expect(201);

    const listed = await request(app).get('/api/providers/inventory-views')
      .query({ resourceType: 'virtual-machines' }).set('x-test-user', '971').expect(200);
    expect(listed.body.views.filter(view => view.isDefault)).toEqual([
      expect.objectContaining({ id: second.body.view.id, name: 'Second' }),
    ]);
    expect(listed.body.views.find(view => view.id === first.body.view.id).isDefault).toBe(false);
  });

  test('rejects duplicate names, stale versions and invalid column state', async () => {
    const created = await request(app).post('/api/providers/inventory-views')
      .set('x-test-user', '971').send(payload()).expect(201);

    const duplicate = await request(app).post('/api/providers/inventory-views')
      .set('x-test-user', '971').send(payload({ name: 'production vms', isDefault: false })).expect(409);
    expect(duplicate.body.code).toBe('VIEW_NAME_CONFLICT');

    const updated = await request(app).put(`/api/providers/inventory-views/${created.body.view.id}`)
      .set('x-test-user', '971').send({ ...payload({ name: 'Updated' }), version: 1 }).expect(200);
    expect(updated.body.view.version).toBe(2);

    const stale = await request(app).put(`/api/providers/inventory-views/${created.body.view.id}`)
      .set('x-test-user', '971').send({ ...payload({ name: 'Stale' }), version: 1 }).expect(409);
    expect(stale.body.code).toBe('STALE_VIEW');

    const invalid = await request(app).post('/api/providers/inventory-views')
      .set('x-test-user', '971').send(payload({ columns: ['cpu'] })).expect(400);
    expect(invalid.body.code).toBe('INVALID_COLUMNS');
  });

  test('requires authentication and rejects unexpected persisted state', async () => {
    await request(app).get('/api/providers/inventory-views')
      .query({ resourceType: 'virtual-machines' }).expect(401);

    const response = await request(app).post('/api/providers/inventory-views')
      .set('x-test-user', '971').send({ ...payload(), sharedWith: ['team'] }).expect(400);
    expect(response.body.code).toBe('UNEXPECTED_FIELD');
  });
});
