'use strict';

process.env.APP_SECRET = 'test-secret-images-scan';
process.env.APP_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'ImagesScanTest123!';

jest.mock('child_process', () => ({ ...jest.requireActual('child_process'),
  execFileSync: jest.fn(() => 'test scanner version'),
}));
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
app.use('/api/images', require('../routes/images'));

let adminToken = null;

beforeAll(async () => {
  require('./helpers/seedTestAdmin').clearMustChange('admin');
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'ImagesScanTest123!' });
  adminToken = res.body.token;
});

describe('GET /api/images/scanners', () => {
  it('should return 200 with scanners array', async () => {
    const res = await request(app)
      .get('/api/images/scanners')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.scanners).toBeTruthy();
    expect(Array.isArray(res.body.scanners)).toBe(true);
  });

  it('should return 401 without auth', async () => {
    await request(app).get('/api/images/scanners').expect(401);
  });
});

describe('GET /api/images', () => {
  it('should return images list or handle Docker unavailable', async () => {
    const res = await request(app)
      .get('/api/images')
      .set('Authorization', `Bearer ${adminToken}`);

    // Docker may not be available in test env
    expect([200, 500]).toContain(res.status);

    if (res.status === 200) {
      expect(Array.isArray(res.body)).toBe(true);
    }
  });
});


describe('temporarily excluded Docker Scout', () => {
  beforeEach(() => jest.clearAllMocks());

  it('explains the exclusion and only advertises supported scanners', async () => {
    const response = await request(app).get('/api/images/scanners').set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(response.body.scanners).toEqual(['trivy', 'grype']);
    expect(response.body.disabled).toEqual([expect.objectContaining({ scanner: 'docker-scout', reason: expect.stringContaining('vulnerable dependencies') })]);
    expect(require('child_process').execFileSync).not.toHaveBeenCalledWith('docker', expect.anything(), expect.anything());
  });

  it.each(['scout', 'docker-scout'])('explicit %s requests fail before accessing Docker or invoking a scanner', async scanner => {
    const response = await request(app).get(`/api/images/sha256:unavailable/scan?scanner=${scanner}`)
      .set('Authorization', `Bearer ${adminToken}`).expect(503);
    expect(response.body).toMatchObject({ code: 'SCOUT_TEMPORARILY_DISABLED', status: 'disabled', scanner: 'none' });
    expect(response.body.summary).toBeUndefined();
    expect(require('child_process').execFileSync).not.toHaveBeenCalled();
  });

  it('does not run Docker login for the excluded plugin', async () => {
    const response = await request(app).post('/api/images/scout-login').set('Authorization', `Bearer ${adminToken}`)
      .send({ username: 'example', password: 'not-a-real-secret' }).expect(503);
    expect(response.body.code).toBe('SCOUT_TEMPORARILY_DISABLED');
    expect(require('child_process').execFileSync).not.toHaveBeenCalled();
  });
});
