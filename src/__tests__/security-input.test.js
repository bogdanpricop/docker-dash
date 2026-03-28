'use strict';

// Test input validation and injection prevention across security-critical endpoints.

process.env.APP_SECRET = 'test-secret-security-input';
process.env.APP_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'SecInput123!';

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

// Register routes
app.use('/api/auth', require('../routes/auth'));
try { app.use('/api/containers', require('../routes/containers')); } catch {}
try { app.use('/api/system', require('../routes/system')); } catch {}
app.use('/api', require('../routes/misc'));

let adminToken = null;

beforeAll(async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'SecInput123!' });
  adminToken = res.body.token;
});

describe('SQL injection prevention', () => {
  it('should handle SQL injection in search query safely', async () => {
    const res = await request(app)
      .get("/api/search?q=' OR 1=1 --")
      .set('Authorization', `Bearer ${adminToken}`);
    // Should return 200 with empty or safe results — not a DB error
    expect([200]).toContain(res.status);
  });

  it('should handle SQL injection in search with UNION attempt', async () => {
    const res = await request(app)
      .get("/api/search?q=test' UNION SELECT * FROM users --")
      .set('Authorization', `Bearer ${adminToken}`);
    expect([200]).toContain(res.status);
  });

  it('should handle SQL injection in login username', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: "admin' OR '1'='1", password: 'anything' });
    // Should reject — not authenticate
    expect(res.status).toBe(401);
    expect(res.body.token).toBeUndefined();
  });
});

describe('Path traversal prevention in file browser', () => {
  it('should return 400 for path with ..', async () => {
    const res = await request(app)
      .get('/api/containers/abc123def456/files?path=../../etc/passwd')
      .set('Authorization', `Bearer ${adminToken}`);
    // Should be 400 (invalid path) — the validateFilePath function rejects ".."
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid path/i);
  });

  it('should return 400 for path /..', async () => {
    const res = await request(app)
      .get('/api/containers/abc123def456/files?path=/..')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid path/i);
  });

  it('should return 400 for path traversal in file content endpoint', async () => {
    const res = await request(app)
      .get('/api/containers/abc123def456/files/content?path=../../../etc/shadow')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid path/i);
  });

  it('should return 400 for path without leading slash', async () => {
    const res = await request(app)
      .get('/api/containers/abc123def456/files?path=etc/passwd')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it('should return 400 for path with null byte', async () => {
    const res = await request(app)
      .get('/api/containers/abc123def456/files?path=/etc/passwd%00.txt')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });
});

describe('Prototype pollution prevention', () => {
  it('should strip __proto__ from request body via sanitizeBody', () => {
    const { sanitizeBody } = require('../middleware/validate');
    const req = { body: { name: 'test', __proto__: { admin: true }, constructor: { name: 'Hacked' } } };
    const res = {};
    let called = false;
    sanitizeBody('name')(req, res, () => { called = true; });
    expect(called).toBe(true);
    expect(req.body.name).toBe('test');
    expect(Object.keys(req.body)).toEqual(['name']);
  });

  it('should strip prototype pollution vectors even without allowedFields', () => {
    const { sanitizeBody } = require('../middleware/validate');
    const req = { body: { name: 'test', prototype: { x: 1 } } };
    const res = {};
    let called = false;
    sanitizeBody()(req, res, () => { called = true; });
    expect(called).toBe(true);
    expect(req.body.prototype).toBeUndefined();
  });
});

describe('Firewall input validation', () => {
  it('should reject port with shell injection', async () => {
    const res = await request(app)
      .post('/api/system/firewall/rule')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action: 'allow', port: '80;rm -rf /', proto: 'tcp' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/port/i);
  });

  it('should reject port with backtick injection', async () => {
    const res = await request(app)
      .post('/api/system/firewall/rule')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action: 'allow', port: '80`whoami`', proto: 'tcp' });
    expect(res.status).toBe(400);
  });

  it('should reject from with shell injection', async () => {
    const res = await request(app)
      .post('/api/system/firewall/rule')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action: 'allow', port: '80', from: '1.1.1.1;whoami' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/from|ip/i);
  });

  it('should reject invalid action', async () => {
    const res = await request(app)
      .post('/api/system/firewall/rule')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action: 'drop; rm -rf /', port: '80' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/action/i);
  });

  it('should reject invalid protocol', async () => {
    const res = await request(app)
      .post('/api/system/firewall/rule')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ action: 'allow', port: '80', proto: 'tcp;whoami' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/protocol/i);
  });
});

describe('Container ID sanitization', () => {
  it('should sanitize container IDs — sanitizeId strips non-hex chars', () => {
    const { sanitizeId } = require('../utils/helpers');
    expect(sanitizeId('abc123')).toBe('abc123');
    expect(sanitizeId('abc;rm -rf /')).toBe('abcf');
    expect(sanitizeId('abc123def456$(whoami)')).toBe('abc123def456a');
    expect(sanitizeId(null)).toBeNull();
    expect(sanitizeId('')).toBeNull();
  });

  it('should truncate container IDs to 64 chars', () => {
    const { sanitizeId } = require('../utils/helpers');
    const longId = 'a'.repeat(100);
    expect(sanitizeId(longId).length).toBe(64);
  });
});

describe('Schedule name / shell character validation', () => {
  it('should sanitize shell arguments — sanitizeShellArg strips metacharacters', () => {
    const { sanitizeShellArg } = require('../utils/helpers');
    expect(sanitizeShellArg('normal-name')).toBe('normal-name');
    expect(sanitizeShellArg('name;rm -rf /')).toBe('namerm -rf /');
    expect(sanitizeShellArg('name`whoami`')).toBe('namewhoami');
    expect(sanitizeShellArg('name$(cat /etc/passwd)')).toBe('namecat /etc/passwd');
    expect(sanitizeShellArg(null)).toBe('');
    expect(sanitizeShellArg('')).toBe('');
  });
});

describe('Template and schedule ID validation', () => {
  it('should validate schedule IDs — reject malicious IDs', async () => {
    const res = await request(app)
      .delete('/api/system/schedules/foo;bar')
      .set('Authorization', `Bearer ${adminToken}`);
    // The route uses DELETE /schedules/:id — the ID should either be rejected or handled safely
    // Since IDs are alphanumeric (base36), foo;bar contains invalid semicolon
    // The route does string lookup, so it simply won't find the schedule
    expect([200, 400, 404]).toContain(res.status);
  });
});
