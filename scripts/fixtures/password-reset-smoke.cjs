'use strict';

// Runs only inside the disposable, network-isolated smoke container.
const assert = require('node:assert/strict');
const express = require('express');
const { spawn } = require('node:child_process');
const { getDb } = require('/app/src/db');
const delivery = require('/app/src/services/password-reset-delivery');
const email = require('/app/src/services/email');
const tokens = require('/app/src/services/password-reset');
const checks = [];

async function raceRedeem(code, environments, beforeRelease = async () => {}) {
    const children = environments.map(environment => {
      const child = spawn(process.execPath, ['-e', code], { env: { ...process.env, ...environment }, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', error = '';
      const ready = new Promise((resolve, reject) => {
        child.on('error', reject); child.stdout.on('data', chunk => { output += chunk; if (output.includes('READY')) resolve(); });
        child.on('exit', code => { if (!output.includes('READY')) reject(Error('Child exited before ready: ' + code)); });
      });
      child.stderr.on('data', chunk => { error += chunk; });
      const done = new Promise((resolve, reject) => {
        child.on('error', reject); child.on('exit', code => {
          if (code !== 0) return reject(Error('SQLite child failed: ' + error));
          try { resolve(JSON.parse(output.split('\n').find(line => line.startsWith('RESULT:')).slice(7))); } catch (e) { reject(e); }
        });
      });
      return { child, ready, done };
    });
    await Promise.all(children.map(child => child.ready));
    await beforeRelease();
    children.forEach(({ child }) => child.stdin.end('go'));
    return Promise.all(children.map(child => child.done));
}

async function main() {
  const db = getDb();
  const id = Number(db.prepare("INSERT INTO users(username,email,password_hash,role,is_active) VALUES ('smoke-reset','fixture@example.test','old-hash','viewer',1)").run().lastInsertRowid);
  let release, firstUrl;
  const held = new Promise(resolve => { release = resolve; });
  email.sendPasswordReset = async args => { firstUrl = args.resetUrl; return held; };
  const app = express(); app.use(express.json()); app.use('/api/auth', require('/app/src/routes/auth'));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const endpoint = 'http://127.0.0.1:' + server.address().port;
  try {
    const post = async address => {
      const response = await fetch(endpoint + '/api/auth/request-password-reset', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: address, origin: 'https://evil.example' }),
        signal: AbortSignal.timeout(2500) });
      assert.equal(response.status, 200); return response.json();
    };
    assert.deepEqual(await post('fixture@example.test'), await post('absent@example.test'));
    checks.push('identical-http-response-before-smtp-completes');
    release({ ok: true }); await delivery.whenIdle();
    assert.equal(new URL(firstUrl).origin, 'https://dashboard.example.test');
    checks.push('configured-link-origin');

    require('/app/src/services/rate-limiter-memory')._reset();
    let sent = 0; email.sendPasswordReset = async () => { sent++; return { ok: true }; };
    for (let n = 0; n < 6; n++) delivery.enqueue({ email: n % 2 ? 'FIXTURE@EXAMPLE.TEST' : 'fixture@example.test', ip: '192.0.2.' + n });
    await delivery.whenIdle(); assert.equal(sent, 3);
    checks.push('account-quota-across-case-and-ip');

    // Two independent Node processes compete for the same native SQLite token.
    const issued = tokens.issue(db, id, 'reset', 900000, 'fixture@example.test'), raw = new URL(issued.url).searchParams.get('token');
    const childCode = `const tokens=require('/app/src/services/password-reset'),db=require('/app/src/db').getDb();
      process.stdin.once('data',()=>{const row=tokens.consume(db,process.env.SMOKE_TOKEN,process.env.SMOKE_HASH,current=>require('/app/src/services/audit').log({userId:current.uid,username:current.username,action:'smoke_reset_committed'}));
      console.log('RESULT:'+JSON.stringify({redeemed:!!row}));db.close();process.exit(0)});console.log('READY');`;
    const results = await raceRedeem(childCode, ['first-hash','second-hash'].map(hash => ({ SMOKE_TOKEN: raw, SMOKE_HASH: hash })));
    assert.equal(results.filter(result => result.redeemed).length, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='smoke_reset_committed'").get().n, 1);
    assert.equal(tokens.find(db, raw), null);
    checks.push('native-sqlite-cross-process-single-redemption-and-audit');

    const auth = require('/app/src/services/auth'), { sha256, encrypt } = require('/app/src/utils/crypto');
    const expired = new Date(Date.now() - 1000).toISOString();
    db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)').run(sha256('expired-session'),id,expired);
    assert.equal(auth.validateSession('expired-session'), null);
    const denied = await fetch(endpoint + '/api/auth/me', { headers: { Authorization: 'Bearer expired-session' } });
    assert.equal(denied.status, 401);
    checks.push('expired-iso-session-refused-by-real-http-auth');
    db.prepare('INSERT INTO mfa_tokens(token_hash,user_id,expires_at) VALUES (?,?,?)').run(sha256('expired-mfa'),id,expired);
    assert.equal(auth.verifyMfaRecovery('expired-mfa','fixture','127.0.0.1','native').error, 'Invalid or expired MFA token');
    checks.push('expired-iso-mfa-refused');
    for (let n=0;n<require('/app/src/config').rateLimit.loginMaxAttempts;n++) auth.logAttempt('192.0.2.9','fixture',id,false,'native');
    assert.equal(auth.isIpLocked('192.0.2.9'), true);
    checks.push('production-login-timestamps-enforce-ip-lockout');

    db.prepare('UPDATE users SET totp_enabled=1,recovery_codes=? WHERE id=?').run(encrypt(JSON.stringify(['native-recovery-fixture'])),id);
    for (const challenge of ['mfa-race-one','mfa-race-two']) db.prepare('INSERT INTO mfa_tokens(token_hash,user_id,expires_at) VALUES (?,?,?)')
      .run(sha256(challenge),id,new Date(Date.now()+60000).toISOString());
    const before = db.prepare('SELECT COUNT(*) n FROM sessions').get().n;
    const mfaChild = `const auth=require('/app/src/services/auth'),db=require('/app/src/db').getDb();
      process.stdin.once('data',()=>{const result=auth.verifyMfaRecovery(process.env.SMOKE_CHALLENGE,'native-recovery-fixture','127.0.0.1','native');
      console.log('RESULT:'+JSON.stringify({redeemed:!!result.token}));db.close();process.exit(0)});console.log('READY');`;
    const mfaResults = await raceRedeem(mfaChild,['mfa-race-one','mfa-race-two'].map(challenge => ({ SMOKE_CHALLENGE: challenge })));
    assert.equal(mfaResults.filter(result => result.redeemed).length, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n, before + 1);
    checks.push('native-cross-process-recovery-code-consumed-once');

    const { WsServer } = require('/app/src/ws'), WebSocket = require('ws');
    const websocketServer = new WsServer();
    // No Docker event sources are needed for this isolated session-lifecycle test.
    websocketServer._startAllEventStreams = () => {};
    websocketServer.attach(server);
    try {
      for (const mode of ['input','broadcast','idle-expiry']) {
        const session = auth._createSession({id,username:'smoke-reset',role:'viewer'},'127.0.0.1','native-ws');
        const socket = new WebSocket('ws://127.0.0.1:'+server.address().port+'/ws', {
          headers: {Cookie:require('/app/src/config').session.cookieName+'='+session.token},
        });
        const messages=[]; socket.on('message',data=>messages.push(JSON.parse(data)));
        const closed = new Promise(resolve=>socket.once('close',code=>resolve(code)));
        try {
          await new Promise((resolve,reject)=>{socket.once('message',resolve);socket.once('error',reject);});
          if(mode==='idle-expiry') db.prepare("UPDATE sessions SET expires_at=datetime('now','-1 second') WHERE token_hash=?").run(sha256(session.token));
          else auth.logout(session.token);
          if(mode==='input') socket.send(JSON.stringify({type:'ping'}));
          if(mode==='broadcast') websocketServer._localBroadcastAll('private',{value:'not-delivered'});
          let deadline;
          try {
            const code = await Promise.race([closed,new Promise(resolve=>{deadline=setTimeout(()=>resolve('not-closed'),mode==='idle-expiry'?6500:1500);})]);
            assert.equal(code,4003,'WebSocket must close after '+mode);
          } finally { clearTimeout(deadline); }
          assert.deepEqual(messages.map(message=>message.type),['connected']);
          checks.push('real-websocket-revocation-'+mode);
        } finally { socket.terminate(); }
      }
    } finally {
      for(const socket of websocketServer.wss.clients) socket.terminate();
      await new Promise(resolve=>websocketServer.wss.close(resolve));
    }
    await providerConsoleChecks(server, auth, db, id, WebSocket);
    await credentialLifecycleChecks(auth, db);
    await mfaReplayChecks(auth, db);
    console.log(JSON.stringify({ checks, emailMocked: true, providerMocked: true, externalNetwork: false, sqlite: db.prepare('SELECT sqlite_version() version').get().version }));
  } finally {
    release({ ok: true }); delivery.stop(); await delivery.whenIdle();
    await new Promise(resolve => server.close(resolve));
  }
}

