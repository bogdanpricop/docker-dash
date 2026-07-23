'use strict';

const { humanizeDockerError, cleanDockerMessage } = require('../utils/docker-errors');

describe('cleanDockerMessage', () => {
  test('strips the "(HTTP code NNN) unexpected - " preamble', () => {
    expect(cleanDockerMessage('(HTTP code 500) unexpected - --live-restore daemon configuration is incompatible with swarm mode '))
      .toBe('--live-restore daemon configuration is incompatible with swarm mode');
  });
  test('handles empty / nullish', () => {
    expect(cleanDockerMessage('')).toBe('');
    expect(cleanDockerMessage(null)).toBe('');
  });
});

describe('humanizeDockerError', () => {
  const h = (m) => humanizeDockerError(new Error(m));

  test('the reported swarm live-restore error becomes plain language with the fix', () => {
    const out = h('(HTTP code 500) unexpected - --live-restore daemon configuration is incompatible with swarm mode ');
    expect(out).toMatch(/live-restore/i);
    expect(out).toMatch(/restart Docker/i);
    expect(out).not.toMatch(/HTTP code/i);      // no raw preamble
    expect(out).not.toMatch(/^--/);             // no raw daemon flag prefix
  });

  test('multi-homed advertise-address', () => {
    expect(h('could not choose an IP address to advertise since this system has multiple addresses on interface eth0 (1.2.3.4 and 5.6.7.8) - specify one with --advertise-addr'))
      .toMatch(/Advertise address/i);
  });

  test('already in a swarm', () => {
    expect(h('(HTTP code 503) unexpected - This node is already part of a swarm'))
      .toMatch(/already part of a swarm/i);
  });

  test('not a swarm manager', () => {
    expect(h('(HTTP code 503) unexpected - This node is not a swarm manager.'))
      .toMatch(/swarm manager/i);
  });

  test('port already allocated', () => {
    expect(h('(HTTP code 500) unexpected - driver failed programming external connectivity: Bind for 0.0.0.0:8080 failed: port is already allocated'))
      .toMatch(/port is already in use/i);
  });

  test('no such container', () => {
    expect(h('(HTTP code 404) no such container: abc123')).toMatch(/no longer exists/i);
  });

  test('socket hang up / timeout', () => {
    expect(h('socket hang up')).toMatch(/dropped|timed out/i);
  });

  test('connection refused', () => {
    expect(h('connect ECONNREFUSED /var/run/docker.sock')).toMatch(/connection refused|reach the Docker daemon/i);
  });

  test('no space left on device', () => {
    expect(h('write /var/lib/docker/tmp: no space left on device')).toMatch(/out of disk space/i);
  });

  test('unknown errors fall back to a cleaned, prefixed message', () => {
    const out = h('(HTTP code 500) unexpected - something weird happened');
    expect(out).toMatch(/^Docker couldn't complete this: Something weird happened/);
    expect(out).not.toMatch(/HTTP code/i);
  });

  test('accepts a raw string too', () => {
    expect(humanizeDockerError('permission denied')).toMatch(/permission denied/i);
  });
});
