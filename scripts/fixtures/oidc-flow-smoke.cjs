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
    const owner=Number(db.prepare("INSERT INTO users(username,password_hash,role) VALUES ('native-oidc-owner','fixture-hash','admin')").run().lastInsertRowid);
    const collision=await start(); badToken=false; claims.sub='native-collision-subject'; claims.preferred_username='native-oidc-owner';
    assert.equal((await callback(collision)).status,302);
    const external=db.prepare("SELECT id,role,username FROM users WHERE external_source='oidc' AND external_subject='native-collision-subject'").get();
    assert.notEqual(external.id,owner); assert.equal(external.role,'viewer');
    assert.equal(db.prepare('SELECT role FROM users WHERE id=?').get(owner).role,'admin');
    checks.push('native-oidc-local-admin-collision-isolated');
    const renamed=await start(); claims.sub='native-collision-subject'; claims.preferred_username='native-changed-profile';
    assert.equal((await callback(renamed)).status,302);
    assert.equal(db.prepare("SELECT id FROM users WHERE external_source='oidc' AND external_subject='native-collision-subject'").get().id,external.id);
    checks.push('native-oidc-stable-subject-survives-profile-rename');
    const failed=await start(); claims.sub='native-audit-failure'; claims.preferred_username='native-audit-failure';
    db.exec("CREATE TEMP TRIGGER fail_oidc_audit BEFORE INSERT ON audit_log WHEN NEW.action='oidc_login' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END");
    try {
      assert.equal((await callback(failed)).status,500);
      assert.equal(db.prepare("SELECT id FROM users WHERE external_subject='native-audit-failure'").get(),undefined);
    } finally { db.exec('DROP TRIGGER fail_oidc_audit'); }
    checks.push('native-oidc-audit-failure-rolls-back-account-and-session');
    const auth=require('/app/src/services/auth'),{apiKeys}=require('/app/src/services/misc');
    async function mappedAdmin() {
      config.oidc.adminGroups=['admins']; config.oidc.groupClaim='groups';
      const flow=await start(); claims.groups=['admins']; assert.equal((await callback(flow)).status,302);
      const user=db.prepare("SELECT id,username,role FROM users WHERE external_subject='fixture-subject' AND external_source='oidc'").get();
      return {user,session:auth._createSession(user,'127.0.0.1','fixture').token,key:apiKeys.create(user.id,{name:'oidc-native-policy'}).key};
    }
    const beforeDemotion=await mappedAdmin(), empty=await start(); claims.groups=[];
    assert.equal((await callback(empty)).status,302);
    assert.equal(db.prepare('SELECT role FROM users WHERE id=?').get(beforeDemotion.user.id).role,'viewer');
    assert.equal(auth.validateSession(beforeDemotion.session),null); assert.equal(apiKeys.validate(beforeDemotion.key),null);
    checks.push('native-oidc-empty-groups-demote-and-revoke-personal-credentials');
    const beforeDenial=await mappedAdmin(), missing=await start();
    assert.equal((await callback(missing)).status,403);
    assert.equal(auth.validateSession(beforeDenial.session),null); assert.equal(apiKeys.validate(beforeDenial.key),null);
    checks.push('native-oidc-missing-groups-refuse-and-revoke-personal-credentials');
    const beforeAudit=await mappedAdmin(), brokenAudit=await start();
    db.exec("CREATE TEMP TRIGGER fail_oidc_denial_audit BEFORE INSERT ON audit_log WHEN NEW.action='oidc_authorization_denied' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END");
    try {
      assert.equal((await callback(brokenAudit)).status,500);
      assert.equal(auth.validateSession(beforeAudit.session),null); assert.equal(apiKeys.validate(beforeAudit.key),null);
    } finally {db.exec('DROP TRIGGER fail_oidc_denial_audit');}
    checks.push('native-oidc-revocation-survives-denial-audit-failure');
    const beforeGrantAudit=await mappedAdmin(), failedGrant=await start(); claims.groups=[];
    db.exec("CREATE TEMP TRIGGER fail_oidc_grant_audit BEFORE INSERT ON audit_log WHEN NEW.action='oidc_login' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END");
    try {
      assert.equal((await callback(failedGrant)).status,500);
      assert.equal(auth.validateSession(beforeGrantAudit.session),null); assert.equal(apiKeys.validate(beforeGrantAudit.key),null);
      assert.equal(db.prepare('SELECT role FROM users WHERE id=?').get(beforeGrantAudit.user.id).role,'admin');
      assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=? AND is_valid=1').get(beforeGrantAudit.user.id).n,0);
    } finally {db.exec('DROP TRIGGER fail_oidc_grant_audit');}
    checks.push('native-oidc-savepoint-rolls-back-grant-but-commits-revocation');
  } finally {
    cache.clear(); cache.resetFetcher(); Object.assign(config.oidc, saved);
    config.session.secureCookie = savedSecure; config.security.isStrict = savedStrict;
  }
};
