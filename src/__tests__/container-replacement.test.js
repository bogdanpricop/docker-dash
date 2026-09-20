'use strict';

Object.assign(process.env, { APP_ENV: 'test', DB_PATH: ':memory:', ENCRYPTION_KEY: 'test-encryption-key-for-jest-32chars' });
const { getDb } = require('../db');
const { replace, verify, LABEL } = require('../services/container-replacement');
const { options, imageReference } = require('../utils/container-config');
const { readSnapshot } = require('../utils/history-snapshot');
const daemon = require('./helpers/replacement-daemon');
let fixture, input;
beforeEach(async () => {
  getDb().exec('DELETE FROM container_replacements; DELETE FROM container_image_history');
  fixture = daemon();
  input = { docker: fixture.docker, inspect: await fixture.old.inspect(), imageId: 'sha256:' + 'b'.repeat(64),
    hostId: 42, action: 'test-update', username: 'test', verification: { stabilizeMs: 0, intervalMs: 1, timeoutMs: 10 } };
});
const journal = () => getDb().prepare('SELECT * FROM container_replacements ORDER BY rowid DESC LIMIT 1').get();

test('original is retained through verification and transactional audit; volumes are never removed', async () => {
  const result = await replace({ ...input, commit: (id, operationId) => {
    expect(fixture.states.has('old-container')).toBe(true);
    expect(fixture.states.get(id).State.Running).toBe(true);
    expect(journal().id).toBe(operationId);
  } });
  expect(result.cleanupRequired).toBe(false); expect(journal().phase).toBe('complete');
  expect(fixture.states.size).toBe(1); expect(fixture.old.remove).toHaveBeenCalledWith({ v: false });
  expect(imageReference(await fixture.handles.get(result.id).inspect())).toBe('example/app:mutable');
  const row = getDb().prepare('SELECT * FROM container_image_history WHERE id=?').get(journal().history_id);
  expect(readSnapshot(row).Healthcheck).toEqual(input.inspect.Config.Healthcheck);
});

test.each(['create', 'start', 'health', 'inspect', 'audit', 'commit-marker', 'rename', 'stop', 'disconnect'])('failure in %s restores the same original ID and restart policy', async point => {
  input.inspect.NetworkSettings.Networks.custom = { IPAMConfig: { IPv4Address: '172.20.0.22' }, Aliases: ['app', 'old-container'] };
  fixture.initial.NetworkSettings = JSON.parse(JSON.stringify(input.inspect.NetworkSettings));
  const create = fixture.docker.createContainer.getMockImplementation();
  fixture.docker.createContainer.mockImplementation(async opts => {
    if (opts.name === 'old' && point === 'create') throw new Error('create failed');
    const handle = await create(opts);
    if (opts.name === 'old') {
      if (point === 'start') handle.start.mockRejectedValueOnce(new Error('start failed'));
      if (point === 'health') fixture.states.get(handle.id).State.Health.Status = 'unhealthy';
      if (point === 'inspect') handle.inspect.mockRejectedValueOnce(new Error('inspect failed'));
    }
    return handle;
  });
  if (point === 'audit') input.commit = () => { throw new Error('audit failed'); };
  if (point === 'commit-marker') getDb().exec("CREATE TEMP TRIGGER reject_commit BEFORE UPDATE OF phase ON container_replacements WHEN NEW.phase='committed' BEGIN SELECT RAISE(FAIL, 'disk fault'); END");
  if (point === 'rename') fixture.old.rename.mockRejectedValueOnce(new Error('rename failed'));
  if (point === 'stop') fixture.old.stop.mockRejectedValueOnce(new Error('stop failed'));
  if (point === 'disconnect') fixture.docker.getNetwork('custom').disconnect.mockRejectedValueOnce(new Error('disconnect failed'));
  try {
    await expect(replace(input)).rejects.toMatchObject({ recovered: true });
    const restored = await fixture.old.inspect();
    expect(restored.Name).toBe('/old'); expect(restored.State.Running).toBe(true);
    expect(restored.HostConfig.RestartPolicy.Name).toBe('unless-stopped');
    expect(restored.NetworkSettings.Networks.custom.IPAMConfig.IPv4Address).toBe('172.20.0.22');
    expect(fixture.old.remove).not.toHaveBeenCalled(); expect(fixture.states.size).toBe(1);
    expect(journal().phase).toBe('recovered');
  } finally { getDb().exec('DROP TRIGGER IF EXISTS reject_commit'); }
});

