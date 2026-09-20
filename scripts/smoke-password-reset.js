'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), crypto = require('node:crypto');
const Docker = require('dockerode'), tar = require('tar-stream');
const { hashArchive } = require('./verify-scanner-artifacts');
const url = new URL(process.env.DD_SMOKE_DOCKER_URL);
assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.protocol, 'http:');
assert.match(process.env.DD_SMOKE_APP_IMAGE || '', /^sha256:[a-f0-9]{64}$/);
const overlay = process.env.DD_RESET_SMOKE_SOURCE_OVERLAY === '1';
const docker = new Docker({ host: url.hostname, port: Number(url.port), timeout: 30000 });
const marker = 'dd-reset-smoke-' + crypto.randomBytes(6).toString('hex');
const sources = ['src/routes/auth.js', 'src/services/auth.js', 'src/services/email.js',
  'src/services/misc.js', 'src/routes/misc-api-keys.js', 'src/middleware/auth.js',
  'src/utils/account-password-policy.js', 'src/db/migrations/182_api_key_credential_revocation.js',
  'src/utils/oidc-http.js',
  'src/services/scim.js', 'src/routes/scim.js', 'src/services/identity-governance.js',
  'src/routes/workload-identity.js', 'src/db/migrations/183_workload_replay_identity.js',
  'src/services/password-reset.js', 'src/services/password-reset-delivery.js', 'src/config/index.js',
  'src/db/migrations/178_auth_time_indexes.js', 'src/db/migrations/179_auth_credential_version.js',
  'src/db/migrations/180_mfa_replay_and_attempts.js', 'src/db/migrations/181_external_identities.js', 'src/utils/totp.js', 'src/ws/index.js',
  'src/services/provider-console/gateway.js', 'src/services/provider-console/byte-channel.js'];
(async () => {
  const c = await docker.createContainer({ name: marker, Image: process.env.DD_SMOKE_APP_IMAGE,
    Entrypoint: ['node'], Cmd: ['/app/scripts/fixtures/password-reset-smoke.cjs'], WorkingDir: '/app',
    Labels: { 'com.docker-dash.reset-smoke': marker },
    Env: ['APP_ENV=test', 'DB_PATH=/tmp/reset-fixture.db', 'ENV_FILE=/nonexistent', 'SMTP_HOST=fixture.invalid',
      'PUBLIC_URL=https://dashboard.example.test', 'LOG_LEVEL=error', 'DD_MODE=standalone',
      'APP_SECRET=' + crypto.randomBytes(32).toString('hex'), 'ENCRYPTION_KEY=' + crypto.randomBytes(32).toString('hex')],
    HostConfig: { NetworkMode: 'none', Memory: 536870912, NanoCpus: 1000000000, PidsLimit: 128,
      CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'] },
  });
  try {
    const pack = tar.pack();
    const tlsFixtures=['ca.pem','server.pem','server.key','wrong-name.pem'].map(name=>'src/__tests__/fixtures/provider-tls/'+name);
    for (const path of ['scripts/fixtures/password-reset-smoke.cjs', 'scripts/fixtures/oidc-flow-smoke.cjs', 'scripts/fixtures/api-key-smoke.cjs',
      'scripts/fixtures/oidc-transport-smoke.cjs', 'scripts/fixtures/scim-security-smoke.cjs',
      'scripts/fixtures/workload-replay-smoke.cjs', ...tlsFixtures, ...(overlay ? sources : [])]) {
      pack.entry({ name: path, mode: 0o644, uid: 1000, gid: 1000 }, fs.readFileSync(path));
    }
    pack.finalize(); await c.putArchive(pack, { path: '/app' });
    const hashes = {};
    for (const path of sources) {
      const expected = crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');
      const actual = await hashArchive(await c.getArchive({ path: '/app/' + path }), path.split('/').pop());
      assert.equal(actual.sha256, expected, 'Test source mismatch: ' + path); hashes[path] = expected;
    }
    await c.start();
    const deadline = Date.now() + 45000;
    let info;
    do {
      info = await c.inspect(); if (!info.State.Running) break;
      assert.ok(Date.now() < deadline, 'Reset smoke deadline exceeded');
      await new Promise(resolve => setTimeout(resolve, 250));
    } while (true);
    const logs = await c.logs({ stdout: true, stderr: true });
    let output = '';
    for (let offset = 0; offset < logs.length;) {
      const length = logs.readUInt32BE(offset + 4); output += logs.subarray(offset + 8, offset + 8 + length).toString(); offset += length + 8;
    }
    assert.equal(info.State.ExitCode, 0, output.slice(-8192)); assert.equal(info.State.OOMKilled, false);
    const result = JSON.parse(output.split('\n').find(line => line.startsWith('{"checks":')));
    console.log(JSON.stringify({ at: new Date().toISOString(), image: process.env.DD_SMOKE_APP_IMAGE,
      mode: overlay ? 'source-overlay' : 'bundled-image', sourceHashes: hashes, ...result }));
  } finally {
    const info = await c.inspect(); assert.equal(info.Config.Labels['com.docker-dash.reset-smoke'], marker);
    await c.remove({ force: true, v: true }); console.log('Removed owned reset canary ' + marker);
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
