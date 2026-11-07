'use strict';

const { logReader } = require('../utils/docker-log-reader');

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

test('ignores incomplete payloads and rejects invalid Docker frame headers', () => {
  const emit = jest.fn();
  const reader = logReader(false, emit);
  reader.write(frame(1, Buffer.from(time + ' incomplete')).subarray(0, -1));
  reader.end();
  expect(emit).not.toHaveBeenCalled();
  expect(() => logReader(false, emit).write(Buffer.alloc(8))).toThrow('Invalid Docker log frame');
});
