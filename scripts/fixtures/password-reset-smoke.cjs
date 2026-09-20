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

async function raceRedeem(code, environments) {
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
    console.log(JSON.stringify({ checks, emailMocked: true, externalNetwork: false, sqlite: db.prepare('SELECT sqlite_version() version').get().version }));
  } finally {
    release({ ok: true }); delivery.stop(); await delivery.whenIdle();
    await new Promise(resolve => server.close(resolve));
  }
}
main().then(() => process.exit(0), error => { console.error(error.message); process.exit(1); });
