'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const puppeteer = require('puppeteer');
const launchOptions = require('./puppeteer-launch-options');

process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'test';
process.env.SECURITY_MODE = 'standard';
process.env.SESSION_SECURE_COOKIE = 'false';
process.env.CSRF_DISABLED = 'false';
process.env.RATE_LIMIT_LOGIN_MAX = '30';

async function main() {
  const app = express();
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const base = 'http://localhost:' + server.address().port;
  process.env.PUBLIC_URL = base;
  const { getDb, closeDb } = require('../src/db');
  let browser;
  try {
    const db = getDb();
    const password = 'Fixture-Only!248';
    const userId = db.prepare("INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?, ?, 'admin', 0)")
      .run('webauthn-browser', bcrypt.hashSync(password, 4)).lastInsertRowid;
    app.use(express.json(), cookieParser(), require('../src/middleware/csrf'));
    app.use('/api/auth', require('../src/routes/auth'));
    app.use('/api/auth/passkeys', require('../src/routes/passkeys'));
    app.get('/fixture', (_req, res) => res.send(`<!doctype html><html lang="en"><body>
      <form id="login"><button id="login-btn" type="button">Password</button><button id="login-passkey" type="button">Passkey</button>
      <p id="login-error" class="hidden"></p></form><section id="profile"></section></body></html>`));
    app.use(express.static(path.join(__dirname, '..', 'public')));

    browser = await puppeteer.launch(launchOptions());
    const page = await browser.newPage();
    const cdp = await page.createCDPSession();
    await cdp.send('WebAuthn.enable', { enableUI: false });
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal',
      hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(base + '/fixture');
    for (const file of ['api.js', 'utils.js', 'passkeys.js']) await page.addScriptTag({ url: base + '/js/' + file });
    await page.evaluate(async secret => {
      window.Toast = { success() {}, error(message) { window.fixtureError = message; } };
      window.Modal = { confirm: async () => true };
      const login = await Api.post('/auth/login', { username: 'webauthn-browser', password: secret });
      if (!login.user) throw new Error('Fixture password login failed');
      await Passkeys.profile(document.querySelector('#profile'));
    }, password);
    await page.type('#passkey-name', 'Virtual security key');
    await page.type('#passkey-password', password);
    await page.click('#passkey-add button');
    await page.waitForSelector('[data-passkey]');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM passkeys').get().count, 1);
    await page.evaluate(async () => {
      await Api.post('/auth/logout');
      await Passkeys.loginButton(document.querySelector('#login'), result => { window.signedIn = result; });
    });
    await page.click('#login-passkey');
    await page.waitForFunction(() => window.signedIn?.user);
    assert.equal(await page.evaluate(() => window.signedIn.user.username), 'webauthn-browser');
    assert.ok(db.prepare('SELECT last_used_at FROM passkeys').get().last_used_at);

    await page.evaluate(() => Api.post('/auth/logout'));
    db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(userId);
    const mfa = await page.evaluate(async () => {
      const ceremony = await Api.post('/auth/passkeys/login/options', {});
      const credential = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(ceremony.options) });
      const body = { challengeId: ceremony.challengeId, credential: credential.toJSON() };
      const outcome = await Api.post('/auth/passkeys/login/verify', body);
      const replay = await Api.post('/auth/passkeys/login/verify', body).then(() => null, error => error.status);
      return { mfaRequired: outcome.mfaRequired, mfaToken: Boolean(outcome.mfaToken), replay };
    });
    assert.deepEqual(mfa, { mfaRequired: true, mfaToken: true, replay: 401 });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ? AND is_valid = 1').get(userId).count, 0);

    db.prepare('UPDATE users SET totp_enabled = 0 WHERE id = ?').run(userId);
    await page.evaluate(async secret => {
      await Api.post('/auth/login', { username: 'webauthn-browser', password: secret });
      await Passkeys.profile(document.querySelector('#profile'));
    }, password);
    await page.click('[data-passkey]');
    await page.waitForFunction(() => !document.querySelector('[data-passkey]'));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM passkeys').get().count, 0);
    assert.equal(await page.evaluate(() => window.fixtureError), undefined);
    console.log('Passkey browser checks passed for enrollment, login, MFA, replay prevention and revocation');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    closeDb();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