async function mfaReplayChecks(auth, db) {
  const { encrypt, sha256 } = require('/app/src/utils/crypto'), totp = require('/app/src/utils/totp');
  const code = `const auth=require('/app/src/services/auth'),db=require('/app/src/db').getDb();
    process.stdin.once('data',()=>{const result=process.env.SMOKE_KIND==='stepup'
      ? auth.verifyStepUpMfa(Number(process.env.SMOKE_USER),process.env.SMOKE_CODE)
      : auth.verifyMfa(process.env.SMOKE_TOKEN,process.env.SMOKE_CODE,'192.0.2.200','native');
      console.log('RESULT:'+JSON.stringify({accepted:!!(result.token||result.success)}));db.close();process.exit(0)});console.log('READY');`;
  for (const mode of ['login-login','login-stepup']) {
    const secret = totp.generateSecret();
    const id = Number(db.prepare("INSERT INTO users(username,password_hash,role,is_active,totp_enabled,totp_secret) VALUES (?,'fixture','viewer',1,1,?)")
      .run('native-replay-' + mode, encrypt(secret)).lastInsertRowid);
    const environments = [0,1].map(n => {
      const token = mode + '-' + n;
      db.prepare("INSERT INTO mfa_tokens(token_hash,user_id,expires_at) VALUES (?,?,datetime('now','+5 minutes'))").run(sha256(token),id);
      return { SMOKE_KIND: mode === 'login-stepup' && n === 1 ? 'stepup' : 'login', SMOKE_TOKEN: token, SMOKE_USER: String(id), SMOKE_CODE: totp.generateTOTP(secret) };
    });
    // Both processes use exactly the same code even at a time-step boundary.
    environments[1].SMOKE_CODE = environments[0].SMOKE_CODE;
    const results = await raceRedeem(code,environments);
    assert.equal(results.filter(result => result.accepted).length,1);
    checks.push('native-cross-process-single-use-totp-' + mode);
  }
  const id = Number(db.prepare("INSERT INTO users(username,password_hash,role,is_active,totp_enabled,totp_secret) VALUES ('native-attempt-limit','fixture','viewer',1,1,?)")
    .run(encrypt(totp.generateSecret())).lastInsertRowid);
  db.prepare("INSERT INTO mfa_tokens(token_hash,user_id,expires_at) VALUES (?,?,datetime('now','+5 minutes'))").run(sha256('native-shared-challenge'),id);
  const attempts = `const auth=require('/app/src/services/auth'),db=require('/app/src/db').getDb();
    process.stdin.once('data',()=>{for(let n=0;n<3;n++)auth.verifyMfa('native-shared-challenge','invalid','192.0.2.201','native');
      console.log('RESULT:'+JSON.stringify({done:true}));db.close();process.exit(0)});console.log('READY');`;
  await raceRedeem(attempts,[{},{}]);
  assert.deepEqual(db.prepare('SELECT attempts,used FROM mfa_tokens WHERE token_hash=?').get(sha256('native-shared-challenge')),{attempts:5,used:1});
  assert.equal(db.prepare('SELECT mfa_failed_attempts n FROM users WHERE id=?').get(id).n,5);
  checks.push('native-cross-process-challenge-five-attempt-bound');
}

