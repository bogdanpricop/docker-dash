'use strict';

// Integration tests for src/routes/cli-preview.js (v8.94.0).
// Follows the egress-filter-routes.test.js pattern.
//
// The endpoint is read-only, so the interesting assertions are the authz floor
// and the allowlist — a preview endpoint that accepted arbitrary input would be
// a command-injection surface wearing a transparency badge.

process.env.APP_SECRET = 'test-secret-for-cli-preview-routes';
process.env.APP_ENV = 'test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'CliPreviewRouteTest123!';

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
app.use('/api/cli-preview', require('../routes/cli-preview'));

let authToken = null;

beforeAll(async () => {
  require('./helpers/seedTestAdmin').clearMustChange('admin');
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'CliPreviewRouteTest123!' });
  authToken = res.body.token;
  if (!authToken) throw new Error('Failed to log in for cli-preview route tests');
});

const auth = () => ({ Authorization: `Bearer ${authToken}` });

describe('GET /api/cli-preview/actions', () => {
  it('requires auth', async () => {
    expect((await request(app).get('/api/cli-preview/actions')).status).toBe(401);
  });

  it('returns the allowlist', async () => {
    const res = await request(app).get('/api/cli-preview/actions').set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.actions)).toBe(true);
    expect(res.body.actions).toContain('container.stop');
  });
});

describe('POST /api/cli-preview', () => {
  it('requires auth', async () => {
    const res = await request(app).post('/api/cli-preview').send({ action: 'container.stop' });
    expect(res.status).toBe(401);
  });

  it('derives a command for a known action', async () => {
    const res = await request(app).post('/api/cli-preview').set(auth())
      .send({ action: 'container.stop', params: { name: 'web', hostName: 'lan-01' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: true, command: 'docker stop web', hostLabel: 'lan-01' });
  });

  it('rejects a missing action', async () => {
    const res = await request(app).post('/api/cli-preview').set(auth()).send({});
    expect(res.status).toBe(400);
  });

  it('rejects an action outside the allowlist', async () => {
    const res = await request(app).post('/api/cli-preview').set(auth())
      .send({ action: 'container.teleport', params: { name: 'web' } });
    expect(res.status).toBe(400);
  });

  it('rejects prototype keys as actions', async () => {
    for (const action of ['__proto__', 'constructor', 'toString']) {
      const res = await request(app).post('/api/cli-preview').set(auth()).send({ action });
      expect(res.status).toBe(400);
    }
  });

  it('never echoes a caller-supplied command string', async () => {
    const res = await request(app).post('/api/cli-preview').set(auth())
      .send({ action: 'container.stop', command: 'rm -rf /', params: { name: 'web' } });
    expect(res.status).toBe(200);
    expect(res.body.command).toBe('docker stop web');
  });

  it('escapes a hostile subject name', async () => {
    const res = await request(app).post('/api/cli-preview').set(auth())
      .send({ action: 'container.stop', params: { name: '; rm -rf /' } });
    expect(res.body.command).toBe("docker stop '; rm -rf /'");
  });

  it('masks secret env values', async () => {
    const res = await request(app).post('/api/cli-preview').set(auth())
      .send({ action: 'container.run', params: { image: 'app', env: ['DB_PASSWORD=hunter2'] } });
    expect(res.body.redacted).toBe(true);
    expect(res.body.command).not.toContain('hunter2');
  });

  it('reports available:false for a known action with unusable params', async () => {
    const res = await request(app).post('/api/cli-preview').set(auth())
      .send({ action: 'stack.up', params: {} });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: false, command: null, reason: 'invalid-params' });
  });

  it('refuses an oversized bulk subject list', async () => {
    const subjects = Array.from({ length: 1001 }, (_, i) => `c${i}`);
    const res = await request(app).post('/api/cli-preview').set(auth())
      .send({ action: 'container.bulk', params: { action: 'stop', subjects } });
    expect(res.status).toBe(400);
  });

  it('tolerates a non-object params without throwing', async () => {
    const res = await request(app).post('/api/cli-preview').set(auth())
      .send({ action: 'prune.volumes', params: 'nope' });
    expect(res.status).toBe(200);
    expect(res.body.command).toBe('docker volume prune -f');
  });
});
