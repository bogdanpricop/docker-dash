'use strict';

process.env.APP_SECRET = 'test-host-access-enforcement';
process.env.APP_ENV = 'test';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'HostAccess123!';

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');

const { getDb } = require('../db');
const authService = require('../services/auth');
const permissions = require('../services/host-permissions');
const { requireHostAccessForMethod } = require('../middleware/hostAccess');

const app = express();
app.use(express.json());
app.use(cookieParser());
getDb();
authService.seedAdmin();
app.use('/api/auth', require('../routes/auth'));
app.use('/api/hosts', require('../routes/hosts'));
app.use('/api/containers', require('../routes/containers'));
app.use('/api/teams', require('../routes/teams'));
app.use('/api/host-groups', require('../routes/host-groups'));
app.use('/api/host-permissions', require('../routes/host-permissions'));
app.use('/api/git', require('../routes/git'));

let adminToken;
let viewerToken;
let viewerId;
let visibleHostId;
let hiddenHostId;
let noAccessHostId;
let defaultHostId;

beforeAll(async () => {
  require('./helpers/seedTestAdmin').clearMustChange('admin');
  const adminLogin = await request(app).post('/api/auth/login')
    .send({ username: 'admin', password: 'HostAccess123!' });
  adminToken = adminLogin.body.token;

  await request(app).post('/api/auth/users')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ username: 'acl-viewer', password: 'AclViewer123!', role: 'viewer' });
  const viewerLogin = await request(app).post('/api/auth/login')
    .send({ username: 'acl-viewer', password: 'AclViewer123!' });
  viewerToken = viewerLogin.body.token;
  viewerId = viewerLogin.body.user.id;

  const db = getDb();
  defaultHostId = db.prepare('SELECT id FROM docker_hosts WHERE is_default = 1').get().id;
  visibleHostId = Number(db.prepare(
    "INSERT INTO docker_hosts (name, connection_type, host, port) VALUES ('acl-visible', 'tcp', '127.0.0.1', 12376)"
  ).run().lastInsertRowid);
  hiddenHostId = Number(db.prepare(
    "INSERT INTO docker_hosts (name, connection_type, host, port) VALUES ('acl-hidden', 'tcp', '127.0.0.1', 12377)"
  ).run().lastInsertRowid);
  noAccessHostId = Number(db.prepare(
    "INSERT INTO docker_hosts (name, connection_type, host, port) VALUES ('acl-none', 'tcp', '127.0.0.1', 12378)"
  ).run().lastInsertRowid);

  permissions.setLegacyDefault(false);
  permissions.grant({ hostId: visibleHostId, userId: viewerId, permission: 'view' }, null);
});

afterAll(() => permissions.setLegacyDefault(true));

describe('host permission service hardening', () => {
  test('hostId=0 resolves to the persisted default host', () => {
    expect(permissions.normalizeHostId(0)).toBe(defaultHostId);
    permissions.grant({ hostId: 0, userId: viewerId, permission: 'view' }, null);
    expect(permissions.resolveEffectivePermission(viewerId, 0, false)).toBe('view');
  });

  test('granting the same subject and target updates instead of duplicating', () => {
    const first = permissions.grant(
      { hostId: visibleHostId, userId: viewerId, permission: 'view' }, null
    );
    const second = permissions.grant(
      { hostId: visibleHostId, userId: viewerId, permission: 'operate' }, null
    );
    expect(second).toBe(first);
    expect(permissions.grantsForHost(visibleHostId)).toHaveLength(1);
    expect(permissions.resolveEffectivePermission(viewerId, visibleHostId, false)).toBe('operate');
  });
});