async function credentialLifecycleChecks(auth, db) {
  const bcrypt = require('bcrypt');
  const { encrypt } = require('/app/src/utils/crypto');
  const totp = require('/app/src/utils/totp');
  const hash = bcrypt.hashSync('NativeCredential123!', 4);
  const id = Number(db.prepare("INSERT INTO users(username,password_hash,role,is_active,must_change_password,totp_enabled,totp_secret,recovery_codes) VALUES ('native-credentials',?,'viewer',1,0,1,?,?)")
    .run(hash, encrypt(totp.generateSecret()), encrypt(JSON.stringify(['native-lifecycle-recovery']))).lastInsertRowid);
  const pending = await auth.login('native-credentials', 'NativeCredential123!', '192.0.2.100', 'native');
  assert.ok(pending.mfaToken);
  await auth.resetPassword(id, 'ReplacedCredential123!');
  assert.ok(auth.verifyMfaRecovery(pending.mfaToken, 'native-lifecycle-recovery', '192.0.2.100', 'native').error);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM mfa_tokens WHERE user_id=?').get(id).n, 0);
  checks.push('native-reset-revokes-outstanding-mfa-proof');

  const loginCode = `const bcrypt=require('bcrypt'),compare=bcrypt.compare,auth=require('/app/src/services/auth'),db=require('/app/src/db').getDb();
    bcrypt.compare=async(...args)=>{const valid=await compare(...args); console.log('READY'); await new Promise(resolve=>process.stdin.once('data',resolve));return valid;};
    auth.login('native-credentials',process.env.SMOKE_PASSWORD,process.env.SMOKE_IP,'native-concurrent').then(result=>{
      console.log('RESULT:'+JSON.stringify({token:!!result.token,mfa:!!result.mfaToken,error:!!result.error}));db.close();process.exit(0);
    },()=>process.exit(1));`;
  const raced = await raceRedeem(loginCode, [{ SMOKE_PASSWORD: 'ReplacedCredential123!', SMOKE_IP: '192.0.2.101' }],
    () => auth.resetPassword(id, 'FinalCredential123!'));
  assert.deepEqual(raced, [{ token: false, mfa: false, error: true }]);
  checks.push('native-cross-process-login-cannot-outlive-password-reset');

  const attempts = await raceRedeem(loginCode, [1, 2].map(n => ({
    SMOKE_PASSWORD: 'wrong', SMOKE_IP: '192.0.2.' + (110+n), LOCKOUT_ATTEMPTS: '2',
  })));
  assert.ok(attempts.every(result => result.error && !result.token && !result.mfa));
  const locked = db.prepare('SELECT failed_attempts,is_locked FROM users WHERE id=?').get(id);
  assert.deepEqual(locked, { failed_attempts: 2, is_locked: 1 });
  checks.push('native-cross-process-failures-enforce-account-lockout');
}

