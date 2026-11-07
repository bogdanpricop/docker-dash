'use strict';

const { StringDecoder } = require('node:string_decoder');

const MAX_LINE_LENGTH = 16 * 1024;
const TIMESTAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z /;

// Docker log timestamps are UTC RFC3339. Preserve the fractional precision
// for Loki and cursor comparisons, while using milliseconds for age checks.
function parseLine(line) {
  const match = TIMESTAMP.exec(line);
  if (!match) return null;
  const timestamp = match[1] + '.' + (match[2] || '').padEnd(9, '0') + 'Z';
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) return null;
  return { timestamp, milliseconds, line: line.slice(match[0].length).replace(/\r$/, '') };
}

function logReader(tty, emit) {
  const channels = ['stdout', 'stderr'].map(name => ({
    name, decoder: new StringDecoder('utf8'), pending: '', truncated: false,
  }));
  const header = Buffer.alloc(8);
  let headerBytes = 0, remaining = 0, channel = channels[0];

  function flush(target) {
    const parsed = parseLine(target.pending);
    if (parsed) emit({ ...parsed, stream: target.name, line: parsed.line + (target.truncated ? ' [truncated]' : '') });
    target.pending = '';
    target.truncated = false;
  }

  function append(target, text) {
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf('\n', offset);
      const end = newline < 0 ? text.length : newline;
      const room = MAX_LINE_LENGTH - target.pending.length;
      target.pending += text.slice(offset, Math.min(end, offset + room));
      if (end - offset > room) target.truncated = true;
      if (newline < 0) break;
      flush(target);
      offset = newline + 1;
    }
  }

  return {
    write(chunk) {
      if (tty) { append(channel, channel.decoder.write(chunk)); return; }
      let offset = 0;
      while (offset < chunk.length) {
        if (!remaining) {
          const count = Math.min(8 - headerBytes, chunk.length - offset);
          chunk.copy(header, headerBytes, offset, offset + count);
          headerBytes += count;
          offset += count;
          if (headerBytes < 8) break;
          if ((header[0] !== 1 && header[0] !== 2) || header[1] || header[2] || header[3]) {
            throw new Error('Invalid Docker log frame');
          }
          channel = channels[header[0] - 1];
          remaining = header.readUInt32BE(4);
          headerBytes = 0;
        }
        const count = Math.min(remaining, chunk.length - offset);
        append(channel, channel.decoder.write(chunk.subarray(offset, offset + count)));
        offset += count;
        remaining -= count;
      }
    },
    end() {
      if (remaining || headerBytes) return;
      for (const target of channels) {
        append(target, target.decoder.end());
        if (target.pending) flush(target);
      }
    },
  };
}

module.exports = { logReader };
