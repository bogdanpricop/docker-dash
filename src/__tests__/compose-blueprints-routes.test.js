'use strict';

process.env.APP_SECRET = 'compose-blueprint-routes-test-secret';
process.env.ENCRYPTION_KEY = 'compose-blueprint-routes-encryption-key';

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, res, next) => {
    if (!req.headers['x-test-user-id']) return res.status(401).json({ error: 'Authentication required' });
    req.user = { id: Number(req.headers['x-test-user-id']), username: 'route-user', role: req.headers['x-test-role'] || 'operator' };
    next();
  },
  requireRole: (...roles) => (req, res, next) => roles.includes(req.user.role)
    ? next() : res.status(403).json({ error: 'Insufficient permissions' }),
  writeable: (_req, _res, next) => next(),
}));

jest.mock('../services/host-permissions', () => ({ resolveEffectivePermission: jest.fn(() => 'operate') }));

jest.mock('../services/compose-blueprints', () => {
  class ComposeBlueprintError extends Error {
    constructor(message, status = 400, code = 'COMPOSE_BLUEPRINT_ERROR') {
      super(message); this.status = status; this.code = code;
    }
  }
  return {
    ComposeBlueprintError,
    list: jest.fn(() => ({ items: [], summary: { total: 0 } })),
    get: jest.fn(() => ({ blueprint: { id: 10, slug: 'web-app', name: 'Web app', lifecycle: 'active' },
      versions: [{ id: 20, versionHash: 'v'.repeat(64) }] })),
    save: jest.fn(() => ({ blueprint: { id: 10, slug: 'web-app', category: 'application', lifecycle: 'draft' } })),
    transition: jest.fn(() => ({ blueprint: { id: 10, slug: 'web-app', lifecycle: 'retired' } })),
    createVersion: jest.fn(async () => ({ version: { id: 20, blueprintId: 10, version: '1.0.0',
      digest: `sha256:${'a'.repeat(64)}`, signaturePolicy: 'cosign', versionHash: 'v'.repeat(64) } })),
    transitionVersion: jest.fn(() => ({ blueprint: { id: 10 }, versions: [{ id: 20, versionHash: 'v'.repeat(64) }] })),
    diff: jest.fn(() => ({ from: { id: 19 }, to: { id: 20 }, changedFields: ['digest'],
      parameters: { added: [], removed: [], changed: [] }, rollback: { catalogOnly: true } })),
    preview: jest.fn(() => ({ blueprint: { id: 10 }, host: { id: 11 }, environment: 'production',
      planHash: 'p'.repeat(64), parametersHash: 'q'.repeat(64), renderedOverrideHash: 'r'.repeat(64),
      secretReferenceAdmission: { referenceCount: 1 } })),
    instantiate: jest.fn(async () => ({ instantiation: { id: 30, hostId: 11, environment: 'production',
      planHash: 'p'.repeat(64), parametersHash: 'q'.repeat(64) }, artifact: { id: 40 }, deduplicated: false })),
    history: jest.fn(() => ({ blueprint: { id: 10, slug: 'web-app', name: 'Web app' },
      instantiations: [{ id: 30, hostId: 11, state: 'succeeded' }] })),
  };
});

jest.mock('../services/audit', () => ({ log: jest.fn() }));

const express = require('express');
const request = require('supertest');
const audit = require('../services/audit');
const hostPermissions = require('../services/host-permissions');
const blueprints = require('../services/compose-blueprints');

const app = express();
app.use(express.json());
app.use('/api/compose-blueprints', require('../routes/compose-blueprints'));
const auth = role => ({ 'x-test-user-id': '41', 'x-test-role': role || 'operator' });

describe('Compose blueprint HTTP API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    hostPermissions.resolveEffectivePermission.mockReturnValue('operate');
    blueprints.get.mockReturnValue({ blueprint: { id: 10, slug: 'web-app', name: 'Web app', lifecycle: 'active' },
      versions: [{ id: 20, versionHash: 'v'.repeat(64) }] });
  });

  test('requires authentication, allows operator reads and reserves catalog authoring for administrators', async () => {
    await request(app).get('/api/compose-blueprints').expect(401);
    await request(app).get('/api/compose-blueprints').set(auth()).expect(200);
    await request(app).post('/api/compose-blueprints').set(auth()).send({ slug: 'web-app' }).expect(403)
      .expect(response => expect(response.body.code).toBe('ADMIN_REQUIRED'));
    await request(app).post('/api/compose-blueprints').set(auth('admin')).send({ slug: 'web-app' }).expect(201);
  });

  test('checks effective host operate access before previewing', async () => {
    hostPermissions.resolveEffectivePermission.mockReturnValue('view');
    await request(app).post('/api/compose-blueprints/10/versions/20/preview').set(auth())
      .send({ hostId: 11, parameters: { apiTokenRef: 'never-audit-me' } }).expect(403)
      .expect(response => expect(response.body.code).toBe('HOST_ACCESS_REQUIRED'));
    expect(blueprints.preview).not.toHaveBeenCalled();
  });

  test('rejects cross-blueprint version instantiation before the mutation', async () => {
    blueprints.get.mockReturnValue({ blueprint: { id: 10 }, versions: [{ id: 99 }] });
    await request(app).post('/api/compose-blueprints/10/versions/20/instantiate').set(auth())
      .send({ hostId: 11, idempotencyKey: 'request-1' }).expect(404)
      .expect(response => expect(response.body.code).toBe('BLUEPRINT_VERSION_NOT_FOUND'));
    expect(blueprints.instantiate).not.toHaveBeenCalled();
  });

  test('audits hashes and identities without raw blueprint parameters', async () => {
    const payload = { hostId: 11, instanceName: 'web-app', projectName: 'web-app', environment: 'production',
      parameters: { apiTokenRef: 'vault://apps/web/token' }, planHash: 'p'.repeat(64), idempotencyKey: 'request-1' };
    await request(app).post('/api/compose-blueprints/10/versions/20/preview').set(auth()).send(payload).expect(200);
    await request(app).post('/api/compose-blueprints/10/versions/20/instantiate').set(auth()).send(payload).expect(201);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'compose_blueprint_instantiate',
      details: expect.objectContaining({ planHash: 'p'.repeat(64), parametersHash: 'q'.repeat(64) }) }));
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain('vault://apps/web/token');
  });

  test('filters history using effective host view access', async () => {
    hostPermissions.resolveEffectivePermission.mockReturnValue('none');
    await request(app).get('/api/compose-blueprints/10/instantiations').set(auth()).expect(200)
      .expect(response => expect(response.body.instantiations).toEqual([]));
  });
});