describe('host-list and resource-route enforcement', () => {
  test('non-admin host list contains only explicitly visible hosts', async () => {
    const response = await request(app).get('/api/hosts')
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(200);
    const ids = response.body.map(host => host.id);
    expect(ids).toContain(visibleHostId);
    expect(ids).not.toContain(hiddenHostId);
  });

  test('single-host details fail closed for an ungranted host', async () => {
    const response = await request(app).get(`/api/hosts/${hiddenHostId}`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(403);
    expect(response.body.code).toBe('HOST_ACCESS_DENIED');
  });

  test('container routes reject an ungranted host before touching Docker', async () => {
    const response = await request(app).get(`/api/containers?hostId=${hiddenHostId}`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(403);
    expect(response.body).toMatchObject({ code: 'HOST_ACCESS_DENIED', required: 'view' });
  });

  test('global admins bypass per-host grants', async () => {
    const response = await request(app).get(`/api/hosts/${hiddenHostId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(response.body.id).toBe(hiddenHostId);
  });
});

describe('Teams & Access administration API', () => {
  test('non-admins only receive ACL-filtered group metadata', async () => {
    await request(app).get('/api/teams')
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(403);
    const groups = await request(app).get('/api/host-groups')
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(200);
    for (const group of groups.body) {
      expect(group.member_host_ids).not.toContain(hiddenHostId);
    }
    await request(app).get(`/api/host-permissions?hostId=${visibleHostId}`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(403);
  });

  test('effective permission accepts the default-host alias', async () => {
    const response = await request(app).get('/api/host-permissions/effective?hostId=0')
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(200);
    expect(response.body).toMatchObject({ hostId: 0, permission: 'view' });
  });

  test('admin can create a team/group grant and list it by group target', async () => {
    const teamResponse = await request(app).post('/api/teams')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'qa-operators', memberIds: [viewerId] })
      .expect(201);
    const groupResponse = await request(app).post('/api/host-groups')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'qa-hosts', hostIds: [visibleHostId] })
      .expect(201);

    await request(app).post('/api/host-permissions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ hostGroupId: groupResponse.body.id, teamId: teamResponse.body.id, permission: 'operate' })
      .expect(201);

    const grants = await request(app)
      .get(`/api/host-permissions?hostGroupId=${groupResponse.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(grants.body).toHaveLength(1);
    expect(grants.body[0]).toMatchObject({ team_name: 'qa-operators', permission: 'operate' });
  });
});

describe('method-aware middleware', () => {
  function invoke(method) {
    const req = { method, hostId: hiddenHostId, query: {}, headers: {}, user: { id: viewerId, role: 'viewer' } };
    const result = { status: null, body: null, next: false };
    const res = {
      status(code) { result.status = code; return this; },
      json(body) { result.body = body; return this; },
    };
    requireHostAccessForMethod()(req, res, () => { result.next = true; });
    return result;
  }

  test('GET requires view while POST requires operate', () => {
    permissions.grant({ hostId: hiddenHostId, userId: viewerId, permission: 'view' }, null);
    expect(invoke('GET').next).toBe(true);
    expect(invoke('POST')).toMatchObject({ status: 403, next: false });
    permissions.grant({ hostId: hiddenHostId, userId: viewerId, permission: 'operate' }, null);
    expect(invoke('POST').next).toBe(true);
  });
});

describe('Git Compose file route enforcement', () => {
  const gitService = require('../services/git');

  test('requires authentication and stack view access before reading a file', async () => {
    const getStack = jest.spyOn(gitService, 'getStack');
    const readComposeFile = jest.spyOn(gitService, 'readComposeFile')
      .mockReturnValue({ path: 'compose.yml', content: 'services: {}\n' });
    try {
      getStack.mockReturnValue({ id: 41, target_host_ids: [visibleHostId] });
      await request(app).get('/api/git/stacks/41/file?path=compose.yml').expect(401);

      const allowed = await request(app).get('/api/git/stacks/41/file?path=compose.yml')
        .set('Authorization', `Bearer ${viewerToken}`)
        .expect(200);
      expect(allowed.body).toEqual({ path: 'compose.yml', content: 'services: {}\n' });
      expect(readComposeFile).toHaveBeenCalledWith(41, 'compose.yml');

      readComposeFile.mockClear();
      getStack.mockReturnValue({ id: 42, target_host_ids: [noAccessHostId] });
      await request(app).get('/api/git/stacks/42/file?path=compose.yml')
        .set('Authorization', `Bearer ${viewerToken}`)
        .expect(403);
      expect(readComposeFile).not.toHaveBeenCalled();
    } finally {
      getStack.mockRestore();
      readComposeFile.mockRestore();
    }
  });
});
