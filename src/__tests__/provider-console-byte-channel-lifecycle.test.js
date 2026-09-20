'use strict';
const { execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const ByteChannel = require('../services/provider-console/byte-channel');

test.each(['complete', 'timeout', 'destroy'])('partial frame allows %s while waiting for bytes', mode => {
  // A partial-frame microtask loop can starve transport/timer callbacks. Bound
  // this real I/O test with a parent-owned child process deadline as well.
  const script = `
    const assert = require('assert');
    const {EventEmitter} = require('events');
    const ByteChannel = require(process.argv[1]);
    const stream = new EventEmitter(); stream.destroy = () => {};
    const channel = new ByteChannel(stream);
    stream.emit('data', Buffer.from([1]));
    const mode = process.argv[2];
    const result = channel.readExact(2, 50);
    if (mode === 'complete') setTimeout(() => stream.emit('data', Buffer.from([2])), 10);
    if (mode === 'destroy') setTimeout(() => channel.destroy(), 10);
    (async () => {
      if (mode === 'complete') assert.deepStrictEqual(await result, Buffer.from([1,2]));
      else await assert.rejects(result, /closed|timed out|denied/);
      channel.destroy(); process.stdout.write('passed');
    })().catch(() => process.exit(1));
  `;
  expect(execFileSync(process.execPath, ['-e', script, require.resolve('../services/provider-console/byte-channel'), mode], { timeout: 2000, encoding: 'utf8' })).toBe('passed');
});
test('revoked authorization refuses previously buffered reads and writes', async () => {
  const stream = new EventEmitter(); stream.destroy = jest.fn(); stream.write = jest.fn();
  let allowed = true; const channel = new ByteChannel(stream, () => allowed);
  stream.emit('data', Buffer.from('private')); allowed = false;
  await expect(channel.readExact(7)).rejects.toThrow('denied');
  await expect(channel.write('denied')).rejects.toThrow('denied');
  expect(channel.length).toBe(0); expect(stream.write).not.toHaveBeenCalled();
});
