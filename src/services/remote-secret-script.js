'use strict';

const { Client } = require('ssh2');
const { createHash, randomBytes } = require('node:crypto');
const { hostKeyOptions } = require('../utils/ssh-host-key');
const LIMIT = 1024 * 1024;
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";

function commandFor(hash, marker, useSudo) {
  // Read the entire payload into a non-exported shell variable. No script file,
  // secret-bearing command argument or execution of a truncated upload.
  const runner = 'exec 3<&0; exec bash --noprofile --norc /dev/fd/3 </dev/null';
  const wrapper = [
    'set +x +v', 'unset BASH_ENV ENV payload actual', 'set -o pipefail', 'payload=',
    "IFS= read -r -d '' payload || :",
    "actual=$(printf '%s' \"$payload\" | sha256sum) || exit 125",
    '[ "${actual%% *}" = ' + quote(hash) + ' ] || exit 125',
    "printf '%s\\n' " + quote(marker),
    "printf '%s' \"$payload\" | " + (useSudo ? 'sudo -n ' : '') + 'bash --noprofile --norc -c ' + quote(runner),
    'exit "${PIPESTATUS[1]}"',
  ].join('; ');
  return 'env BASH_ENV=/dev/null ENV=/dev/null bash --noprofile --norc -c ' + quote(wrapper);
}

function execute({ connection, script, useSudo = true, timeoutMs = 120000 }) {
  if (typeof script !== 'string' || !script || script.includes('\0') || Buffer.byteLength(script) > LIMIT) {
    throw Object.assign(new Error('Script must contain 1–1048576 UTF-8 bytes and no NUL characters'), { status: 400 });
  }
  if (typeof useSudo !== 'boolean') throw Object.assign(new Error('useSudo must be boolean'), { status: 400 });
  const identity = hostKeyOptions(connection);
  const hash = createHash('sha256').update(script).digest('hex');
  const marker = 'DD_SCRIPT_VERIFIED_' + randomBytes(16).toString('hex');
  const prefix = Buffer.from(marker + '\n');
  const command = commandFor(hash, marker, useSudo);
  return new Promise((resolve, reject) => {
    const client = new Client();
    let channel, settled = false, verified = false, submitted = false, bytes = 0, header = Buffer.alloc(0);
    const chunks = [];
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) {
        error.outcomeUnknown = submitted;
        error.scriptVerified = verified;
        try { channel?.signal?.('TERM'); } catch { /* The transport may already be gone. */ }
        try { channel?.destroy(); } catch { /* Best effort channel shutdown. */ }
      }
      try { client.end(); } catch { /* Already disconnected. */ }
      if (error) { try { client.destroy?.(); } catch { /* Already disconnected. */ } reject(error); }
      else resolve(result);
    };
    const fail = code => finish(Object.assign(new Error('Remote script execution failed: ' + code), { code }));
    const timer = setTimeout(() => fail('TIMEOUT'), timeoutMs);
    const append = (chunk, stdout) => {
      if (settled) return;
      let data = Buffer.from(chunk);
      bytes += data.length;
      if (bytes > LIMIT + prefix.length) return fail('OUTPUT_LIMIT');
      if (stdout && !verified) {
        const needed = prefix.length - header.length;
        header = Buffer.concat([header, data.subarray(0, needed)]);
        data = data.subarray(needed);
        if (!prefix.subarray(0, header.length).equals(header)) return fail('INVALID_RESPONSE');
        if (header.length !== prefix.length) return;
        verified = true;
      }
      if (data.length) chunks.push(data);
    };
    client.on('error', () => fail('CONNECTION_ERROR'));
    client.on('close', () => { if (!settled) fail('CONNECTION_CLOSED'); });
    client.on('ready', () => {
      if (settled) return;
      try { client.exec(command, { pty: false }, (error, stream) => {
        if (settled) { try { stream?.destroy(); } catch {} return; }
        if (error) return fail('EXEC_REJECTED');
        channel = stream;
        stream.on('error', () => fail('CHANNEL_ERROR'));
        stream.stderr.on('error', () => fail('CHANNEL_ERROR'));
        stream.on('data', data => append(data, true));
        stream.stderr.on('data', data => append(data, false));
        stream.on('close', (exitCode, signal) => {
          if (settled) return;
          if (!verified) return fail('PAYLOAD_NOT_VERIFIED');
          if (!Number.isInteger(exitCode) || signal) return fail('EXIT_STATUS_MISSING');
          finish(null, { exitCode, output: Buffer.concat(chunks).toString('utf8'), scriptSha256: hash });
        });
        submitted = true;
        try { stream.end(Buffer.from(script)); } catch { fail('CHANNEL_ERROR'); }
      }); } catch { fail('EXEC_REJECTED'); }
    });
    const options = { ...identity, host: connection.host, port: connection.port || 22,
      username: connection.username, readyTimeout: Math.min(timeoutMs, 15000) };
    if (connection.privateKey) {
      options.privateKey = connection.privateKey;
      if (connection.passphrase) options.passphrase = connection.passphrase;
    } else options.password = connection.password;
    try { client.connect(options); } catch { fail('CONNECTION_ERROR'); }
  });
}

module.exports = { execute, commandFor };
