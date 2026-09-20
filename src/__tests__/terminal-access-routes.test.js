'use strict';

process.env.APP_SECRET = 'terminal-access-route-test-secret-32';
process.env.ENCRYPTION_KEY = 'terminal-access-route-test-key-32';
process.env.DB_PATH = ':memory:';

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, res, next) => {
    if (!req.headers['x-test-role']) return res.status(401).json({ error: 'Authentication required' });
    req.user = { id: 1, username: 'route-admin', role: req.headers['x-test-role'] };
    next();
  },
  requireRole: (...roles) => (req, res, next) => roles.includes(req.user.role)
    ? next()
    : res.status(403).json({ error: 'Insufficient permissions' }),
}));

jest.mock('../ws', () => ({
  terminateExecSessions: jest.fn(() => 2),
  getActiveExecSessions: jest.fn(() => ({ count: 2, sessions: [{ username: 'operator' }] })),
}));
jest.mock('../services/audit', () => ({ log: jest.fn() }));
jest.mock('../services/cluster', () => ({ publish: jest.fn(async () => {}) }));

const express = require('express');
const request = require('supertest');
const { getDb, closeDb } = require('../db');
const config = require('../config');
const wsServer = require('../ws');
const audit = require('../services/audit');
const cluster = require('../services/cluster');

const app = express();
app.use(express.json());
app.use('/api/system/terminal-access', require('../routes/terminal-access'));

const auth = role => ({ 'x-test-role': role });

beforeAll(() => {
  getDb().prepare(`
    INSERT OR IGNORE INTO users (id, username, password_hash, role)
    VALUES (1, 'route-admin', 'not-used-in-route-tests', 'admin')
  `).run();
});
afterEach(() => {
  getDb().prepare('DELETE FROM terminal_access_locks').run();
  jest.clearAllMocks();
  wsServer.terminateExecSessions.mockReturnValue(2);
  wsServer.getActiveExecSessions.mockReturnValue({ count: 2, sessions: [{ username: 'operator' }] });
  config.security.terminalAccessOverride = 'managed';
});
afterAll(() => closeDb());

describe('terminal access policy API', () => {
  it('exposes effective state to authenticated users but reserves session details for admins', async () => {
    await request(app).get('/api/system/terminal-access').expect(401);
    const operator = await request(app).get('/api/system/terminal-access').set(auth('operator')).expect(200);
    expect(operator.body.activeSessions).toEqual({ count: 2 });

    const admin = await request(app).get('/api/system/terminal-access').set(auth('admin')).expect(200);
    expect(admin.body.activeSessions.sessions).toHaveLength(1);
  });

  it('locks globally, terminates active sessions, fans out, and audits', async () => {
    await request(app).put('/api/system/terminal-access/global')
      .set(auth('operator')).send({ locked: true }).expect(403);

    const response = await request(app).put('/api/system/terminal-access/global')
      .set(auth('admin')).send({ locked: true, reason: 'Incident 42' }).expect(200);

    expect(response.body.global).toMatchObject({ locked: true, reason: 'Incident 42' });
    expect(response.body.terminatedSessions).toBe(2);
    expect(wsServer.terminateExecSessions).toHaveBeenCalledWith({ hostId: null, reason: 'Incident 42' });
    expect(cluster.publish).toHaveBeenCalledWith('terminal:lock', { hostId: null, reason: 'Incident 42' });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'terminal_access_lock', targetId: 'global',
      details: expect.objectContaining({ terminatedSessions: 2 }),
    }));
  });

  it('requires an explicit boolean and rejects a missing host', async () => {
    await request(app).put('/api/system/terminal-access/global')
      .set(auth('admin')).send({ locked: 'yes' }).expect(400);
    await request(app).put('/api/system/terminal-access/hosts/999999')
      .set(auth('admin')).send({ locked: true }).expect(404);
    expect(wsServer.terminateExecSessions).not.toHaveBeenCalled();
  });

  it('lets recovery mode prepare DB policy without terminating sessions', async () => {
    config.security.terminalAccessOverride = 'allow';
    const response = await request(app).put('/api/system/terminal-access/global')
      .set(auth('admin')).send({ locked: true, reason: 'Prepared during recovery' }).expect(200);
    expect(response.body.global.locked).toBe(true);
    expect(response.body.effective).toMatchObject({ locked: false, source: 'environment_recovery' });
    expect(response.body.terminatedSessions).toBe(0);
    expect(wsServer.terminateExecSessions).not.toHaveBeenCalled();
    expect(cluster.publish).not.toHaveBeenCalled();
  });
});
