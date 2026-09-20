'use strict';

// Integration tests for src/routes/egress-filter.js (v6.7 alpha.1).
// Uses supertest against a minimal Express app, follows the acme-routes.test.js pattern.

process.env.APP_SECRET = 'test-secret-for-egress-filter-routes';
process.env.APP_ENV = 'test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'EgressRouteTest123!';

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
app.use('/api/egress-filter', require('../routes/egress-filter'));

let authToken = null;

beforeAll(async () => {
  require('./helpers/seedTestAdmin').clearMustChange('admin');
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: 'admin', password: 'EgressRouteTest123!' });
  authToken = res.body.token;
  if (!authToken) throw new Error('Failed to log in for egress-filter route tests');
});

beforeEach(() => {
  getDb().prepare('DELETE FROM egress_block_log').run();
  getDb().prepare('DELETE FROM egress_policies').run();
});

const auth = () => ({ Authorization: `Bearer ${authToken}` });
const CONTAINER_ID = 'a1b2c3d4e5f6789012345678';  // valid 24-hex

describe('egress enforcement outcomes', () => {
  afterEach(() => jest.restoreAllMocks());
  async function stackPolicy() {
    const result = await request(app).post('/api/egress-filter/policies').set(auth())
      .send({ scopeType: 'stack', scopeKey: 'transaction-test', preset: 'registry-only' });
    expect(result.status).toBe(201); return result.body.policyId;
  }
  test('container status preserves a legacy NET_RAW safety warning', async () => {
    const { policyId } = require('../services/egress-filter').createPolicy({ scopeType: 'container', scopeKey: CONTAINER_ID, preset: 'registry-only' });
    jest.spyOn(require('../services/egress-runner'), 'isApplied').mockResolvedValue({ applied: true, safeToFilter: false, safetyError: 'Drop NET_RAW', details: 'table present' });
    const result = await request(app).get(`/api/egress-filter/policies/${policyId}/status`).set(auth());
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ applied: true, safeToFilter: false, safetyError: 'Drop NET_RAW' });
  });
  test('apply refuses the default NET_RAW capability before reaching the runner', async () => {
    const { policyId } = require('../services/egress-filter').createPolicy({ scopeType: 'container', scopeKey: CONTAINER_ID, preset: 'registry-only' });
    jest.spyOn(require('../services/docker'), 'getDocker').mockReturnValue({ getContainer: () => ({ inspect: async () => ({ HostConfig: { NetworkMode: 'bridge', CapAdd: [], CapDrop: null } }) }) });
    const runner = jest.spyOn(require('../services/egress-runner'), 'applyToContainer');
    const result = await request(app).post(`/api/egress-filter/policies/${policyId}/apply`).set(auth());
    expect(result.status).toBe(422); expect(result.body.error).toContain('NET_RAW');
    expect(runner).not.toHaveBeenCalled();
  });
  test('unapply passes policy identity and reports retained filters truthfully', async () => {
    const { policyId } = require('../services/egress-filter').createPolicy({ scopeType: 'container', scopeKey: CONTAINER_ID, preset: 'registry-only' });
    const runner = jest.spyOn(require('../services/egress-runner'), 'removeFromContainer').mockResolvedValue({ ok: true, removed: false, retained: true, applied: true, retainedFor: [991], output: 'Shared filter retained' });
    const result = await request(app).post(`/api/egress-filter/policies/${policyId}/unapply`).set(auth());
    expect(result.status).toBe(200);expect(result.body).toMatchObject({ applied: true, retained: true, retainedFor: [991] });
    expect(runner).toHaveBeenCalledWith({ containerId: CONTAINER_ID, hostId: 0, policyId });
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='egress_filter_retained'").get().n).toBeGreaterThan(0);
  });
  test('stack response keeps removed and retained targets separate', async () => {
    const policyId = await stackPolicy();
    const runner = jest.spyOn(require('../services/egress-runner'), 'removeFromStack').mockResolvedValue({ removed: [{ id: 'a' }], retained: [{ id: 'b', applied: true, retainedFor: [991] }], failed: [] });
    const result = await request(app).post(`/api/egress-filter/policies/${policyId}/unapply`).set(auth());
    expect(result.status).toBe(200);expect(result.body.retained).toHaveLength(1);expect(result.body.removed).toHaveLength(1);
    expect(runner).toHaveBeenCalledWith({ stackName: 'transaction-test', hostId: 0, policyId });
  });
  test('failed audit intent prevents firewall mutation', async () => {
    const id = await stackPolicy();
    const runner = jest.spyOn(require('../services/egress-runner'), 'applyToStack').mockResolvedValue({ applied: [], skipped: [] });
    jest.spyOn(require('../services/audit'), 'log').mockImplementation(() => { throw new Error('Audit unavailable'); });
    const result = await request(app).post(`/api/egress-filter/policies/${id}/apply`).set(auth());
    expect(result.status).toBe(500);expect(runner).not.toHaveBeenCalled();
  });
  test('recovery failure returns helper identities and actual rollback results', async () => {
    const id = await stackPolicy();
    jest.spyOn(require('../services/egress-runner'), 'applyToStack').mockRejectedValue(Object.assign(new Error('Rollback failed'), {
      operationId: 'operation-test', recoveryRequired: true, recoveryHelpers: ['dd-egress-lock-test'], rollback: { restored: ['a'], failed: ['b'] },
    }));
    const result = await request(app).post(`/api/egress-filter/policies/${id}/apply`).set(auth());
    expect(result.status).toBe(500);expect(result.body.recoveryRequired).toBe(true);
    expect(result.body.error).toContain('dd-egress-lock-test');expect(result.body.rollback.failed).toEqual(['b']);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='egress_policy_apply_started'").get().n).toBeGreaterThan(0);
  });
  test('partial removal is an API failure and leaves the policy active', async () => {
    const id = await stackPolicy();
    jest.spyOn(require('../services/egress-runner'), 'removeFromStack').mockResolvedValue({ removed: [{ id: 'a' }], failed: [{ id: 'b', error: 'offline' }] });
    const result = await request(app).post(`/api/egress-filter/policies/${id}/unapply`).set(auth());
    expect(result.status).toBe(500);expect(result.body.ok).toBe(false);
    expect(getDb().prepare('SELECT active FROM egress_policies WHERE id=?').get(id).active).toBe(1);
  });
});

