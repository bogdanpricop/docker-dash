'use strict';

// Upgrade an owned fixture volume from the previous deployed image. Neither
// container can reach external networks, host data or a Docker socket.
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const Docker = require('dockerode'), { Writable } = require('node:stream');
const url = new URL(process.env.DD_SMOKE_DOCKER_URL);
assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.protocol, 'http:');
const beforeImage = process.env.DD_UPGRADE_FROM_IMAGE;
const afterImage = process.env.DD_SMOKE_APP_IMAGE;
for (const id of [beforeImage, afterImage]) assert.match(id || '', /^sha256:[a-f0-9]{64}$/);
assert.notEqual(beforeImage, afterImage);
const docker = new Docker({ host: url.hostname, port: Number(url.port), timeout: 30000 });
const marker = 'dd-auth-upgrade-' + crypto.randomBytes(6).toString('hex');
const label = 'com.docker-dash.auth-upgrade';
const env = ['APP_ENV=production','DB_PATH=/data/upgrade.db','LOG_LEVEL=error',
  'PUBLIC_URL=https://dashboard.example.test','DOCKER_SOCKET=/nonexistent/docker.sock',
  'APP_SECRET=' + crypto.randomBytes(32).toString('hex'), 'ENCRYPTION_KEY=' + crypto.randomBytes(32).toString('hex')];
const seed = `const db=require('./src/db').getDb(),auth=require('./src/services/auth'),fs=require('fs'),crypto=require('crypto');
  const {encrypt,sha256}=require('./src/utils/crypto'),bcrypt=require('bcrypt');
  const id=Number(db.prepare("INSERT INTO users(username,email,password_hash,role,is_active,must_change_password,totp_enabled,totp_secret,recovery_codes) VALUES ('upgrade-user','upgrade@example.test',?,'admin',1,0,1,?,?)")
    .run(bcrypt.hashSync('UpgradeFixture123!',4),encrypt('JBSWY3DPEHPK3PXP'),encrypt(JSON.stringify(['upgrade-recovery']))).lastInsertRowid);
  db.prepare("INSERT INTO users(username,password_hash,role,is_active) VALUES ('upgrade-disabled','fixture','viewer',0)").run();
  const session=auth._createSession(db.prepare('SELECT * FROM users WHERE id=?').get(id),'192.0.2.1','upgrade');
  const mfa=crypto.randomBytes(32).toString('hex'),reset=crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT INTO mfa_tokens(token_hash,user_id,expires_at) VALUES (?,?,datetime('now','+1 day'))").run(sha256(mfa),id);
  db.prepare("INSERT INTO password_reset_tokens(token_hash,user_id,expires_at,type) VALUES (?,?,datetime('now','+1 day'),'reset')").run(sha256(reset),id);
  fs.writeFileSync('/data/fixture.json',JSON.stringify({id,session:session.token,mfa,reset,
    user:db.prepare('SELECT username,email,password_hash,totp_secret,recovery_codes FROM users WHERE id=?').get(id)}),{mode:0o600});
  const count=db.prepare('SELECT COUNT(*) n FROM _migrations').get().n;
  if(count!==177)throw Error('Expected the pre-auth-hardening schema');
  if(db.pragma('integrity_check',{simple:true})!=='ok')throw Error('Seed integrity failed');
  db.pragma('wal_checkpoint(TRUNCATE)');db.close();console.log(JSON.stringify({seeded:true,migrations:count}));`;
const verify = `const assert=require('assert/strict'),fs=require('fs'),db=require('./src/db').getDb(),auth=require('./src/services/auth');
  const state=JSON.parse(fs.readFileSync('/data/fixture.json','utf8'));
  assert.equal(require('./src/version'),'8.96.9');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM _migrations').get().n,180);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n,2);
  assert.deepEqual(db.prepare('SELECT username,email,password_hash,totp_secret,recovery_codes FROM users WHERE id=?').get(state.id),state.user);
  assert.equal(db.prepare("SELECT is_active FROM users WHERE username='upgrade-disabled'").get().is_active,0);
  assert.ok(auth.validateSession(state.session));
  assert.ok(require('./src/services/password-reset').find(db,state.reset));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM mfa_tokens').get().n,0);
  const counter=db.prepare('SELECT totp_last_counter FROM users WHERE id=?').get(state.id).totp_last_counter;
  assert.ok(Number.isInteger(counter)&&counter>0);
  assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
  console.log('DD_AUTH_UPGRADE_RESULT '+JSON.stringify({migrations:180,usersPreserved:2,credentialsPreserved:true,existingSessionValid:true,
    unusedResetLinkValid:true,pendingMfaRevoked:true,replayBoundaryInitialized:true,integrity:'ok'}));`;

async function exec(container, code) {
  const command = await container.exec({ Cmd: ['node','-e',code], AttachStdout: true, AttachStderr: true });
  const stream = await command.start({}); let output = '';
  const sink = new Writable({ write(chunk, _encoding, done) {
    output += chunk.toString(); done(output.length > 65536 ? Error('Fixture output limit') : null);
  } });
  await new Promise((resolve,reject) => { sink.on('error',reject); stream.on('error',reject); stream.on('end',resolve); docker.modem.demuxStream(stream,sink,sink); });
  assert.equal((await command.inspect()).ExitCode,0,output.slice(-4096)); return output;
}

(async () => {
  const owned = [];
  const volume = await docker.createVolume({ Name: marker, Labels: { [label]: marker } });
  try {
    const create = async (image, suffix, overrides = {}) => {
      const container = await docker.createContainer({ name: marker + suffix, Image: image, Env: env,
        Labels: { [label]: marker }, WorkingDir: '/app',
        HostConfig: { NetworkMode: 'none', Memory: 536870912, NanoCpus: 1000000000, PidsLimit: 128,
          CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
          Mounts: [{ Type: 'volume', Source: marker, Target: '/data' }] }, ...overrides });
      owned.push(container); return container;
    };
    const previous = await create(beforeImage, '-before', { Entrypoint: ['node'], Cmd: ['-e',seed] });
    await previous.start();
    const deadline = Date.now()+30000;
    let status;
    do { status = await previous.inspect(); if (!status.State.Running) break;
      assert.ok(Date.now()<deadline,'Seed deadline exceeded'); await new Promise(resolve=>setTimeout(resolve,200));
    } while (true);
    assert.equal(status.State.ExitCode,0,(await previous.logs({stdout:true,stderr:true})).toString().slice(-4096));
    const candidate = await create(afterImage, '-after'); await candidate.start();
    await exec(candidate, `let n=0;async function check(){try{const r=await fetch('http://127.0.0.1:8101/api/health',{signal:AbortSignal.timeout(1000)});if(r.ok&&(await r.json()).version==='8.96.9')process.exit(0);}catch{}if(++n>100)process.exit(1);setTimeout(check,200)}check()`);
    const records = (await exec(candidate,verify)).split(/\r?\n/).filter(line=>line.startsWith('DD_AUTH_UPGRADE_RESULT '));
    assert.equal(records.length,1,'Missing or duplicate upgrade verification result');
    const result = JSON.parse(records[0].slice('DD_AUTH_UPGRADE_RESULT '.length));
    console.log(JSON.stringify({ marker, at: new Date().toISOString(), beforeImage, afterImage, network: 'none', ...result }));
  } finally {
    for (const container of owned.reverse()) {
      const info = await container.inspect(); assert.equal(info.Config.Labels[label],marker);
      await container.remove({ force: true, v: true });
    }
    const info = await volume.inspect(); assert.equal(info.Labels[label],marker);
    await volume.remove(); console.log('Removed owned authentication upgrade fixture and volume');
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
