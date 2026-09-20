'use strict';
// Real HTTP, native SQLite and RSA verification, with an in-memory provider.
// Invoked only inside the owned network-none authentication canary container.
module.exports = async function oidcFlowChecks(endpoint, db, checks) {
  const assert = require('node:assert/strict'), crypto = require('node:crypto');
  const config = require('/app/src/config'), cache = require('/app/src/routes/auth')._oidcCacheInternals;
  const saved = { ...config.oidc }, savedSecure = config.session.secureCookie, savedStrict = config.security.isStrict;
  const issuer = 'https://identity.example.test', keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  let claims, badToken = false, tokenCalls = 0, verifier;
  function sign() {
    const input = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture' })).toString('base64url') + '.' + Buffer.from(JSON.stringify(claims)).toString('base64url');
    return input + '.' + crypto.sign('sha256', Buffer.from(input), keys.privateKey).toString('base64url');
  }
  const get = (path, cookie) => fetch(endpoint + path, { redirect: 'manual', signal: AbortSignal.timeout(5000), headers: cookie ? { Cookie: cookie } : {} });
  const callback = (flow, cookie = flow.cookie) => get('/api/auth/oidc/callback?' + new URLSearchParams({ state: flow.params.get('state'), code: 'fixture-code' }), cookie);
  async function start() {
    const response = await get('/api/auth/oidc/login'); assert.equal(response.status, 200);
    const params = new URL((await response.json()).url).searchParams;
    claims = { iss: issuer, sub: 'fixture-subject', aud: 'fixture-client', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+300,
      nonce: params.get('nonce'), preferred_username: 'native-oidc-fixture', email: 'native-oidc@example.test' };
    return { params, cookie: response.headers.getSetCookie()[0].split(';')[0] };
  }
  try {
    Object.assign(config.oidc, { enabled: true, issuerUrl: issuer, clientId: 'fixture-client', clientSecret: 'fixture-secret', redirectUri: endpoint + '/api/auth/oidc/callback', adminGroups: [], operatorGroups: [], viewerGroups: [], defaultRole: 'viewer' });
    config.session.secureCookie = false; config.security.isStrict = false; cache.clear();
    cache.setFetcher(async (url, options) => {
      if (url.endsWith('openid-configuration')) return { status: 200, body: { issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', jwks_uri: issuer + '/jwks', userinfo_endpoint: issuer + '/userinfo' } };
      if (url.endsWith('/jwks')) return { status: 200, body: { keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'fixture' }] } };
      if (url.endsWith('/token')) { tokenCalls++; verifier = new URLSearchParams(options.body).get('code_verifier'); return { status: 200, body: { access_token: 'fixture-access', id_token: badToken ? 'invalid' : sign() } }; }
      throw Error('Unexpected provider call, including forbidden userinfo fallback');
    });
    const first = await start();
    assert.equal((await callback(first, null)).status, 400); assert.equal(tokenCalls, 0);
    assert.ok(db.prepare('SELECT state FROM oidc_states WHERE state=?').get(first.params.get('state')));
    checks.push('native-oidc-foreign-browser-denied-before-state-consumption');
    const results = await Promise.all([callback(first), callback(first)]);
    assert.deepEqual(results.map(r => r.status).sort(), [302,400]); assert.equal(tokenCalls, 1);
    assert.equal(crypto.createHash('sha256').update(verifier).digest('base64url'),first.params.get('code_challenge'));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions JOIN users ON users.id=sessions.user_id WHERE username='native-oidc-fixture'").get().n, 1);
    checks.push('native-oidc-pkce-and-single-session-concurrent-callback');
    const second = await start(); claims.nonce = 'wrong';
    assert.equal((await callback(second)).status, 401);
    checks.push('native-oidc-mismatched-nonce-denied');
    const third = await start(); badToken = true;
    assert.equal((await callback(third)).status, 401);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions JOIN users ON users.id=sessions.user_id WHERE username='native-oidc-fixture'").get().n, 1);
    checks.push('native-oidc-invalid-id-token-no-userinfo-bypass');
  } finally {
    cache.clear(); cache.resetFetcher(); Object.assign(config.oidc, saved);
    config.session.secureCookie = savedSecure; config.security.isStrict = savedStrict;
  }
};
