'use strict';

jest.mock('../services/docker', () => ({ getDocker: jest.fn() }));
jest.mock('../services/ssh-tunnel', () => ({ exec: jest.fn() }));
jest.mock('../services/ai/dgx', () => ({ test: jest.fn() }));
const docker = require('../services/docker');
const ssh = require('../services/ssh-tunnel');
const dgx = require('../services/ai/dgx');
const service = require('../services/dgx-status');

test('Spark metrics use available unified RAM and tolerate unsupported GPU fields', async () => {
  docker.getDocker.mockReturnValue({ info: async () => ({ Architecture: 'aarch64' }) });
  dgx.test.mockResolvedValue({ model: 'local-model', latencyMs: 20 });
  ssh.exec.mockResolvedValue({ stdout: 'NVIDIA GB10, 2, 38\nDGX_MEMINFO\nMemTotal: 1000 kB\nMemAvailable: 700 kB\n', exitCode: 0 });
  const result = await service.status(7);
  expect(result.memory).toEqual({ totalBytes: 1024000, usedBytes: 307200 });
  expect(result.gpu).toEqual({ name: 'NVIDIA GB10', utilizationPercent: 2, temperatureC: 38 });
  expect(result.gateway.available).toBe(true);
  expect(service.number('[N/A]')).toBeNull();
});

test('gateway and metrics failures are reported independently', async () => {
  dgx.test.mockRejectedValue(new Error('Gateway unavailable'));
  ssh.exec.mockRejectedValue(new Error('SSH unavailable'));
  const result = await service.status(7);
  expect(result.gateway.available).toBe(false);
  expect(result.errors).toContain('SSH unavailable');
  expect(result.memory).toBeNull();
});
