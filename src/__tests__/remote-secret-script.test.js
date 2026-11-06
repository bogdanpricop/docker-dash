'use strict';

const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { Server, utils } = require('ssh2');
const { generateKeyPair } = require('../services/ssh-keygen');
const { execute, commandFor } = require('../services/remote-secret-script');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
let server, port, pin, clients, children, mode, commands, payloads, authenticated;

beforeAll(async () => {
  const key = generateKeyPair({ type: 'ed25519' });
  pin = createHash('sha256').update(utils.parseKey(key.privateKey).getPublicSSH()).digest('hex');
  clients = new Set(); children = new Set();
  server = new Server({ hostKeys: [key.privateKey] }, client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
    client.on('authentication', context => { authenticated++; context.accept(); });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('exec', (acceptExec, rejectExec, info) => {
        commands.push(info.command);
        if (mode === 'reject') return rejectExec();
        const channel = acceptExec(); const received = [];
        channel.on('error', () => {});
        channel.on('data', data => received.push(data));
        channel.on('end', () => {
          payloads.push(Buffer.concat(received));
          if (mode === 'disconnect') return client.end();
          if (mode === 'hang') return;
          if (mode === 'no-status') return channel.end();
          if (mode === 'wrong-prefix') { channel.write('unexpected output'); channel.exit(0); channel.end(); return; }
          const child = spawn(bash, ['--noprofile', '--norc', '-c', info.command], {
            env: { ...process.env, payload: 'inherited-exported-variable', PATH: '/usr/bin:/bin:' + process.env.PATH }, windowsHide: true,
          });
          children.add(child);
          child.stdin.on('error', () => {});
          child.stdout.on('data', data => channel.write(data)); child.stderr.on('data', data => channel.stderr.write(data));
          child.on('error', () => { channel.exit(127); channel.end(); });
          child.on('close', code => { children.delete(child); try { channel.exit(code ?? 1); channel.end(); } catch {} });
          channel.on('close', () => { if (child.exitCode === null) child.kill(); });
          child.stdin.end(mode === 'tamper' ? Buffer.from('echo SHOULD_NOT_EXECUTE') : Buffer.concat(received));
        });
      });
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); port = server.address().port;
});
beforeEach(() => { mode = 'normal'; commands = []; payloads = []; authenticated = 0; });
afterAll(async () => {
  for (const child of children) child.kill();
  for (const client of clients) client.end();
  await new Promise(resolve => server.close(resolve));
});

const connection = () => ({ host: '127.0.0.1', port, username: 'fixture', password: 'test-only', hostKeySha256: pin });
const run = (script, options = {}) => execute({ connection: connection(), script, useSudo: false, timeoutMs: 5000, ...options });

test('real SSH and Bash preserve UTF-8, quotes, backslashes, heredocs and trailing newlines without secret arguments', async () => {
  const script = "secret='sensitive-fixture-value'\ncat <<'EOF'\nhéllo 'quoted' \\value\nEOF\nprintf '%s' \"$secret\"\n\n";
  const result = await run(script);
  expect(result).toMatchObject({ exitCode: 0, output: "héllo 'quoted' \\value\nsensitive-fixture-value",
    scriptSha256: createHash('sha256').update(script).digest('hex') });
  expect(payloads[0].toString()).toBe(script);
  expect(commands[0]).not.toContain('sensitive-fixture-value');
  expect(commands[0]).not.toMatch(/mktemp|\/tmp\/|sftp/);
});

test('script commands get EOF on stdin instead of consuming following script lines', async () => {
  expect(await run('read value || true\nprintf "after-read:%s" "$value"\n')).toMatchObject({ exitCode: 0, output: 'after-read:' });
});

test('an inherited exported variable cannot turn the script buffer into a process environment secret', async () => {
  expect(await run("if env | grep -q '^payload='; then exit 99; fi; printf private-buffer\n"))
    .toMatchObject({ exitCode: 0, output: 'private-buffer' });
});

test('complete hash verification refuses a changed or truncated payload before execution', async () => {
  mode = 'tamper';
  await expect(run('echo original-command')).rejects.toMatchObject({ code: 'PAYLOAD_NOT_VERIFIED', scriptVerified: false });
});

test('nonzero script status is preserved as a completed execution', async () => {
  expect(await run('printf failed >&2\nexit 23\n')).toMatchObject({ exitCode: 23, output: 'failed' });
});

test('early successful exit in a large verified script is not replaced by a writer SIGPIPE', async () => {
  const script = 'exit 0\n' + '# ignored content\n'.repeat(30000);
  expect(await run(script)).toMatchObject({ exitCode: 0, output: '' });
});

test('the pinned server is checked before authentication', async () => {
  await expect(run('true', { connection: { ...connection(), hostKeySha256: 'ab'.repeat(32) } })).rejects.toMatchObject({ outcomeUnknown: false });
  expect(authenticated).toBe(0); expect(commands).toHaveLength(0);
});

test.each([['reject', 'EXEC_REJECTED', false], ['disconnect', 'CONNECTION_CLOSED|PAYLOAD_NOT_VERIFIED', true],
  ['wrong-prefix', 'INVALID_RESPONSE', true], ['no-status', 'PAYLOAD_NOT_VERIFIED', true]])(
  '%s never reports successful execution', async (failureMode, code, unknown) => {
    mode = failureMode;
    await expect(run('true')).rejects.toMatchObject({ code: expect.stringMatching(new RegExp('^(?:' + code + ')$')), outcomeUnknown: unknown });
  });

test('a stalled operation has an absolute deadline and closes its connection', async () => {
  mode = 'hang';
  await expect(run('true', { timeoutMs: 750 })).rejects.toMatchObject({ code: 'TIMEOUT', outcomeUnknown: true });
});

test('combined stdout/stderr is bounded without returning partial secrets', async () => {
  await expect(run("printf '%1100000s' 'secret-at-end' >&2\n")).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
});

test.each(['', 'a\0b', 'é'.repeat(524289)])('invalid scripts are refused locally', script => {
  expect(() => run(script)).toThrow('UTF-8 bytes'); expect(commands).toHaveLength(0);
});

test('sudo uses non-interactive authentication and a descriptor runner, not secret arguments', () => {
  const command = commandFor('a'.repeat(64), 'fixture-marker', true);
  expect(command).toContain('sudo -n bash'); expect(command).toContain('/dev/fd/3');
  expect(command).not.toContain('/tmp');
});
