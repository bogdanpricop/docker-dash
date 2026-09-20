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
    const children = ['first-hash', 'second-hash'].map(hash => {
      const child = spawn(process.execPath, ['-e', childCode], { env: { ...process.env, SMOKE_TOKEN: raw, SMOKE_HASH: hash }, stdio: ['pipe', 'pipe', 'pipe'] });
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
    const results = await Promise.all(children.map(child => child.done));
    assert.equal(results.filter(result => result.redeemed).length, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='smoke_reset_committed'").get().n, 1);
    assert.equal(tokens.find(db, raw), null);
    checks.push('native-sqlite-cross-process-single-redemption-and-audit');
    console.log(JSON.stringify({ checks, emailMocked: true, externalNetwork: false, sqlite: db.prepare('SELECT sqlite_version() version').get().version }));
  } finally {
    release({ ok: true }); delivery.stop(); await delivery.whenIdle();
    await new Promise(resolve => server.close(resolve));
  }
}
main().then(() => process.exit(0), error => { console.error(error.message); process.exit(1); });
