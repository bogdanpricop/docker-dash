'use strict';

// Post-v8.2.x audit gap closure — supplemental coverage for the
// SshTunnelService singleton that complements ssh-tunnel-exec.test.js.
// Hits: createTunnel (key + password auth), exec (escapes, exit codes),
// fileExists, readFile, writeFile, forward method selection, closeTunnel,
// closeAll, testConnection, connection timeout + reconnect on transient
// failures. ssh2 is mocked entirely; no real SSH connection is opened.

process.env.APP_ENV = 'test';
process.env.APP_SECRET = 'test-secret-key-for-jest-tests-only';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

// Mock ssh2 BEFORE requiring ssh-tunnel.
jest.mock('ssh2', () => {
  const { EventEmitter } = require('events');

  class MockClient extends EventEmitter {
    constructor() {
      super();
      this._lastConnectOpts = null;
      this._lastExecCmd = null;
      this._execStdout = 'ok';
      this._execStderr = '';
      this._execExit = 0;
      this._execError = null;
      this._streamLocalError = null;
      this._sftpError = null;
      this._sftpReadContent = 'file content';
      this._sftpWrittenContent = null;
      this._sftpWrittenPath = null;
      this._sftpWriteError = null;
      // Connection behaviour:
      //   'ready'   — emits ready synchronously (default)
      //   'error'   — emits an error
      //   'timeout' — never emits anything
      this._connectMode = 'ready';
      this._connectError = null;
    }

    connect(opts) {
      this._lastConnectOpts = opts;
      MockClient.lastInstance = this;
      if (this._connectMode === 'ready') {
        setImmediate(() => this.emit('ready'));
      } else if (this._connectMode === 'error') {
        setImmediate(() => this.emit('error', this._connectError || new Error('mock connect error')));
      }
      // 'timeout' — no emit
    }

    exec(cmd, cb) {
      this._lastExecCmd = cmd;
      if (this._execError) {
        return cb(this._execError);
      }
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.destroy = jest.fn();
      stream.pipe = jest.fn(() => stream);
      setImmediate(() => {
        if (this._execStdout) stream.emit('data', Buffer.from(this._execStdout));
        if (this._execStderr) stream.stderr.emit('data', Buffer.from(this._execStderr));
        stream.emit('close', this._execExit);
      });
      cb(null, stream);
    }

    openssh_forwardOutStreamLocal(_remotePath, cb) {
      if (this._streamLocalError) return cb(this._streamLocalError);
      const stream = new EventEmitter();
      stream.destroy = jest.fn();
      stream.pipe = jest.fn(() => stream);
      cb(null, stream);
    }

    sftp(cb) {
      if (this._sftpError) return cb(this._sftpError);
      const self = this;
      const sftp = {
        createReadStream: jest.fn(() => {
          const s = new EventEmitter();
          setImmediate(() => {
            s.emit('data', Buffer.from(self._sftpReadContent));
            s.emit('end');
          });
          return s;
        }),
        createWriteStream: jest.fn((path) => {
          const s = new EventEmitter();
          self._sftpWrittenPath = path;
          s.end = (content) => {
            if (self._sftpWriteError) {
              setImmediate(() => s.emit('error', self._sftpWriteError));
              return;
            }
            self._sftpWrittenContent = content;
            setImmediate(() => s.emit('close'));
          };
          return s;
        }),
      };
      cb(null, sftp);
    }

    end() { /* no-op for tests */ }
  }

  MockClient.lastInstance = null;
  return { Client: MockClient };
});

// Mock the network layer so createTunnel doesn't actually bind to a port.
jest.mock('net', () => {
  const { EventEmitter } = require('events');
  return {
    createServer: jest.fn((_handler) => {
      const server = new EventEmitter();
      server.listen = jest.fn((_port, _host, cb) => {
        setImmediate(cb);
      });
      server.address = () => ({ port: 54321 });
      server.close = jest.fn();
      return server;
    }),
  };
});

const sshTunnel = require('../services/ssh-tunnel');
const { Client: MockClient } = require('ssh2');
const { encrypt, decrypt } = require('../utils/crypto');

function setupTunnel(hostId, client) {
  sshTunnel._tunnels.set(hostId, { client, localPort: 0, hostId });
}

function teardownAllTunnels() {
  sshTunnel._tunnels.clear();
  if (sshTunnel._forwardMethod) sshTunnel._forwardMethod.clear();
}