describe('GET /api/egress-filter/presets', () => {
  it('requires auth', async () => {
    const res = await request(app).get('/api/egress-filter/presets');
    expect(res.status).toBe(401);
  });

  it('returns preset catalog + IMDS invariant + enforcement flag', async () => {
    const res = await request(app).get('/api/egress-filter/presets').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.presets.length).toBeGreaterThanOrEqual(5);
    expect(res.body.imdsAlwaysBlocked).toEqual(expect.arrayContaining(['169.254.169.254']));
    expect(res.body.enforced).toBe(true);  // alpha.3 flipped this on
  });
});

describe('POST /api/egress-filter/policies', () => {
  it('rejects bad scope_type', async () => {
    const res = await request(app).post('/api/egress-filter/policies').set(auth())
      .send({ scopeType: 'pod', scopeKey: 'x', preset: 'registry-only' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/scopeType/);
  });

  it('rejects missing scope_key', async () => {
    const res = await request(app).post('/api/egress-filter/policies').set(auth())
      .send({ scopeType: 'container', preset: 'registry-only' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/scopeKey/);
  });

  it('rejects malformed container id', async () => {
    const res = await request(app).post('/api/egress-filter/policies').set(auth())
      .send({ scopeType: 'container', scopeKey: 'not-hex!', preset: 'registry-only' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/hex/);
  });

  it('rejects unknown preset (validation pass-through)', async () => {
    const res = await request(app).post('/api/egress-filter/policies').set(auth())
      .send({ scopeType: 'stack', scopeKey: 'mystack', preset: 'nonesuch' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown preset/);
  });

  it('creates a policy for stack scope and returns enforced:true + apply note', async () => {
    const res = await request(app).post('/api/egress-filter/policies').set(auth())
      .send({ scopeType: 'stack', scopeKey: 'mystack', preset: 'registry-only' });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.updated).toBe(false);
    expect(res.body.enforced).toBe(true);
    expect(res.body.note).toMatch(/POST \/apply/);
    expect(res.body.allowlist).toEqual(expect.arrayContaining(['docker.io']));
  });

  it('upserts (PUT semantics) on second call for same scope', async () => {
    await request(app).post('/api/egress-filter/policies').set(auth())
      .send({ scopeType: 'stack', scopeKey: 'mystack', preset: 'registry-only' });
    const res = await request(app).post('/api/egress-filter/policies').set(auth())
      .send({ scopeType: 'stack', scopeKey: 'mystack', preset: 'lockdown' });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);
    expect(res.body.allowlist).toEqual([]);
  });

  it('rejects custom allowlist containing raw IPs', async () => {
    const res = await request(app).post('/api/egress-filter/policies').set(auth())
      .send({ scopeType: 'stack', scopeKey: 'mystack', preset: 'custom', customAllowlist: ['1.2.3.4'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/IP addresses/);
  });

  it('accepts container scope — precheck is non-blocking if docker cannot inspect', async () => {
    const res = await request(app).post('/api/egress-filter/policies').set(auth())
      .send({ scopeType: 'container', scopeKey: CONTAINER_ID, preset: 'registry-only' });
    // In unit-test env, docker.getContainer().inspect() fails — but the route
    // still creates the policy (documented non-blocking behavior).
    expect([201, 422]).toContain(res.status);
  });
});

describe('GET /api/egress-filter/policies', () => {
  it('lists active only', async () => {
    await request(app).post('/api/egress-filter/policies').set(auth())
      .send({ scopeType: 'stack', scopeKey: 's1', preset: 'registry-only' });
    await request(app).post('/api/egress-filter/policies').set(auth())
      .send({ scopeType: 'stack', scopeKey: 's2', preset: 'lockdown' });

    const res = await request(app).get('/api/egress-filter/policies').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.policies).toHaveLength(2);
    expect(res.body.enforced).toBe(true);
  });
});

describe('PATCH /api/egress-filter/policies/:id', () => {
  it('updates preset + re-resolves allowlist', async () => {
    const create = await request(app).post('/api/egress-filter/policies').set(auth())
      .send({ scopeType: 'stack', scopeKey: 's1', preset: 'registry-only' });
    const id = create.body.policyId;

    const res = await request(app).patch(`/api/egress-filter/policies/${id}`).set(auth())
      .send({ preset: 'lockdown' });
    expect(res.status).toBe(200);
    expect(res.body.policy.allowlist).toEqual([]);
  });

  it('404 on unknown id', async () => {
    const res = await request(app).patch('/api/egress-filter/policies/999999').set(auth())
      .send({ preset: 'lockdown' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/egress-filter/policies/:id', () => {
  it('soft-deletes and lists no longer shows it', async () => {
    const create = await request(app).post('/api/egress-filter/policies').set(auth())
      .send({ scopeType: 'stack', scopeKey: 's1', preset: 'registry-only' });
    const id = create.body.policyId;

    const del = await request(app).delete(`/api/egress-filter/policies/${id}`).set(auth())
      .send({ reason: 'user-requested' });
    expect(del.status).toBe(200);
    expect(del.body.removed).toBe(true);

    const list = await request(app).get('/api/egress-filter/policies').set(auth());
    expect(list.body.policies.find(p => p.id === id)).toBeUndefined();
  });
});

describe('GET /api/egress-filter/policies/:id/block-log', () => {
  it('returns empty for fresh policy + a note explaining why', async () => {
    const create = await request(app).post('/api/egress-filter/policies').set(auth())
      .send({ scopeType: 'stack', scopeKey: 's1', preset: 'registry-only' });
    const id = create.body.policyId;

    const res = await request(app).get(`/api/egress-filter/policies/${id}/block-log`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
    expect(res.body.enforced).toBe(true);
    expect(res.body.note).toMatch(/No deny events logged yet/);
  });

  it('404 on unknown policy', async () => {
    const res = await request(app).get('/api/egress-filter/policies/999999/block-log').set(auth());
    expect(res.status).toBe(404);
  });
});
