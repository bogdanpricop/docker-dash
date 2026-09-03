'use strict';

// v8.95.0 — runtime categorisation and defensive stats parsing.
//
// A runtime's category decides a security verdict, so a mis-file is not
// cosmetic. These pin the anchoring introduced when the loose patterns were
// found to match unrelated names, and the youki reclassification.

const dockerService = require('../services/docker');
const categorize = dockerService._daemon._categorizeRuntimes;

const names = (list) => Object.fromEntries(list.map(n => [n, {}]));

describe('runtime categorisation — wasm', () => {
  it.each([
    'io.containerd.wasmedge.v1',
    'io.containerd.wasmtime.v1',
    'io.containerd.spin.v1',
    'io.containerd.wws.v1',
    'wasmer',
    'crun-wasm',
    'wamr',
  ])('%s is wasm', (name) => {
    expect(categorize(names([name])).wasm).toEqual([name]);
  });
});

describe('runtime categorisation — sandboxed', () => {
  it.each([
    'io.containerd.kata.v2',
    'runsc',
    'io.containerd.gvisor.v1',
    'firecracker',
    'nabla',
  ])('%s is sandboxed', (name) => {
    expect(categorize(names([name])).sandboxed).toEqual([name]);
  });
});

describe('runtime categorisation — standard', () => {
  it.each(['runc', 'crun'])('%s is standard', (name) => {
    expect(categorize(names([name])).standard).toEqual([name]);
  });

  it('youki is standard, not sandboxed', () => {
    // Youki is a runc-equivalent written in Rust, not an extra isolation layer.
    // Filing it as sandboxed inflated the posture picture and, once the ordered
    // class model landed, would have suppressed legitimate findings.
    const r = categorize(names(['youki']));
    expect(r.standard).toEqual(['youki']);
    expect(r.sandboxed).toEqual([]);
  });
});

describe('runtime categorisation — anchoring', () => {
  it.each([
    ['spinnaker', 'spin'],
    ['wwsomething', 'wws'],
    ['my-kata-lookalike-runtime', 'kata'],
  ])('%s does not match the %s pattern by substring', (name) => {
    const r = categorize(names([name]));
    expect(r.wasm).not.toContain(name);
    if (name === 'spinnaker' || name === 'wwsomething') expect(r.standard).toContain(name);
  });

  it('still matches names separated by dots, dashes or underscores', () => {
    expect(categorize(names(['containerd-shim-spin-v1'])).wasm).toEqual(['containerd-shim-spin-v1']);
    expect(categorize(names(['shim_wasmedge_v1'])).wasm).toEqual(['shim_wasmedge_v1']);
  });

  it('sorts each group and tolerates a missing runtimes map', () => {
    const r = categorize(names(['runc', 'crun']));
    expect(r.standard).toEqual(['crun', 'runc']);
    expect(categorize(null)).toEqual({ standard: [], sandboxed: [], wasm: [] });
    expect(categorize(undefined)).toEqual({ standard: [], sandboxed: [], wasm: [] });
  });
});

describe('_parseStats — degrades instead of throwing', () => {
  // Docker does not guarantee full cgroup blocks. A throw here surfaced as
  // "stats collection skipped" and the container silently lost metrics forever.
  it.each([
    ['empty object', {}],
    ['null', null],
    ['undefined', undefined],
    ['cpu_stats only, no cpu_usage', { cpu_stats: {} }],
    ['memory_stats missing', { cpu_stats: { cpu_usage: {} } }],
    ['networks null', { networks: null }],
    ['blkio not an array', { blkio_stats: { io_service_bytes_recursive: 'nope' } }],
  ])('%s returns zeros', (_label, input) => {
    const r = dockerService._parseStats(input);
    expect(r).toMatchObject({ cpuPercent: 0, memUsage: 0, memLimit: 0, memPercent: 0, pids: 0 });
  });

  it('still computes correctly when the full payload is present', () => {
    const r = dockerService._parseStats({
      cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: 2 },
      precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
      memory_stats: { usage: 600, limit: 1000 },
      networks: { eth0: { rx_bytes: 10, tx_bytes: 20 } },
      blkio_stats: { io_service_bytes_recursive: [{ op: 'Read', value: 5 }, { op: 'Write', value: 7 }] },
      pids_stats: { current: 3 },
    });
    expect(r.cpuPercent).toBe(20);       // (100/1000) * 2 * 100
    expect(r.memUsage).toBe(600);
    expect(r.memPercent).toBe(60);
    expect(r.netRx).toBe(10);
    expect(r.blkRead).toBe(5);
    expect(r.blkWrite).toBe(7);
    expect(r.pids).toBe(3);
  });
});
