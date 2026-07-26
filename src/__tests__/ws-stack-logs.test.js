'use strict';

jest.mock('../services/cluster', () => ({
  publish: jest.fn(async () => {}), subscribe: jest.fn(),
  onBecomeLeader: jest.fn(), onBecomeReader: jest.fn(),
  isLeader: jest.fn(async () => true), isHa: jest.fn(() => false), nodeId: jest.fn(() => 'test-node'),
}));

jest.mock('../services/host-permissions', () => ({
  resolveEffectivePermission: jest.fn(() => 'view'),
}));

jest.mock('../services/permissions', () => ({
  getEffectiveRole: jest.fn((_userId, _stack, role) => role === 'viewer' ? 'view' : role),
  hasPermission: jest.fn((role, required) => {
    const levels = { none: 0, view: 1, operate: 2, admin: 3 };
    return levels[role] >= levels[required];
  }),
}));

jest.mock('../services/docker', () => {
  const { EventEmitter } = require('events');
  const streams = new Map();
  const logs = jest.fn(async (_options, containerId) => {
    const stream = new EventEmitter();
    stream.destroy = jest.fn(() => stream.emit('close'));
    streams.set(containerId, stream);
    return stream;
  });
  return {
    _logStreams: streams,
    _logs: logs,
    inspectContainer: jest.fn(async id => ({
      id, labels: { 'com.docker.compose.project': 'demo' },
    })),
    getDocker: jest.fn(() => ({
      getContainer: containerId => ({ logs: options => logs(options, containerId) }),
    })),
  };
});

const dockerService = require('../services/docker');
const hostPermissions = require('../services/host-permissions');
const wsServer = require('../ws');

function makeClient(role = 'admin') {
  const ws = { readyState: 1, send: jest.fn() };
  wsServer.clients.set(ws, {
    user: { id: 9, username: `log-${role}`, role },
    subscriptions: new Set(), logStreams: new Map(),
    msgCount: 0, msgResetTime: Date.now(), isAlive: true,
  });
  return ws;
}

function messages(ws, type) {
  return ws.send.mock.calls
    .map(call => JSON.parse(call[0]))
    .filter(message => !type || message.type === type);
}

describe('multiplexed stack log WebSocket protocol', () => {
  afterEach(() => {
    for (const ws of [...wsServer.clients.keys()]) wsServer._cleanupClient(ws);
    dockerService._logStreams.clear();
    jest.clearAllMocks();
    hostPermissions.resolveEffectivePermission.mockReturnValue('view');
  });

  it('subscribes to multiple containers and tags each output event', async () => {
    const ws = makeClient();
    await wsServer._handleMessage(ws, Buffer.from(JSON.stringify({
      type: 'logs:subscribe-many', containerIds: ['one', 'two'], hostId: 0, tail: 0,
    })));

    const client = wsServer.clients.get(ws);
    expect(client.logStreams.size).toBe(2);
    expect(dockerService._logs).toHaveBeenCalledTimes(2);
    expect(dockerService._logs).toHaveBeenCalledWith(expect.objectContaining({ tail: 0, follow: true }), 'one');

    dockerService._logStreams.get('two').emit('data', Buffer.from('hello from two\n'));
    const event = messages(ws, 'logs:data').at(-1);
    expect(event).toMatchObject({
      containerId: 'two', lines: ['hello from two\n'],
      data: { containerId: 'two', lines: ['hello from two\n'] },
    });
  });

  it('reassembles a Docker multiplex frame split across chunks', async () => {
    const ws = makeClient();
    await wsServer._handleMessage(ws, Buffer.from(JSON.stringify({
      type: 'logs:subscribe-many', containerIds: ['one'], hostId: 0,
    })));
    const payload = Buffer.from('split frame\n');
    const header = Buffer.alloc(8);
    header[0] = 1;
    header.writeUInt32BE(payload.length, 4);
    const frame = Buffer.concat([header, payload]);
    const stream = dockerService._logStreams.get('one');

    stream.emit('data', frame.slice(0, 6));
    expect(messages(ws, 'logs:data')).toHaveLength(0);
    stream.emit('data', frame.slice(6));

    expect(messages(ws, 'logs:data').at(-1)).toMatchObject({
      containerId: 'one', lines: ['split frame\n'],
    });
  });

  it('unsubscribes one stream or all streams and destroys them', async () => {
    const ws = makeClient();
    await wsServer._handleMessage(ws, Buffer.from(JSON.stringify({
      type: 'logs:subscribe-many', containerIds: ['one', 'two'], hostId: 0,
    })));
    const one = dockerService._logStreams.get('one');
    const two = dockerService._logStreams.get('two');

    await wsServer._handleMessage(ws, Buffer.from(JSON.stringify({
      type: 'logs:unsubscribe', containerId: 'one',
    })));
    expect(one.destroy).toHaveBeenCalled();
    expect(wsServer.clients.get(ws).logStreams.has('one')).toBe(false);
    expect(wsServer.clients.get(ws).logStreams.has('two')).toBe(true);

    await wsServer._handleMessage(ws, Buffer.from(JSON.stringify({ type: 'logs:unsubscribe' })));
    expect(two.destroy).toHaveBeenCalled();
    expect(wsServer.clients.get(ws).logStreams.size).toBe(0);
  });

  it('limits fan-out and fails closed when host access is missing', async () => {
    const adminWs = makeClient();
    await wsServer._handleMessage(adminWs, Buffer.from(JSON.stringify({
      type: 'logs:subscribe-many', containerIds: Array.from({ length: 26 }, (_, i) => `c${i}`),
    })));
    expect(messages(adminWs, 'logs:error').at(-1).error).toMatch(/1 and 25/);

    const viewerWs = makeClient('viewer');
    hostPermissions.resolveEffectivePermission.mockReturnValue(null);
    await wsServer._handleMessage(viewerWs, Buffer.from(JSON.stringify({
      type: 'logs:subscribe-many', containerIds: ['secret'], hostId: 4,
    })));
    expect(messages(viewerWs, 'logs:error').at(-1)).toMatchObject({
      containerId: 'secret', error: 'Insufficient permissions for container logs',
    });
    expect(wsServer.clients.get(viewerWs).logStreams.size).toBe(0);
  });
});
