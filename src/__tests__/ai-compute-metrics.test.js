'use strict';

process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'test';
const { decode } = require('../services/ai-compute-metrics');
const output = `CPU
cpu  100 0 100 800 0 0 0 0 0 0
MEM
MemTotal: 100000000 kB
MemAvailable: 60000000 kB
SwapTotal: 100 kB
SwapFree: 60 kB
DISK
4000000000000 3000000000000
NET
Inter-| Receive | Transmit
 eth0: 1000 1 0 0 0 0 0 0 2000 2 0 0 0 0 0 0
 lo: 100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0
GPU
NVIDIA GB10, 3, 41, 12.5, [N/A], [N/A]
`;
test('Spark metrics preserve unified RAM, units and unsupported VRAM fields', () => {
  const result = decode(output, { Architecture: 'aarch64', NCPU: 20 });
  expect(result.memory.totalBytes).toBe(102400000000);
  expect(result.memory.usedBytes).toBe(40960000000);
  expect(result.memory.swapUsedBytes).toBe(40960);
  expect(result.gpu).toEqual({ name: 'NVIDIA GB10', utilizationPercent: 3, temperatureC: 41, powerWatts: 12.5, totalBytes: null, usedBytes: null });
  expect(result.cpuPercent).toBeNull();
  expect(result.network.rxBytes).toBe(1000);
  expect(result.network.rxBytesPerSecond).toBeNull();
});
test('CPU uses delta counters, and failed prior samples do not break recovery', () => {
  const previous = { cpuTotal: 900, cpuIdle: 720, sampledAt: new Date(Date.now() - 10000).toISOString() };
  expect(decode(output, {}, previous).cpuPercent).toBeCloseTo(20);
  expect(decode(output, {}, { sampledAt: previous.sampledAt }).network.rxBytesPerSecond).toBeNull();
});
test('missing host fields never produce fabricated zero-valued metrics', () => {
  const result = decode('', {});
  expect(result.memory).toBeNull(); expect(result.gpu).toBeNull(); expect(result.disk).toBeNull(); expect(result.cpuPercent).toBeNull();
});