test('commit failure rolls back required database changes with the commit marker', async () => {
  await expect(replace({ ...input, commit: () => {
    getDb().prepare("INSERT INTO settings(key,value) VALUES ('replacement-test-marker','written')").run();
    throw new Error('audit write failed');
  } })).rejects.toMatchObject({ recovered: true });
  expect(getDb().prepare("SELECT * FROM settings WHERE key='replacement-test-marker'").get()).toBeUndefined();
});

test('failed recovery retains the original and daemon lock for explicit intervention', async () => {
  fixture.old.start.mockRejectedValue(new Error('daemon unavailable'));
  await expect(replace({ ...input, commit: () => { throw new Error('audit failed'); } })).rejects.toMatchObject({ status: 503 });
  expect(journal().phase).toBe('recovery_required'); expect(fixture.states.size).toBe(2);
  expect(fixture.old.remove).not.toHaveBeenCalled();
});

test('cleanup failure preserves the verified candidate, original and lock', async () => {
  fixture.old.remove.mockRejectedValue(new Error('busy'));
  expect(await replace(input)).toMatchObject({ cleanupRequired: true, id: 'new-container' });
  expect(journal().phase).toBe('cleanup_required'); expect(fixture.states.size).toBe(3);
  expect(fixture.states.get('new-container').State.Running).toBe(true);
});

test('lost create response is reconciled by the operation label before recovery', async () => {
  const create = fixture.docker.createContainer.getMockImplementation();
  fixture.docker.createContainer.mockImplementation(async opts => {
    const handle = await create(opts);
    if (opts.name === 'old') throw new Error('response lost');
    return handle;
  });
  await expect(replace(input)).rejects.toMatchObject({ recovered: true });
  expect(fixture.states.size).toBe(1); expect(fixture.old.remove).not.toHaveBeenCalled();
});

test('competing writers on the same daemon cannot mutate the original', async () => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const paused = new Promise(resolve => { release = resolve; });
  const stop = fixture.old.stop.getMockImplementation();
  fixture.old.stop.mockImplementation(async () => { entered(); await paused; return stop(); });
  const first = replace(input); await ready;
  await expect(replace(input)).rejects.toMatchObject({ status: 409 });
  expect(fixture.old.stop).toHaveBeenCalledTimes(1);
  release(); expect((await first).cleanupRequired).toBe(false);
});

test('renamed retained originals cannot be updated through a second lock', async () => {
  input.inspect.Name = '/dd-recovery-fixture';
  await expect(replace(input)).rejects.toThrow('explicit reconciliation');
  expect(fixture.docker.createContainer).not.toHaveBeenCalled();
});

test('a prune reservation blocks replacement before renaming or stopping the original', async () => {
  const lookup = fixture.docker.getContainer.getMockImplementation();
  fixture.docker.getContainer.mockImplementation(id => id === 'dd-maintenance-prune-lock'
    ? { inspect: async () => ({ Id: 'prune-reservation' }) } : lookup(id));
  await expect(replace(input)).rejects.toMatchObject({ status: 409 });
  expect(fixture.old.rename).not.toHaveBeenCalled(); expect(fixture.old.stop).not.toHaveBeenCalled();
  expect(fixture.states.size).toBe(1);
});

test('stale inspection is rejected without stopping the original', async () => {
  fixture.initial.Config.Env = ['CHANGED=1'];
  await expect(replace(input)).rejects.toThrow('fresh state');
  expect(fixture.old.stop).not.toHaveBeenCalled(); expect(fixture.states.size).toBe(1);
});

test('stopped originals produce stopped replacements', async () => {
  input.inspect.State.Running = false; fixture.initial.State.Running = false;
  const result = await replace(input);
  expect(fixture.handles.get(result.id).start).not.toHaveBeenCalled();
  expect(fixture.states.get(result.id).State.Running).toBe(false);
});

