'use strict';

const { Readable } = require('node:stream');
jest.mock('../utils/docker-log-reader', () => ({ readLogSnapshot: jest.fn() }));
const { readLogSnapshot } = require('../utils/docker-log-reader');
const { preview, analyze } = require('../services/ai/features/dgx-container-diagnostics');
const response = data => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(data) } }] });
const config = { model: 'local-model' };
const inspect = { Id: 'container-123', RestartCount: 3, HostConfig: { Memory: 536870912 }, Config: { Env: ['SECRET=do-not-send'], Healthcheck: { Test: ['CMD-SHELL', 'curl http://localhost/health'], Retries: 3 } },
  State: { Status: 'running', OOMKilled: false, Health: { Status: 'unhealthy', Log: [{ End: '2026-11-17T12:01:00Z', ExitCode: 1, Output: 'endpoint missing' }] } } };
const docker = () => ({ getContainer: jest.fn(() => ({ inspect: async () => inspect })), getEvents: jest.fn(async () => Readable.from([JSON.stringify({ time: 1794916800, Action: 'health_status: unhealthy' }) + '\n'])) });
beforeEach(() => { readLogSnapshot.mockResolvedValue({ entries: [{ timestamp: '2026-11-17T12:01:00Z', stream: 'stderr', line: 'PASSWORD=hidden-secret-value application failed' }], truncated: false }); });

test('preview correlates health command, failed result, logs, restart count and events and redacts secrets', async () => {
  const snapshot = await preview(docker(), 'container-123', 'operator-host-container');
  expect(snapshot.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'S1', restartCount: 3 }), expect.objectContaining({ id: 'H0', kind: 'health_command' }), expect.objectContaining({ id: 'H1', exitCode: 1 }), expect.objectContaining({ id: 'L1' }), expect.objectContaining({ id: 'E1' })]));
  expect(JSON.stringify(snapshot)).not.toMatch(/hidden-secret-value|do-not-send/);
  const request = jest.fn(async () => response({ summary: 'Health endpoint failed.', findings: [{ explanation: 'H1 failed after startup.', evidenceIds: ['H0', 'H1', 'E1'], nextCheck: 'review_health_command' }] }));
  const result = await analyze(snapshot.token, 'operator-host-container', config, request);
  expect(result.evidence).toEqual(snapshot.evidence);
  expect(result.payloadHash).toMatch(/^[a-f0-9]{64}$/);
  expect(request.mock.calls[0][2].messages[1].content).not.toMatch(/hidden-secret-value/);
});

test('rejects reused preview on another host or user and refuses invented model evidence', async () => {
  const snapshot = await preview(docker(), 'container-123', 'scope-a');
  const request = jest.fn();
  await expect(analyze(snapshot.token, 'scope-b', config, request)).rejects.toMatchObject({ status: 409 });
  expect(request).not.toHaveBeenCalled();
  await expect(analyze(snapshot.token, 'scope-a', config, async () => response({ summary: 'Failure', findings: [{ explanation: 'invented', evidenceIds: ['L999'], nextCheck: 'review_health_command' }] }))).rejects.toThrow('outside the supplied evidence');
});

test('returns partial evidence when logs and events unavailable and rejects expired snapshots', async () => {
  const client = docker();client.getEvents.mockRejectedValue(new Error('unsupported'));
  readLogSnapshot.mockRejectedValue(new Error('no log driver'));
  const snapshot = await preview(client, 'container-123', 'scope');
  expect(snapshot.warnings).toHaveLength(2);
  const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 301000);
  await expect(analyze(snapshot.token, 'scope', config, jest.fn())).rejects.toMatchObject({ status: 409 });
  now.mockRestore();
});


test('bounds noisy container evidence before preview and sends that exact bounded snapshot to the model', async () => {
  readLogSnapshot.mockResolvedValue({ entries: Array.from({ length: 100 }, (_, i) => ({ timestamp: '2026-11-17T12:01:00Z', stream: 'stderr', line: 'Error ' + i + ' ' + 'noisy application detail '.repeat(100) })), truncated: true });
  const snapshot = await preview(docker(), 'container-123', 'noisy-scope');
  expect(JSON.stringify(snapshot.evidence).length).toBeLessThanOrEqual(6000);
  expect(snapshot.warnings.join(' ')).toMatch(/shortened/);
  expect(snapshot.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'S1' }), expect.objectContaining({ id: 'H0' }), expect.objectContaining({ id: 'H1' })]));
  const request = jest.fn(async () => response({ summary: 'Logs show application errors.', findings: [] }));
  await analyze(snapshot.token, 'noisy-scope', config, request);
  expect(request.mock.calls[0][2].messages[1].content).toBe(JSON.stringify(snapshot.evidence));
  expect(request.mock.calls[0][2].max_tokens).toBe(1000);
});