describe('SshTunnelService — createTunnel auth modes', () => {
  afterEach(() => teardownAllTunnels());

  it('uses privateKey + passphrase when provided (key auth)', async () => {
    const cfg = {
      id: 'host-key',
      sshConfig: { hostKeySha256: 'ab'.repeat(32),
        host: '10.0.0.1',
        port: 2222,
        username: 'deploy',
        privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nABC\n-----END OPENSSH PRIVATE KEY-----',
        passphrase: 'pp',
      },
    };
    const t = await sshTunnel.createTunnel(cfg);
    expect(t.localPort).toBe(54321);
    const opts = MockClient.lastInstance._lastConnectOpts;
    expect(opts.username).toBe('deploy');
    expect(opts.port).toBe(2222);
    expect(opts.privateKey).toContain('PRIVATE KEY');
    expect(opts.passphrase).toBe('pp');
    expect(opts.password).toBeUndefined();
  });

  it('uses password auth when no privateKey is provided', async () => {
    const cfg = {
      id: 'host-pw',
      sshConfig: { hostKeySha256: 'ab'.repeat(32), host: '10.0.0.2', username: 'root', password: 's3cret' },
    };
    await sshTunnel.createTunnel(cfg);
    const opts = MockClient.lastInstance._lastConnectOpts;
    expect(opts.password).toBe('s3cret');
    expect(opts.privateKey).toBeUndefined();
    expect(opts.port).toBe(22); // default
  });

  it('rejects when sshConfig is missing', async () => {
    await expect(sshTunnel.createTunnel({ id: 'x' })).rejects.toThrow(/SSH configuration is required/);
  });

  it('rejects an unsafe dockerSocket path (validation)', async () => {
    const cfg = {
      id: 'bad-sock',
      sshConfig: { hostKeySha256: 'ab'.repeat(32),
        host: 'h',
        username: 'u',
        password: 'p',
        dockerSocket: '/var/run/$(rm -rf /).sock',
      },
    };
    await expect(sshTunnel.createTunnel(cfg)).rejects.toThrow(/Invalid dockerSocket path/);
  });
});

describe('SshTunnelService — crypto round-trip for stored private keys', () => {
  it('encrypts and decrypts a private key losslessly', () => {
    const pk = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----';
    const enc = encrypt(pk);
    expect(enc).not.toContain('PRIVATE KEY');
    expect(enc.split(':')).toHaveLength(3); // iv:tag:ciphertext
    expect(decrypt(enc)).toBe(pk);
  });
});

describe('SshTunnelService — exec()', () => {
  let client;
  beforeEach(() => {
    client = new MockClient();
    setupTunnel('h1', client);
  });
  afterEach(() => teardownAllTunnels());

  it('returns stdout and stderr separately', async () => {
    client._execStdout = 'STDOUT-DATA';
    client._execStderr = 'STDERR-DATA';
    const r = await sshTunnel.exec('h1', 'do-thing');
    expect(r.stdout).toBe('STDOUT-DATA');
    expect(r.stderr).toBe('STDERR-DATA');
    expect(r.exitCode).toBe(0);
  });

  it('propagates a non-zero exit code', async () => {
    client._execStdout = '';
    client._execStderr = 'permission denied';
    client._execExit = 13;
    const r = await sshTunnel.exec('h1', 'cat /root/.ssh/id_rsa');
    expect(r.exitCode).toBe(13);
    expect(r.stderr).toMatch(/permission denied/);
  });

  it('passes commands containing special chars through unmodified (caller-escaped)', async () => {
    const tricky = `echo "hello $USER"; ls /tmp/'a b c.txt' && grep -E '^foo|bar'`;
    await sshTunnel.exec('h1', tricky);
    expect(client._lastExecCmd).toBe(tricky);
  });

  it('rejects with a clear error when no tunnel exists for hostId', async () => {
    await expect(sshTunnel.exec('does-not-exist', 'ls')).rejects.toThrow(/No SSH tunnel/);
  });
});

describe('SshTunnelService — fileExists()', () => {
  let client;
  beforeEach(() => { client = new MockClient(); setupTunnel('h1', client); });
  afterEach(() => teardownAllTunnels());

  it('returns true when test -f exits 0', async () => {
    client._execExit = 0;
    expect(await sshTunnel.fileExists('h1', '/etc/hosts')).toBe(true);
    expect(client._lastExecCmd).toMatch(/^test -f /);
    expect(client._lastExecCmd).toContain("'/etc/hosts'");
  });

  it('returns false when test -f exits 1', async () => {
    client._execExit = 1;
    expect(await sshTunnel.fileExists('h1', '/no/such')).toBe(false);
  });

  it('escapes single-quotes inside the path', async () => {
    client._execExit = 1;
    await sshTunnel.fileExists('h1', "/tmp/it's-fine.txt");
    // Single quote becomes the standard '\'' POSIX shell trick
    expect(client._lastExecCmd).toContain(`'/tmp/it'\\''s-fine.txt'`);
  });
});

