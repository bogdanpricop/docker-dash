'use strict';

process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'test';
process.env.APP_SECRET = 'egress-authorization-test';
process.env.ENCRYPTION_KEY = 'egress-authorization-test-key';
jest.mock('../services/docker', () => ({ getDocker: jest.fn() }));
const request = require('supertest');
const http = require('http');
const { resolveSource, createHandler } = require('../services/egress-authorization');

const id = 'a'.repeat(64);
const otherId = 'b'.repeat(64);
const network = { Networks: { test: { IPAddress: '172.20.0.4' } } };
function fixture() {
  const inspect = { Id: id, State: { Running: true }, NetworkSettings: network,
    HostConfig: { NetworkMode: 'bridge', CapAdd: [] }, Config: { Labels: { 'com.docker.compose.project': 'project-a' } } };
  const docker = {
    listContainers: jest.fn().mockResolvedValue([{ Id: id, NetworkSettings: network }]),
    getContainer: jest.fn().mockReturnValue({ inspect: jest.fn().mockResolvedValue(inspect) }),
  };
  const policy = { id: 1, active: true, scopeType: 'container', scopeKey: id, hostId: 0, mode: 'enforce', allowlist: ['a.example'] };
  return { inspect, docker, policy, options: { docker, policies: () => [policy], matchesHost: host => host === 0 } };
}

describe('live source-scoped egress authorization', () => {
  test('returns only policies belonging to this container and stack on the same host', async () => {
    const { policy, options } = fixture();
    options.policies = () => [policy,
      { ...policy, id: 2, scopeType: 'stack', scopeKey: 'project-a', allowlist: ['*.services.example'] },
      { ...policy, id: 3, scopeKey: otherId, allowlist: ['forbidden.example'] },
      { ...policy, id: 4, hostId: 9, allowlist: ['remote.example'] },
      { ...policy, id: 5, active: false },
      { ...policy, id: 6, scopeType: 'stack', scopeKey: 'project-b' }];
    const result = await resolveSource('::ffff:172.20.0.4', options);
    expect(result.containerId).toBe(id);
    expect(result.source).toBe('172.20.0.4');
    expect(result.policies.map(p => p.id)).toEqual([1, 2]);
    expect(JSON.stringify(result)).not.toMatch(/forbidden|remote/);
  });

  test('supports unambiguous legacy short container IDs', async () => {
    const { policy, options } = fixture();
    policy.scopeKey = id.slice(0, 12);
    expect((await resolveSource('172.20.0.4', options)).policies).toHaveLength(1);
  });

  test.each(['no match', 'duplicate IP', 'ambiguous short ID', 'replaced', 'stopped', 'address changed', 'privileged', 'no policy', 'invalid policy', 'too large'])('%s denies authorization', async scenario => {
    const { inspect, docker, policy, options } = fixture();
    if (scenario === 'no match') docker.listContainers.mockResolvedValue([]);
    if (scenario === 'duplicate IP') docker.listContainers.mockResolvedValue([{ Id: id, NetworkSettings: network }, { Id: otherId, NetworkSettings: network }]);
    if (scenario === 'ambiguous short ID') {
      policy.scopeKey = id.slice(0, 12);
      docker.listContainers.mockResolvedValue([{ Id: id, NetworkSettings: network }, { Id: id.slice(0, 12) + 'c'.repeat(52), NetworkSettings: { Networks: {} } }]);
    }
    if (scenario === 'replaced') inspect.Id = otherId;
    if (scenario === 'stopped') inspect.State.Running = false;
    if (scenario === 'address changed') inspect.NetworkSettings = { Networks: {} };
    if (scenario === 'privileged') inspect.HostConfig.Privileged = true;
    if (scenario === 'no policy') options.policies = () => [];
    if (scenario === 'invalid policy') policy.mode = 'typo';
    if (scenario === 'too large') docker.listContainers.mockResolvedValue(Array(5001).fill({}));
    await expect(resolveSource('172.20.0.4', options)).rejects.toThrow();
  });

  test('does not cache a decision after policy removal or Docker identity loss', async () => {
    const { docker, options } = fixture();
    await resolveSource('172.20.0.4', options);
    options.policies = () => [];
    await expect(resolveSource('172.20.0.4', options)).rejects.toThrow(/No applicable/);
    docker.listContainers.mockRejectedValue(new Error('offline'));
    await expect(resolveSource('172.20.0.4', options)).rejects.toThrow('offline');
  });

  test('resolver protocol rejects malformed input and hides infrastructure errors', async () => {
    const resolve = jest.fn().mockRejectedValue(new Error('sensitive provider URL'));
    const server = http.createServer(createHandler(resolve));
    await request(server).get('/resolve?source=bad').expect(400);
    await request(server).post('/resolve?source=172.20.0.4').expect(400);
    expect(resolve).not.toHaveBeenCalled();
    const response = await request(server).get('/resolve?source=172.20.0.4').expect(403);
    expect(response.text).not.toContain('sensitive');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  test('resolver bounds replies', async () => {
    const server = http.createServer(createHandler(async () => ({ oversized: 'x'.repeat(65537) })));
    await request(server).get('/resolve?source=172.20.0.4').expect(403);
  });

  test('timed-out Docker calls retain concurrency slots until they settle', async () => {
    jest.useFakeTimers();
    try {
      let settle;
      const pending = new Promise(resolve => { settle = resolve; });
      const resolve = jest.fn(() => pending);
      const handler = createHandler(resolve);
      function response() { return { status: 200, setHeader() {}, writeHead(code) { this.status = code; }, end() {} }; }
      const req = { method: 'GET', url: '/resolve?source=172.20.0.4' };
      const started = Array.from({ length: 32 }, () => handler(req, response()));
      await jest.advanceTimersByTimeAsync(3001);
      await Promise.all(started);
      const refused = response();
      await handler(req, refused);
      expect(refused.status).toBe(503);
      expect(resolve).toHaveBeenCalledTimes(32);
      settle({ policies: [] });
      await Promise.resolve(); await Promise.resolve();
      const next = response();
      await handler(req, next);
      expect(next.status).toBe(200);
    } finally { jest.useRealTimers(); }
  });
});
