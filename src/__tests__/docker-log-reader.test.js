'use strict';

const { Readable } = require('node:stream');
const { logReader, readLogSnapshot } = require('../utils/docker-log-reader');
const filterLogsByRegex = require('../utils/log-regex');

const time = '2026-11-07T12:00:00.123456789Z';

function frame(channel, body) {
  const header = Buffer.alloc(8);
  header[0] = channel;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

test('decodes split Docker frames and UTF-8 without mixing stdout and stderr', () => {
  const output = [];
  const reader = logReader(false, line => output.push(line));
  const stdout = Buffer.from(time + ' ieșire\n');
  const bytes = Buffer.concat([
    frame(1, stdout.subarray(0, stdout.length - 5)),
    frame(2, Buffer.from(time + ' eroare\n')),
    frame(1, stdout.subarray(stdout.length - 5)),
  ]);
  for (const byte of bytes) reader.write(Buffer.from([byte]));
  reader.end();
  expect(output).toEqual([
    { timestamp: time, milliseconds: Date.parse(time), stream: 'stderr', line: 'eroare' },
    { timestamp: time, milliseconds: Date.parse(time), stream: 'stdout', line: 'ieșire' },
  ]);
});

test('bounds oversized TTY lines and preserves the next line', () => {
  const output = [];
  const reader = logReader(true, line => output.push(line));
  reader.write(Buffer.from(time + ' ' + 'a'.repeat(20000) + '\r\n' + time + ' next'));
  reader.end();
  expect(output).toHaveLength(2);
  expect(output[0].line).toMatch(/^a+ \[truncated\]$/);
  expect(output[0].line.length).toBeLessThan(16400);
  expect(output[1].line).toBe('next');
});

test('reads a non-follow snapshot from a stream and stops at the byte limit', async () => {
  const first = frame(1, Buffer.from(time + ' first\n'));
  const stream = Readable.from([first.subarray(0, 4), first.subarray(4), Buffer.alloc(1024)]);
  const modem = { dial: jest.fn((_options, callback) => callback(null, stream)) };
  const result = await readLogSnapshot({ id: 'sample', modem }, { maxBytes: first.length });
  expect(result).toMatchObject({ entries: [{ line: 'first' }], truncated: true });
  expect(stream.destroyed).toBe(true);
  expect(modem.dial.mock.calls[0][0]).toMatchObject({ isStream: true, options: { follow: false } });
});

test('isolates log regex work and aborts pathological matches', async () => {
  await expect(filterLogsByRegex(['Info', 'ERROR'], '^error$')).resolves.toEqual(['ERROR']);
  await expect(filterLogsByRegex(['Info'], '[')).rejects.toMatchObject({ status: 400 });
  await expect(filterLogsByRegex(['a'.repeat(16000) + '!'], '(a+)+$')).rejects.toMatchObject({ status: 422 });
  await expect(filterLogsByRegex(['Info'], 'Info')).resolves.toEqual(['Info']);
});

test('ignores incomplete payloads and rejects invalid Docker frame headers', () => {
  const emit = jest.fn();
  const reader = logReader(false, emit);
  reader.write(frame(1, Buffer.from(time + ' incomplete')).subarray(0, -1));
  reader.end();
  expect(emit).not.toHaveBeenCalled();
  expect(() => logReader(false, emit).write(Buffer.alloc(8))).toThrow('Invalid Docker log frame');
});