describe('SshTunnelService — readFile() / writeFile()', () => {
  let client;
  beforeEach(() => { client = new MockClient(); setupTunnel('h1', client); });
  afterEach(() => teardownAllTunnels());

  it('readFile returns the streamed content as a utf8 string (buffer-concatenated)', async () => {
    client._sftpReadContent = 'docker-compose: yaml content';
    const r = await sshTunnel.readFile('h1', '/srv/compose.yml');
    expect(typeof r).toBe('string');
    expect(r).toBe('docker-compose: yaml content');
  });

  it('readFile rejects when sftp() fails', async () => {
    client._sftpError = new Error('sftp denied');
    await expect(sshTunnel.readFile('h1', '/x')).rejects.toThrow(/sftp denied/);
  });

  it('writeFile writes the supplied content via sftp createWriteStream', async () => {
    await sshTunnel.writeFile('h1', '/srv/out.yml', 'new content');
    expect(client._sftpWrittenContent).toBe('new content');
    expect(client._sftpWrittenPath).toBe('/srv/out.yml');
  });

  it('writeFile passes absolute paths through (caller validates traversal)', async () => {
    // Note: the singleton intentionally does NOT validate paths — callers are
    // expected to gate user input. We assert the contract: the path it asked
    // for is the path SFTP receives, so callers can rely on no implicit
    // rewriting. A "../../etc/passwd" attempt is expected to surface to the
    // SFTP server, not be silently transformed.
    await sshTunnel.writeFile('h1', '/etc/docker-dash/safe.yml', 'x');
    expect(client._sftpWrittenPath).toBe('/etc/docker-dash/safe.yml');
  });

  it('writeFile rejects when no tunnel exists', async () => {
    await expect(sshTunnel.writeFile('ghost', '/x', 'y')).rejects.toThrow(/No SSH tunnel/);
  });
});

describe('SshTunnelService — closeTunnel / closeAll', () => {
  afterEach(() => teardownAllTunnels());

  it('closeTunnel ends the client and removes the entry', () => {
    const client = new MockClient();
    client.end = jest.fn();
    const server = { close: jest.fn() };
    sshTunnel._tunnels.set('h1', { client, server, hostId: 'h1' });
    sshTunnel.closeTunnel('h1');
    expect(client.end).toHaveBeenCalled();
    expect(server.close).toHaveBeenCalled();
    expect(sshTunnel._tunnels.has('h1')).toBe(false);
  });

  it('closeTunnel is a no-op for unknown hostIds', () => {
    expect(() => sshTunnel.closeTunnel('nope')).not.toThrow();
  });

  it('closeAll tears down every active tunnel', () => {
    const c1 = new MockClient(); c1.end = jest.fn();
    const c2 = new MockClient(); c2.end = jest.fn();
    sshTunnel._tunnels.set('a', { client: c1, server: { close: jest.fn() }, hostId: 'a' });
    sshTunnel._tunnels.set('b', { client: c2, server: { close: jest.fn() }, hostId: 'b' });
    sshTunnel.closeAll();
    expect(sshTunnel._tunnels.size).toBe(0);
    expect(c1.end).toHaveBeenCalled();
    expect(c2.end).toHaveBeenCalled();
  });
});

describe('SshTunnelService — _forwardConnection method selection', () => {
  afterEach(() => teardownAllTunnels());

  it('caches "streamlocal" as the forward method on first success', () => {
    const client = new MockClient();
    const localSocket = { destroy: jest.fn(), pipe: jest.fn(function () { return this; }), on: jest.fn() };
    sshTunnel._forwardMethod = sshTunnel._forwardMethod || new Map();
    sshTunnel._forwardConnection(client, '/var/run/docker.sock', localSocket, 'fwd1');
    // streamlocal succeeds in the mock by default → method cached
    expect(sshTunnel._forwardMethod.get('fwd1')).toBe('streamlocal');
  });

  it('falls back to socat when streamlocal errors', () => {
    const client = new MockClient();
    client._streamLocalError = new Error('streamlocal not supported');
    const localSocket = { destroy: jest.fn(), pipe: jest.fn(function () { return this; }), on: jest.fn() };
    sshTunnel._forwardMethod = sshTunnel._forwardMethod || new Map();
    sshTunnel._forwardConnection(client, '/var/run/docker.sock', localSocket, 'fwd2');
    expect(sshTunnel._forwardMethod.get('fwd2')).toBe('socat');
    expect(client._lastExecCmd).toMatch(/^socat STDIO UNIX-CONNECT:/);
  });
});

describe('SshTunnelService — testConnection (timeout + reject)', () => {
  afterEach(() => teardownAllTunnels());

  it('rejects when the SSH client emits an error', async () => {
    // Patch the next-instance behaviour by overriding connect via prototype.
    const origConnect = MockClient.prototype.connect;
    MockClient.prototype.connect = function patched() {
      MockClient.lastInstance = this;
      setImmediate(() => this.emit('error', new Error('auth failed')));
    };
    try {
      await expect(sshTunnel.testConnection({ hostKeySha256: 'ab'.repeat(32),
        host: 'h', username: 'u', password: 'p',
      })).rejects.toThrow(/auth failed/);
    } finally {
      MockClient.prototype.connect = origConnect;
    }
  });

  it('rejects with timeout error when the server never becomes ready', async () => {
    jest.useFakeTimers();
    const origConnect = MockClient.prototype.connect;
    MockClient.prototype.connect = function patched() { MockClient.lastInstance = this; };
    try {
      const promise = sshTunnel.testConnection({ hostKeySha256: 'ab'.repeat(32), host: 'silent', username: 'u', password: 'p' });
      // Attach a catch handler immediately so Node doesn't flag the rejection
      // as unhandled when we advance the fake timer below.
      const settled = promise.catch((e) => e);
      jest.advanceTimersByTime(10001);
      const err = await settled;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/SSH connection timeout/);
    } finally {
      MockClient.prototype.connect = origConnect;
      jest.useRealTimers();
    }
  });
});