test.each(['AutoRemove', 'Paused', 'Restarting', 'Dead', 'Swarm'])('rejects unsupported %s before any mutation', async flag => {
  if (flag === 'AutoRemove') input.inspect.HostConfig.AutoRemove = true;
  else if (flag === 'Swarm') input.inspect.Config.Labels = { 'com.docker.swarm.service.id': 'service' };
  else input.inspect.State[flag] = true;
  await expect(replace(input)).rejects.toMatchObject({ status: 409 });
  expect(fixture.docker.createContainer).not.toHaveBeenCalled();
});

test('volume identity, process config and network intent survive without copying endpoint IDs', () => {
  input.inspect.Mounts = [{ Type: 'volume', Name: 'anonymous-data', Destination: '/data', RW: true }];
  input.inspect.Config.StopSignal = 'SIGQUIT';
  input.inspect.NetworkSettings.Networks.custom = { EndpointID: 'dynamic', IPAddress: 'dynamic',
    IPAMConfig: { IPv4Address: '172.20.0.22' }, Aliases: ['app', input.inspect.Id], GwPriority: 10 };
  const cfg = options(input.inspect, input.imageId);
  expect(cfg.HostConfig.Mounts).toEqual([{ Type: 'volume', Source: 'anonymous-data', Target: '/data', ReadOnly: false, VolumeOptions: { NoCopy: true } }]);
  expect(cfg.StopSignal).toBe('SIGQUIT'); expect(cfg.Healthcheck).toEqual(input.inspect.Config.Healthcheck);
  expect(cfg.NetworkingConfig.EndpointsConfig.custom).toEqual({ IPAMConfig: { IPv4Address: '172.20.0.22' }, Aliases: ['app'], GwPriority: 10 });
});

test('ownership mismatch never removes an unknown candidate', async () => {
  await expect(replace({ ...input, commit: () => {
    fixture.states.get('new-container').Config.Labels[LABEL] = 'another-operation';
    throw new Error('changed ownership');
  } })).rejects.toMatchObject({ status: 503 });
  expect(fixture.handles.get('new-container').remove).not.toHaveBeenCalled();
});

test('no healthcheck still requires stable running state', async () => {
  jest.useFakeTimers();
  try {
    const container = { inspect: jest.fn().mockResolvedValueOnce({ State: { Running: true } })
      .mockResolvedValue({ State: { Running: false } }) };
    const pending = expect(verify(container, { wasRunning: true })).rejects.toThrow('not running reliably');
    await jest.runAllTimersAsync(); await pending;
  } finally { jest.useRealTimers(); }
});

test('a restart loop cannot pass while momentarily running', async () => {
  const container = { inspect: async () => ({ State: { Running: true, Health: { Status: 'healthy' } }, RestartCount: 1 }) };
  await expect(verify(container, { wasRunning: true })).rejects.toThrow('not running reliably');
});

test('missing historical data volume stops rollback before reserving or stopping', async () => {
  input.saved = { ...input.inspect.Config, Mounts: [{ Type: 'volume', Name: 'deleted-history-volume', Destination: '/data' }] };
  fixture.docker.getVolume.mockReturnValue({ inspect: async () => { throw new Error('not found'); } });
  await expect(replace(input)).rejects.toThrow('required data volume');
  expect(fixture.docker.createContainer).not.toHaveBeenCalled(); expect(fixture.old.stop).not.toHaveBeenCalled();
});

test('anonymous bind syntax is converted to its existing data volume', () => {
  input.inspect.HostConfig.Binds = ['/data'];
  input.inspect.Mounts = [{ Type: 'volume', Name: 'existing-anonymous-volume', Destination: '/data', RW: true }];
  const cfg = options(input.inspect, input.imageId);
  expect(cfg.HostConfig.Binds).toEqual(['existing-anonymous-volume:/data']);
  expect(cfg.HostConfig.Mounts).toBeUndefined();
});

test('lock cleanup failure is reported to the caller without removing the active candidate', async () => {
  const create = fixture.docker.createContainer.getMockImplementation();
  fixture.docker.createContainer.mockImplementation(async opts => {
    const handle = await create(opts);
    if (opts.name.startsWith('dd-replacement-lock-')) handle.remove.mockRejectedValue(new Error('cleanup unavailable'));
    return handle;
  });
  expect(await replace(input)).toMatchObject({ cleanupRequired: true });
  expect(journal().phase).toBe('cleanup_required');
  expect(fixture.states.size).toBe(2); expect(fixture.states.get('new-container').State.Running).toBe(true);
});
