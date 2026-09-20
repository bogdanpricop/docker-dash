'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Server, utils } = require('ssh2');
const simpleGit = require('simple-git');
const { spawn, execFileSync } = require('node:child_process');
const { createSession, validateKnownHosts } = require('../utils/git-ssh');
const { generateKeyPair } = require('../services/ssh-keygen');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-git-trust-test-'));
Object.assign(process.env, { APP_ENV: 'test', DB_PATH: ':memory:', DATA_DIR: sandbox,
  APP_SECRET: 'git-trust-test', ENCRYPTION_KEY: 'test-encryption-key-for-jest-32chars' });
const service = require('../services/git');
const { getDb } = require('../db');
const { decrypt } = require('../utils/crypto');
const createdBy = Number(getDb().prepare("INSERT INTO users (username, password_hash, role) VALUES ('git-trust-admin', 'hash', 'admin')").run().lastInsertRowid);
const serverKey = generateKeyPair({ type: 'ed25519', comment: 'test-server' });
const clientKey = generateKeyPair({ type: 'ed25519', comment: 'test-client' });
const publicKey = key => key.publicKey.split(' ').slice(0, 2).join(' ');
const trust = `example.invalid ${publicKey(serverKey)}`;
afterAll(() => {
  if (path.dirname(sandbox) !== os.tmpdir() || !path.basename(sandbox).startsWith('dd-git-trust-test-')) throw Error('Unexpected cleanup path');
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test.each([undefined, '', '*', '@cert-authority example.invalid ssh-ed25519 AAAA',
  `*.invalid ${publicKey(serverKey)}`, `example.invalid ssh-ed25519 AAAA`,
  `[example.invalid]:65536 ${publicKey(serverKey)}`, `example.invalid ${publicKey(serverKey)}\x00`,
  'x'.repeat(65537)])('rejects absent or malformed known_hosts: %j', input => {
  expect(() => validateKnownHosts(input)).toThrow();
});

test('normalizes verified records, including hashed names and custom ports', () => {
  expect(validateKnownHosts('# comment\n' + trust + ' administrator\n')).toBe(trust + '\n');
  expect(validateKnownHosts(`[127.0.0.1]:12345 ${publicKey(serverKey)}`)).toContain('[127.0.0.1]:12345');
  const hashed = '|1|' + Buffer.alloc(20, 1).toString('base64') + '|' + Buffer.alloc(20, 2).toString('base64');
  expect(validateKnownHosts(`${hashed} ${publicKey(serverKey)}`)).toContain(hashed);
});

test('credential trust updates preserve encrypted private keys; migration leaves legacy trust empty', () => {
  const credential = service.createCredential({ name: 'fixture', auth_type: 'ssh_key', created_by: createdBy,
    ssh_private_key: clientKey.privateKey, ssh_known_hosts: trust });
  const original = service.getCredential(credential.id);
  expect(decrypt(original.ssh_private_key_encrypted)).toBe(clientKey.privateKey);
  const replacement = `replacement.invalid ${publicKey(serverKey)}`;
  service.updateCredential(credential.id, { ssh_known_hosts: replacement });
  expect(service.getCredential(credential.id).ssh_private_key_encrypted).toBe(original.ssh_private_key_encrypted);
  const listed = service.listCredentials().find(c => c.id === credential.id);
  expect(listed.ssh_known_hosts).toBe(replacement + '\n');
  expect(JSON.stringify(listed)).not.toContain('PRIVATE KEY');
  expect(() => service.updateCredential(credential.id, { ssh_known_hosts: '' })).toThrow();
  getDb().prepare('UPDATE git_credentials SET ssh_known_hosts = ? WHERE id = ?').run('', credential.id);
  expect(() => service._gitTransport({ repo_url: 'git@example.invalid:test', credential_id: credential.id })).toThrow(/known_hosts/);
});

test('requires managed SSH credentials and blocks ambient SSH for public HTTPS clones', () => {
  expect(() => service._gitTransport({ repo_url: 'ssh://example.invalid/repo' })).toThrow(/managed/);
  const old = process.env.GIT_SSH_COMMAND;
  process.env.GIT_SSH_COMMAND = 'malicious-command';
  try {
    const session = service._gitTransport({ repo_url: 'https://example.invalid/repo' });
    expect(session.env.GIT_SSH_COMMAND).toBe('exit 1');
    expect(session.env.SSH_AUTH_SOCK).toBeUndefined();
    session.dispose();
  } finally { if (old === undefined) delete process.env.GIT_SSH_COMMAND; else process.env.GIT_SSH_COMMAND = old; }
});

test('concurrent sessions have private isolated files and deterministic cleanup', () => {
  const sessions = Array.from({ length: 2 }, () => createSession({ privateKey: clientKey.privateKey,
    knownHosts: trust, caCertificate: 'fixture CA', temporaryRoot: sandbox }));
  try {
    expect(sessions[0].directory).not.toBe(sessions[1].directory);
    for (const session of sessions) {
      expect(fs.readFileSync(path.join(session.directory, 'identity'), 'utf8')).toBe(clientKey.privateKey);
      expect(fs.readFileSync(session.env.GIT_SSL_CAINFO, 'utf8')).toBe('fixture CA');
      if (process.platform !== 'win32') {
        expect(fs.statSync(session.directory).mode & 0o777).toBe(0o700);
        expect(fs.statSync(path.join(session.directory, 'identity')).mode & 0o777).toBe(0o600);
      }
    }
    sessions[0].dispose(); expect(fs.existsSync(sessions[1].directory)).toBe(true);
  } finally { for (const session of sessions) session.dispose(); }
  for (const session of sessions) expect(fs.existsSync(session.directory)).toBe(false);
});

describe('real Git/OpenSSH handshake', () => {
  let server, port, authentication, commands, clients, credentialId, remoteRepo;
  beforeAll(async () => {
    clients = new Set();
    remoteRepo = path.join(sandbox, 'remote.git');
    const seed = path.join(sandbox, 'seed'); fs.mkdirSync(seed);
    const env = createSession().env;
    const localGit = args => execFileSync('git', args, { cwd: seed, env, stdio: 'pipe' });
    localGit(['init', '--initial-branch=main']);
    fs.writeFileSync(path.join(seed, 'docker-compose.yml'), 'services: {}\n');
    localGit(['add', '.']);
    localGit(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
    localGit(['clone', '--bare', seed, remoteRepo]);
    const expectedClientKey = utils.parseKey(clientKey.privateKey);
    server = new Server({ hostKeys: [serverKey.privateKey] }, client => {
      clients.add(client); client.on('close', () => clients.delete(client)); client.on('error', () => {});
      client.on('authentication', context => {
        authentication.push(context.method);
        if (context.method === 'publickey' && context.key.data.equals(expectedClientKey.getPublicSSH())
          && (!context.signature || expectedClientKey.verify(context.blob, context.signature, context.hashAlgo))) context.accept();
        else context.reject(['publickey']);
      });
      client.on('ready', () => client.on('session', accept => {
        accept().on('exec', (acceptExec, reject, info) => {
          commands.push(info.command);
          if (info.command === "git-upload-pack '/fixture.git'") {
            const channel = acceptExec(); channel.write('0000'); channel.exit(0); channel.end(); return;
          }
          const command = /^(git-upload-pack|git-receive-pack) '\/repo.git'$/.exec(info.command);
          if (!command) return reject();
          const channel = acceptExec();
          const child = spawn('git', [command[1].replace('git-', ''), remoteRepo], { env: createSession().env, stdio: 'pipe' });
          channel.pipe(child.stdin); child.stdin.on('error', () => {});
          child.stdout.on('data', data => channel.write(data)); child.stderr.on('data', data => channel.stderr.write(data));
          child.on('close', code => { channel.exit(code ?? 1); channel.end(); });
          channel.on('close', () => { if (child.exitCode === null) child.kill(); });
        });
      }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); port = server.address().port;
    credentialId = service.createCredential({ name: 'local fixture', auth_type: 'ssh_key', created_by: createdBy,
      ssh_private_key: clientKey.privateKey, ssh_known_hosts: `[127.0.0.1]:${port} ${publicKey(serverKey)}` }).id;
  });
  beforeEach(() => { authentication = []; commands = []; });
  afterAll(async () => { for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); });

  test('service probe authenticates to a verified server and deletes session files', async () => {
    const spy = jest.spyOn(service, '_gitTransport');
    try {
      const result = await service.testConnection({ repo_url: `ssh://fixture@127.0.0.1:${port}/fixture.git`, credential_id: credentialId });
      expect(result).toEqual({ ok: true, branches: [] });
      expect(authentication).toContain('publickey'); expect(commands).toHaveLength(1);
      expect(fs.existsSync(spy.mock.results[0].value.directory)).toBe(false);
    } finally { spy.mockRestore(); }
  }, 20000);

  test.each(['wrong-key', 'unknown-host'])('%s rejects before authentication and cleans failed probe', async failure => {
    const knownHosts = failure === 'wrong-key' ? `[127.0.0.1]:${port} ${publicKey(clientKey)}` : trust;
    service.updateCredential(credentialId, { ssh_known_hosts: knownHosts });
    const spy = jest.spyOn(service, '_gitTransport');
    try {
      const result = await service.testConnection({ repo_url: `ssh://fixture@127.0.0.1:${port}/fixture.git`, credential_id: credentialId });
      expect(result.ok).toBe(false); expect(result.error).toMatch(/host key verification failed/i);
      expect(authentication).toEqual([]); expect(commands).toEqual([]);
      expect(fs.existsSync(spy.mock.results[0].value.directory)).toBe(false);
    } finally { spy.mockRestore(); }
  }, 20000);

  test('clone, preview, fetch and push use the verified transport and clean every session', async () => {
    service.updateCredential(credentialId, { ssh_known_hosts: `[127.0.0.1]:${port} ${publicKey(serverKey)}` });
    const stack = service.createStack({ stack_name: 'ssh-trust-fixture', repo_url: `ssh://fixture@127.0.0.1:${port}/repo.git`,
      credential_id: credentialId, deploy_immediately: false, created_by: createdBy });
    const transport = jest.spyOn(service, '_gitTransport');
    const deploy = jest.spyOn(service, '_deployComposeToTargets').mockResolvedValue([]);
    const broadcast = jest.spyOn(service, '_broadcast').mockImplementation(() => {});
    try {
      await service._cloneAndDeploy(stack.id);
      expect(service.getStack(stack.id).status).toBe('running');
      expect(await service.checkForUpdates(stack.id)).toMatchObject({ has_updates: false });
      expect(await service.getRepoDiff(stack.id)).toMatchObject({ hasChanges: false });
      expect(await service.getRemoteStatus(stack.id)).toMatchObject({ isUpToDate: true });
      const preview = await service.preparePreviewCheckout(stack.id, 9001, { ref: 'main' });
      expect(fs.readFileSync(path.join(preview.directory, 'docker-compose.yml'), 'utf8')).toBe('services: {}\n');
      const push = await service.pushToGit(stack.id, { files: { 'docker-compose.yml': 'services: {}\n# updated\n' } });
      expect(push.ok).toBe(true);
      expect(execFileSync('git', ['--git-dir', remoteRepo, 'show', 'main:docker-compose.yml'], { encoding: 'utf8', env: createSession().env })).toContain('# updated');
      await service._pullAndDeploy(stack.id);
      expect(service.getStack(stack.id).status).toBe('running');
      service.updateCredential(credentialId, { ssh_known_hosts: `[127.0.0.1]:${port} ${publicKey(clientKey)}` });
      authentication = [];
      await expect(service.getRepoDiff(stack.id)).rejects.toThrow(/HOST IDENTIFICATION HAS CHANGED/);
      await expect(service.preparePreviewCheckout(stack.id, 9002, { ref: 'main' })).rejects.toThrow(/HOST IDENTIFICATION HAS CHANGED/);
      expect(authentication).toEqual([]);
      expect(fs.existsSync(service.getPreviewDirectory(9002))).toBe(false);
      for (const result of transport.mock.results) {
        if (result.type === 'return' && result.value.directory) expect(fs.existsSync(result.value.directory)).toBe(false);
      }
    } finally { transport.mockRestore(); deploy.mockRestore(); broadcast.mockRestore(); }
  }, 30000);

  test('OpenSSH reads private trust paths containing spaces and apostrophes', async () => {
    const root = path.join(sandbox, "spaces and ' quotes"); fs.mkdirSync(root);
    const session = createSession({ privateKey: clientKey.privateKey,
      knownHosts: `[127.0.0.1]:${port} ${publicKey(serverKey)}`, temporaryRoot: root });
    try {
      const result = await simpleGit(service._gitTimeouts.build(15000)).env(session.env)
        .listRemote(['--heads', `ssh://fixture@127.0.0.1:${port}/fixture.git`]);
      expect(result).toBe(''); expect(commands).toHaveLength(1);
    } finally { session.dispose(); }
  }, 20000);
});