async function providerConsoleChecks(server, auth, db, id, WebSocket) {
  const { EventEmitter } = require('node:events');
  const broker = require('/app/src/services/provider-console/broker');
  const providers = require('/app/src/services/provider-console/providers');
  const permissions = require('/app/src/services/host-permissions');
  const access = require('/app/src/services/provider-console/access');
  let current, connected = false;
  broker.consume = () => current;
  broker.markConnected = () => { connected = true; };
  broker.markClosed = () => {};
  permissions.resolveEffectivePermission = () => 'operate';
  access.effective = () => ({ locked: false });
  const gateway = require('/app/src/services/provider-console/gateway');
  const wss = gateway.attach(server);
  db.prepare("UPDATE users SET role='operator' WHERE id=?").run(id);
  const host = '127.0.0.1:' + server.address().port;
  try {
    for (const mode of ['input', 'output', 'idle']) {
      connected = false;
      current = { id: 'native-console-' + mode, host_id: 1, resource_id: 'ddr_vm_' + 'a'.repeat(26), provider_type: 'fixture' };
      const stream = new EventEmitter(); let writes = 0, closedUpstream = 0;
      stream.write = (_data, callback) => { writes++; callback?.(); };
      stream.destroy = () => stream.emit('close');
      providers.openForSession = async () => ({ protocol: 'serial', stream, close: () => { closedUpstream++; } });
      const session = auth._createSession({ id, username: 'smoke-reset', role: 'operator' }, '127.0.0.1', 'native-console');
      const socket = new WebSocket('ws://' + host + gateway.PATH, ['binary', 'dd-console.' + 'A'.repeat(43)], {
        headers: { origin: 'http://' + host, Cookie: require('/app/src/config').session.cookieName + '=' + session.token },
      });
      const closed = new Promise(resolve => socket.once('close', resolve));
      const messages = []; socket.on('message', data => messages.push(data.toString()));
      try {
        await new Promise((resolve, reject) => { socket.once('message', resolve); socket.once('error', reject); });
        socket.send('{"type":"console:attach"}');
        const attachDeadline = Date.now() + 1500;
        while (!connected) { assert.ok(Date.now() < attachDeadline); await new Promise(resolve => setTimeout(resolve, 5)); }
        auth.logout(session.token);
        if (mode === 'input') socket.send(Buffer.from('denied'));
        if (mode === 'output') stream.emit('data', Buffer.from('private'));
        let timer;
        try {
          assert.equal(await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => resolve('not-closed'), 6500); })]), 4003);
        } finally { clearTimeout(timer); }
        assert.equal(writes, 0); assert.equal(closedUpstream, 1);
        assert.equal(messages.length, 1); assert.equal(JSON.parse(messages[0]).type, 'console:ready');
        checks.push('real-provider-console-revocation-' + mode);
      } finally { socket.terminate(); }
    }
    const ByteChannel = require('/app/src/services/provider-console/byte-channel');
    const stream = new EventEmitter(); stream.destroy = () => {};
    const channel = new ByteChannel(stream);
    stream.emit('data', Buffer.from([1]));
    const pending = channel.readExact(2, 1000);
    setTimeout(() => stream.emit('data', Buffer.from([2])), 20);
    assert.deepEqual(await pending, Buffer.from([1, 2])); channel.destroy();
    checks.push('native-fragmented-console-read-allows-transport-progress');
  } finally {
    for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve));
  }
}
main().then(() => process.exit(0), error => { console.error(error.message); process.exit(1); });
