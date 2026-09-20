'use strict';

const { Readable } = require('node:stream');
process.env.APP_ENV = 'test';
process.env.APP_SECRET = 'egress-runner-test-secret';
process.env.DB_PATH = ':memory:';
jest.mock('../services/docker', () => ({ getDocker: jest.fn() }));
const dockerService = require('../services/docker');
const runner = require('../services/egress-runner');
const nft = require('../services/egress-nft');
const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);
let docker, targets, helpers, events, failure;

function frame(text, type = 1) {
  const payload = Buffer.from(text), header = Buffer.alloc(8);
  header[0] = type; header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

beforeEach(() => {
  process.env.DD_EGRESS_SIDECAR_ENDPOINT = '172.17.0.99:29193';
  targets = new Map([A, B, C].map((Id, n) => [Id, { Id, Name: '/service-' + n,
    State: { Running: true, StartedAt: '2026-09-20T00:00:00Z', Pid: n + 100 },
    HostConfig: { NetworkMode: 'bridge', CapDrop: ['ALL'] }, Config: { Labels: { 'com.docker.compose.project': 'test-stack' } } }]));
  helpers = []; events = []; failure = () => false;
  docker = {
    getContainer: jest.fn(id => ({ inspect: jest.fn(async () => {
      const target = targets.get([...targets.keys()].find(k => k.startsWith(id)));
      if (!target) throw Object.assign(new Error('not found'), { statusCode: 404 });
      return JSON.parse(JSON.stringify(target));
    }) })),
    listContainers: jest.fn(async () => [...targets.values()].map(t => ({ Id: t.Id, Names: [t.Name], State: 'running' }))),
    createContainer: jest.fn(async opts => {
      const target = opts.Labels['com.docker-dash.egress-target'];
      const helper = { opts, target, start: jest.fn(async () => {}), stop: jest.fn(async () => {}), remove: jest.fn(async () => {}),
        exec: jest.fn(async ({ Cmd }) => {
          const script = Cmd[2];
          const operation = script.includes('command -v nft') ? 'prepare'
            : script.includes('DD_PRESENT') ? 'snapshot' : script.includes('DD_RULESET') ? 'apply'
              : script.includes('dd-restore.nft') ? 'restore' : 'remove';
          events.push({ target, operation });
          const fail = failure(target, operation);
          return { start: jest.fn(async () => Readable.from([frame(operation === 'snapshot' ? 'DD_PRESENT\n' : '')])),
            inspect: jest.fn(async () => ({ Running: false, ExitCode: fail === 'unknown' ? null : fail ? 1 : 0 })) };
        }) };
      helpers.push(helper); return helper;
    }),
  };
  dockerService.getDocker.mockReturnValue(docker);
});

describe('configuration and target validation', () => {
  test('defaults to the prebuilt helper rather than installing packages in each target', () => {
    expect(runner._internals.HELPER_IMAGE).toBe('docker-dash-egress-helper:local');
  });
  test.each(['', 'host:80', '999.1.2.3:80', '1.2.3.4:0', '1.2.3.4:65536', '1.2.3.4:80:90', '1.2.3.4:80;id'])('rejects endpoint %s before creating helpers', async value => {
    process.env.DD_EGRESS_SIDECAR_ENDPOINT = value;
    await expect(runner.applyToContainer({ containerId: A })).rejects.toThrow(/DD_EGRESS_SIDECAR_ENDPOINT/);
    expect(docker.createContainer).not.toHaveBeenCalled();
  });
  test('refuses NET_RAW before helper creation but permits status and cleanup', async () => {
    targets.get(A).HostConfig.CapDrop = [];
    await expect(runner.applyToContainer({ containerId: A })).rejects.toThrow(/NET_RAW/);
    expect(docker.createContainer).not.toHaveBeenCalled();
    await expect(runner.isApplied({ containerId: A })).resolves.toMatchObject({ safeToFilter: false, safetyError: expect.stringContaining('NET_RAW') });
    await expect(runner.removeFromContainer({ containerId: A })).resolves.toMatchObject({ ok: true });
  });
  test('one unsafe stack member prevents every mutation', async () => {
    targets.get(B).HostConfig.CapDrop = [];
    await expect(runner.applyToStack({ stackName: 'test-stack' })).rejects.toThrow(/NET_RAW/);
    expect(docker.createContainer).not.toHaveBeenCalled();
  });
  test('validates direct script builder input too', () => {
    expect(() => nft.applyScript('1.2.3.4;id', 80)).toThrow();
    expect(() => nft.applyScript('1.2.3.4', 70000)).toThrow();
  });
  test('canonicalizes short IDs before namespace selection and reservation', async () => {
    await runner.applyToContainer({ containerId: A.slice(0, 12), hostId: 7 });
    expect(helpers[0].opts.name).toBe('dd-egress-lock-' + A);
    expect(helpers[0].opts.HostConfig.NetworkMode).toBe('container:' + A);
    expect(helpers[0].opts.HostConfig.CapDrop).toEqual(['ALL']);
    expect(helpers[0].opts.HostConfig.CapAdd).toEqual(['NET_ADMIN']);
    expect(helpers[0].opts.Entrypoint).toEqual(['/bin/sh']);
    expect(dockerService.getDocker).toHaveBeenCalledWith(7);
  });
  test.each(['host', 'privileged', 'stopped'])('refuses unsafe target %s through service API', async kind => {
    if (kind === 'host') targets.get(A).HostConfig.NetworkMode = 'host';
    if (kind === 'privileged') targets.get(A).HostConfig.Privileged = true;
    if (kind === 'stopped') targets.get(A).State.Running = false;
    await expect(runner.removeFromContainer({ containerId: A })).rejects.toThrow();
    expect(docker.createContainer).not.toHaveBeenCalled();
  });
});

describe('transaction orchestration', () => {
  test('prune blocks egress before starting a helper or snapshotting firewall state', async () => {
    const lookup = docker.getContainer.getMockImplementation();
    docker.getContainer.mockImplementation(id => id === 'dd-maintenance-prune-lock'
      ? { inspect: async () => ({ Id: 'prune-reservation' }) } : lookup(id));
    await expect(runner.applyToContainer({ containerId: A })).rejects.toMatchObject({ status: 409 });
    expect(events).toEqual([]); expect(helpers[0].start).not.toHaveBeenCalled();
    expect(helpers[0].remove).toHaveBeenCalledTimes(1);
  });
  test('all snapshots precede all mutations and helpers are removed after success', async () => {
    const result = await runner.applyToStack({ stackName: 'test-stack' });
    expect(result.applied).toHaveLength(3);
    expect(events.slice(0, 6).map(e => e.operation)).toEqual(['prepare', 'prepare', 'prepare', 'snapshot', 'snapshot', 'snapshot']);
    expect(helpers.every(h => h.remove.mock.calls.length === 1)).toBe(true);
  });
  test('snapshot failure changes no rules', async () => {
    failure = (id, operation) => id === B && operation === 'snapshot';
    await expect(runner.applyToStack({ stackName: 'test-stack' })).rejects.toThrow(/exited 1/);
    expect(events.some(e => e.operation === 'apply')).toBe(false);
  });
  test('failed second apply restores both attempted snapshots, never removes old filters', async () => {
    failure = (id, operation) => id === B && operation === 'apply';
    await expect(runner.applyToStack({ stackName: 'test-stack' })).rejects.toMatchObject({ rollback: { restored: [B, A], failed: [] } });
    expect(events.filter(e => e.operation === 'restore').map(e => e.target)).toEqual([B, A]);
    expect(events.some(e => e.operation === 'remove')).toBe(false);
    expect(events.some(e => e.target === C && e.operation === 'apply')).toBe(false);
  });
  test('rollback failure retains and stops only affected helper, reports actual recovery', async () => {
    failure = (id, operation) => (id === B && operation === 'apply') || (id === A && operation === 'restore');
    await expect(runner.applyToStack({ stackName: 'test-stack' })).rejects.toMatchObject({
      recoveryRequired: true, recoveryHelpers: ['dd-egress-lock-' + A], rollback: { restored: [B], failed: [A] },
    });
    expect(helpers[0].remove).not.toHaveBeenCalled(); expect(helpers[0].stop).toHaveBeenCalledWith({ t: 0 });
    expect(helpers[1].remove).toHaveBeenCalled();
  });
  test('reservation conflict cannot modify rules or remove the competing helper', async () => {
    docker.createContainer.mockRejectedValueOnce(Object.assign(new Error('already exists'), { statusCode: 409 }));
    await expect(runner.applyToContainer({ containerId: A })).rejects.toThrow(/already holds/);
    expect(events).toEqual([]);
  });
  test('missing helper image reports setup failure without claiming a recovery reservation', async () => {
    docker.createContainer.mockRejectedValueOnce(Object.assign(new Error('No such image'), { statusCode: 404 }));
    await expect(runner.applyToContainer({ containerId: A })).rejects.toMatchObject({
      message: expect.stringContaining('DD_EGRESS_HELPER_IMAGE'), recoveryRequired: false, recoveryHelpers: [],
    });
    expect(events).toEqual([]);
  });
  test('unknown apply outcome stops and retains helper instead of racing a rollback', async () => {
    failure = (_id, operation) => operation === 'apply' ? 'unknown' : false;
    await expect(runner.applyToContainer({ containerId: A })).rejects.toMatchObject({
      recoveryRequired: true, rollback: { restored: [], failed: [A] }, recoveryHelpers: ['dd-egress-lock-' + A],
    });
    expect(events.some(e => e.operation === 'restore')).toBe(false);
    expect(helpers[0].stop).toHaveBeenCalled();expect(helpers[0].remove).not.toHaveBeenCalled();
  });
  test('changed stack membership aborts before helper creation', async () => {
    targets.get(B).Config.Labels['com.docker.compose.project'] = 'other';
    await expect(runner.applyToStack({ stackName: 'test-stack' })).rejects.toThrow(/membership/);
    expect(docker.createContainer).not.toHaveBeenCalled();
  });
  test('target restart during apply triggers restoration and refuses success', async () => {
    failure = (id, operation) => { if (operation === 'apply') targets.get(id).State.StartedAt = 'changed'; return false; };
    await expect(runner.applyToContainer({ containerId: A })).rejects.toMatchObject({ rollback: { restored: [A], failed: [] } });
  });
  test('cleanup failure is recovery-required, not successful apply', async () => {
    failure = () => { helpers[0].remove.mockRejectedValue(new Error('offline')); return false; };
    await expect(runner.applyToContainer({ containerId: A })).rejects.toMatchObject({ recoveryRequired: true, recoveryHelpers: ['dd-egress-lock-' + A] });
  });
  test('status query failure is unknown rather than unfiltered', async () => {
    failure = (id, operation) => id === A && operation === 'snapshot';
    const status = await runner.statusOfStack({ stackName: 'test-stack' });
    expect(status.containers.find(c => c.id === A).applied).toBeNull();
    expect(status.appliedCount).toBe(2);
  });
});

describe('bounded Docker output and deadlines', () => {
  test('decodes fragmented and coalesced stdout/stderr frames with UTF-8 intact', async () => {
    const input = Buffer.concat([frame('first €'), frame('second', 2)]);
    expect(await runner._internals.readOutput(Readable.from([input.subarray(0, 3), input.subarray(3, 17), input.subarray(17)]))).toBe('first €second');
  });
  test.each([Buffer.from([1, 0]), frame('ok').subarray(0, 9), Buffer.from('invalid!')])('rejects malformed or truncated frames', async input => {
    await expect(runner._internals.readOutput(Readable.from([input]))).rejects.toThrow();
  });
  test('caps combined output', async () => {
    await expect(runner._internals.readOutput(Readable.from([frame('x'.repeat(128 * 1024))]))).rejects.toThrow(/limit/);
  });
  test('deadline terminates an unresolved observation', async () => {
    await expect(runner._internals.bounded(new Promise(() => {}), 5)).rejects.toMatchObject({ uncertain: true });
  });
});


describe('overlapping policy removal', () => {
  const filter = require('../services/egress-filter');
  const selected = { id: 10, active: true, scopeType: 'container', scopeKey: A, hostId: 0 };
  function policies(rows) {
    jest.spyOn(filter, 'listPolicies').mockReturnValue(rows);
    jest.spyOn(filter, 'getPolicy').mockImplementation(id => rows.find(p => p.id === id));
  }
  afterEach(() => jest.restoreAllMocks());
  test('keeps the shared table for an overlapping stack policy', async () => {
    policies([selected, { ...selected, id: 11, scopeType: 'stack', scopeKey: 'test-stack' }]);
    const result = await runner.removeFromContainer({ containerId: A, policyId: 10 });
    expect(result).toMatchObject({ removed: false, retained: true, applied: true, retainedFor: [11] });
    expect(events.some(e => e.operation === 'remove')).toBe(false);
    expect(helpers[0].remove).toHaveBeenCalled();
  });
  test('retains only stack members that have another container policy', async () => {
    policies([{ ...selected, scopeType: 'stack', scopeKey: 'test-stack' }, { ...selected, id: 11, scopeKey: B.slice(0, 12) }]);
    const result = await runner.removeFromStack({ stackName: 'test-stack', policyId: 10 });
    expect(result.retained).toEqual([{ id: B, name: 'service-1', applied: true, retainedFor: [11] }]);
    expect(result.removed.map(c => c.id)).toEqual([A, C]);
    expect(events.filter(e => e.operation === 'remove').map(e => e.target)).toEqual([A, C]);
  });
  test('does not ignore audit-only policies or a short-ID policy', async () => {
    policies([selected, { ...selected, id: 11, scopeKey: A.slice(0, 12), mode: 'audit-only' }]);
    expect((await runner.removeFromContainer({ containerId: A, policyId: 10 })).retainedFor).toEqual([11]);
  });
  test('ignores inactive, unrelated-container, unrelated-stack and remote-host policies', async () => {
    policies([selected, { ...selected, id: 11, active: false }, { ...selected, id: 12, scopeKey: B },
      { ...selected, id: 13, scopeType: 'stack', scopeKey: 'other' }, { ...selected, id: 14, hostId: 912 }]);
    expect(await runner.removeFromContainer({ containerId: A, policyId: 10 })).toMatchObject({ removed: true, applied: false, retained: false });
  });
  test('direct removal without a policy identity protects all active policies', async () => {
    policies([selected]);
    expect((await runner.removeFromContainer({ containerId: A })).retainedFor).toEqual([10]);
    expect(events.some(e => e.operation === 'remove')).toBe(false);
  });
  test.each([99, 0, '10'])('refuses invalid or missing selected policy %j', async policyId => {
    policies([selected]);
    await expect(runner.removeFromContainer({ containerId: A, policyId })).rejects.toThrow(/policy/);
    expect(events.some(e => e.operation === 'remove')).toBe(false);
  });
  test('refuses excluding a policy for a different container', async () => {
    policies([{ ...selected, scopeKey: B }]);
    await expect(runner.removeFromContainer({ containerId: A, policyId: 10 })).rejects.toThrow(/does not cover/);
    expect(events.some(e => e.operation === 'remove')).toBe(false);
  });
  test('policy lookup happens after acquiring the daemon reservation and snapshot', async () => {
    policies([selected]);
    filter.listPolicies.mockImplementation(() => {
      expect(helpers).toHaveLength(1);
      expect(events.some(e => e.operation === 'snapshot')).toBe(true);
      return [selected, { ...selected, id: 11, scopeType: 'stack', scopeKey: 'test-stack' }];
    });
    expect((await runner.removeFromContainer({ containerId: A, policyId: 10 })).retained).toBe(true);
  });
  test('database failure cannot remove an existing shared table', async () => {
    policies([selected]);filter.listPolicies.mockImplementation(() => { throw new Error('Policy database unavailable'); });
    await expect(runner.removeFromContainer({ containerId: A, policyId: 10 })).rejects.toThrow(/database/);
    expect(events.some(e => e.operation === 'remove')).toBe(false);
  });
});
