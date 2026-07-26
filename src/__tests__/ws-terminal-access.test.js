'use strict';

jest.mock('../services/cluster', () => ({
  publish: jest.fn(async () => {}), subscribe: jest.fn(),
  onBecomeLeader: jest.fn(), onBecomeReader: jest.fn(),
  isLeader: jest.fn(async () => true), isHa: jest.fn(() => false), nodeId: jest.fn(() => 'test-node'),
}));

jest.mock('../services/terminal-access', () => ({
  effective: jest.fn(() => ({ locked: false, source: 'managed', hostId: 1, reason: '' })),
  normalizeHostId: jest.fn(value => Number(value)),
}));

jest.mock('../services/docker', () => ({
  inspectContainer: jest.fn(async () => ({ Config: { Labels: { 'com.docker.compose.project': 'demo' } } })),
  createExec: jest.fn(),
}));

jest.mock('../services/permissions', () => ({
  getEffectiveRole: jest.fn(() => 'admin'),
  hasPermission: jest.fn(() => true),
}));

jest.mock('../services/audit', () => ({ log: jest.fn() }));

const { EventEmitter } = require('events');
const docker = require('../services/docker');
const terminalAccess = require('../services/terminal-access');
const wsServer = require('../ws');

function addClient(hostId = null) {
  const ws = { readyState: 1, send: jest.fn() };
  wsServer.clients.set(ws, {
    user: { id: 7, username: 'terminal-admin', role: 'admin' },
    subscriptions: new Set(), logStreams: new Map(),
    msgCount: 0, msgResetTime: Date.now(), isAlive: true,
    execHostId: hostId,
  });
  return ws;
}

function messages(ws, type) {
  return ws.send.mock.calls.map(call => JSON.parse(call[0])).filter(message => !type || message.type === type);
}

describe('WebSocket emergency terminal enforcement', () => {
  afterEach(() => {
    for (const ws of [...wsServer.clients.keys()]) wsServer._cleanupClient(ws);
    jest.clearAllMocks();
    terminalAccess.effective.mockReturnValue({ locked: false, source: 'managed', hostId: 1, reason: '' });
    terminalAccess.normalizeHostId.mockImplementation(value => Number(value));
  });

  it('denies a new admin exec session before Docker is touched', async () => {
    const ws = addClient();
    terminalAccess.effective.mockReturnValue({
      locked: true, source: 'global', hostId: 1, reason: 'Incident response',
    });

    await wsServer.startExec(ws, 'container-1', '/bin/sh', 80, 24, 1);

    expect(docker.inspectContainer).not.toHaveBeenCalled();
    expect(docker.createExec).not.toHaveBeenCalled();
    expect(messages(ws, 'exec:error').at(-1)).toMatchObject({
      code: 'terminal_access_locked', source: 'global', message: 'Incident response',
    });
  });

  it('checks the lock again after the asynchronous permission lookup', async () => {
    const ws = addClient();
    terminalAccess.effective
      .mockReturnValueOnce({ locked: false, source: 'managed', hostId: 1, reason: '' })
      .mockReturnValueOnce({ locked: true, source: 'host', hostId: 1, reason: 'Race closed' });

    await wsServer.startExec(ws, 'container-1', '/bin/sh', 80, 24, 1);

    expect(docker.inspectContainer).toHaveBeenCalledTimes(1);
    expect(docker.createExec).not.toHaveBeenCalled();
    expect(messages(ws, 'exec:error').at(-1).code).toBe('terminal_access_locked');
  });

  it('terminates only matching active sessions and notifies the browser', () => {
    const targetWs = addClient(5);
    const otherWs = addClient(6);
    const targetStream = Object.assign(new EventEmitter(), { write: jest.fn(), destroy: jest.fn() });
    const otherStream = Object.assign(new EventEmitter(), { write: jest.fn(), destroy: jest.fn() });
    Object.assign(wsServer.clients.get(targetWs), {
      execStream: targetStream, exec: {}, execContainerId: 'target', execStartedAt: new Date().toISOString(),
    });
    Object.assign(wsServer.clients.get(otherWs), {
      execStream: otherStream, exec: {}, execContainerId: 'other', execStartedAt: new Date().toISOString(),
    });

    const terminated = wsServer.terminateExecSessions({ hostId: 5, reason: 'Host isolated' });

    expect(terminated).toBe(1);
    expect(targetStream.write).toHaveBeenCalledWith('\x03exit\n');
    expect(targetStream.destroy).toHaveBeenCalled();
    expect(otherStream.destroy).not.toHaveBeenCalled();
    expect(messages(targetWs, 'exec:error').at(-1)).toMatchObject({
      code: 'terminal_access_locked', message: 'Host isolated',
    });
    expect(wsServer.getActiveExecSessions().count).toBe(1);
  });
});
