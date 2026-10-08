'use strict';

jest.mock('child_process', () => ({ spawn: jest.fn() }));

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { runCompose, parseComposePlan } = require('../services/compose-runner');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

describe('non-blocking Compose runner', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it('spawns docker compose without a shell and streams both output channels', async () => {
    const child = fakeChild();
    const events = [];
    spawn.mockReturnValue(child);

    const pending = runCompose(['up', '-d'], {
      cwd: '/srv/demo', onOutput: event => events.push(event),
    });
    child.stdout.emit('data', Buffer.from('Creating web\n'));
    child.stderr.emit('data', Buffer.from('progress\n'));
    child.emit('close', 0, null);

    const result = await pending;
    expect(spawn).toHaveBeenCalledWith('docker', ['compose', '--ansi', 'never', 'up', '-d'], expect.objectContaining({
      cwd: '/srv/demo', shell: false, windowsHide: true,
    }));
    expect(events).toEqual([
      { stream: 'stdout', data: 'Creating web\n', truncated: false },
      { stream: 'stderr', data: 'progress\n', truncated: false },
    ]);
    expect(result).toMatchObject({ stdout: 'Creating web\n', stderr: 'progress\n', exitCode: 0 });
  });

  it('returns exit metadata and bounded output on failure', async () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);
    const pending = runCompose(['pull']);
    child.stderr.emit('data', Buffer.from('registry unavailable'));
    child.emit('close', 17, null);

    await expect(pending).rejects.toMatchObject({
      code: 'COMPOSE_FAILED', exitCode: 17, stderr: 'registry unavailable',
    });
  });

  it('runs independent Compose actions concurrently', async () => {
    const first = fakeChild();
    const second = fakeChild();
    spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const up = runCompose(['up', '-d'], { cwd: '/srv/one' });
    const pull = runCompose(['pull'], { cwd: '/srv/two' });
    second.stdout.emit('data', 'two complete');
    second.emit('close', 0, null);
    first.stdout.emit('data', 'one complete');
    first.emit('close', 0, null);

    await expect(Promise.all([up, pull])).resolves.toEqual([
      expect.objectContaining({ stdout: 'one complete' }),
      expect.objectContaining({ stdout: 'two complete' }),
    ]);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('terminates a command that exceeds its timeout', async () => {
    jest.useFakeTimers();
    const child = fakeChild();
    spawn.mockReturnValue(child);
    const pending = runCompose(['pull'], { timeoutMs: 25 });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'COMPOSE_TIMEOUT' });

    jest.advanceTimersByTime(25);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', null, 'SIGTERM');
    await rejected;
  });

  it('bounds captured output and rejects unsafe argument shapes', async () => {
    const child = fakeChild();
    const events = [];
    spawn.mockReturnValue(child);
    const pending = runCompose(['config'], { maxBytes: 4, onData: event => events.push(event) });
    child.stdout.emit('data', Buffer.from('abcdef'));
    child.emit('close', 0, null);
    await expect(pending).resolves.toMatchObject({ stdout: 'abcd', truncated: true });
    expect(events).toContainEqual(expect.objectContaining({ stream: 'system', truncated: true }));

    spawn.mockClear();
    await expect(runCompose('up')).rejects.toThrow('array of strings');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('normalizes JSON and plain-text dry-run progress with redaction', () => {
    const plan = parseComposePlan({
      stdout: [
        JSON.stringify({ id: 'Network demo_default', text: 'Creating' }),
        JSON.stringify({ id: 'Container demo-web-1', status: 'Starting' }),
      ].join('\n'),
      stderr: 'Pulling image https://user:pass@example.test/demo?token=secret',
    });

    expect(plan.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'network', operation: 'create', resource: 'Network demo_default' }),
      expect.objectContaining({ kind: 'container', operation: 'start', resource: 'Container demo-web-1' }),
      expect.objectContaining({ kind: 'image', operation: 'pull' }),
    ]));
    expect(plan.rawOutput).not.toContain('user:pass');
    expect(plan.rawOutput).not.toContain('token=secret');
    expect(plan.summary).toMatchObject({ create: 1, start: 1, pull: 1 });
  });
});
