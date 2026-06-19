'use strict';

// v8.7.9 — OIDC discovery + JWKS caching, force-refresh on kid miss, cooldown
// against attacker-driven DoS. Pins the standard OIDC client cache strategy
// (RFC 7517 §4.5): time-based normal TTL + event-based force-refresh on the
// kid-not-found signal, throttled per issuer.

process.env.APP_SECRET = 'test-oidc-cache';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-jest-32chars';
process.env.DB_PATH = ':memory:';

const { _oidcCacheInternals } = require('../routes/auth');

const ISSUER = 'https://login.microsoftonline.com/test-tenant/v2.0';

const DISCO_BODY = {
  authorization_endpoint: `${ISSUER}/oauth2/v2.0/authorize`,
  token_endpoint: `${ISSUER}/oauth2/v2.0/token`,
  userinfo_endpoint: `https://graph.microsoft.com/oidc/userinfo`,
  jwks_uri: `${ISSUER}/discovery/v2.0/keys`,
};
const JWK_OLD = { kid: 'key-old', kty: 'RSA', n: 'AAAA', e: 'AQAB' };
const JWK_NEW = { kid: 'key-new', kty: 'RSA', n: 'BBBB', e: 'AQAB' };

function makeFetcher(keys) {
  const calls = [];
  let currentKeys = keys;
  const f = async (url) => {
    calls.push(url);
    if (url.endsWith('/.well-known/openid-configuration')) return { status: 200, body: DISCO_BODY };
    if (url === DISCO_BODY.jwks_uri) return { status: 200, body: { keys: currentKeys } };
    throw new Error('unmocked URL: ' + url);
  };
  f.calls = calls;
  f.setKeys = (k) => { currentKeys = k; };
  return f;
}

describe('OIDC discovery + JWKS caching (v8.7.9)', () => {
  beforeEach(() => { _oidcCacheInternals.clear(); _oidcCacheInternals.resetFetcher(); });

  it('discovery: cache miss fetches once, subsequent calls hit cache', async () => {
    const fetcher = makeFetcher([JWK_OLD]);
    _oidcCacheInternals.setFetcher(fetcher);
    const a = await _oidcCacheInternals.getDiscovery(ISSUER);
    const b = await _oidcCacheInternals.getDiscovery(ISSUER);
    expect(a).toBe(b); // same reference (cache hit)
    const discoCalls = fetcher.calls.filter(u => u.endsWith('openid-configuration'));
    expect(discoCalls.length).toBe(1);
  });

  it('discovery: force=true bypasses cache', async () => {
    const fetcher = makeFetcher([JWK_OLD]);
    _oidcCacheInternals.setFetcher(fetcher);
    await _oidcCacheInternals.getDiscovery(ISSUER);
    await _oidcCacheInternals.getDiscovery(ISSUER, { force: true });
    const discoCalls = fetcher.calls.filter(u => u.endsWith('openid-configuration'));
    expect(discoCalls.length).toBe(2);
  });

  it('JWKS: cache miss fetches discovery + jwks once, then cached', async () => {
    const fetcher = makeFetcher([JWK_OLD]);
    _oidcCacheInternals.setFetcher(fetcher);
    const a = await _oidcCacheInternals.getJwks(ISSUER);
    const b = await _oidcCacheInternals.getJwks(ISSUER);
    expect(a).toBe(b);
    expect(fetcher.calls.filter(u => u.endsWith('openid-configuration')).length).toBe(1);
    expect(fetcher.calls.filter(u => u === DISCO_BODY.jwks_uri).length).toBe(1);
  });

  it('JWKS force-refresh bypasses cache and fetches fresh keys', async () => {
    const fetcher = makeFetcher([JWK_OLD]);
    _oidcCacheInternals.setFetcher(fetcher);
    const stale = await _oidcCacheInternals.getJwks(ISSUER);
    expect(stale[0].kid).toBe('key-old');
    // Simulate IdP rotation
    fetcher.setKeys([JWK_NEW]);
    const fresh = await _oidcCacheInternals.getJwks(ISSUER, { force: true });
    expect(fresh[0].kid).toBe('key-new');
  });

  it('JWKS force-refresh during cooldown returns stale cache (DoS protection)', async () => {
    const fetcher = makeFetcher([JWK_OLD]);
    _oidcCacheInternals.setFetcher(fetcher);
    await _oidcCacheInternals.getJwks(ISSUER); // warm cache
    fetcher.setKeys([JWK_NEW]);                // IdP rotates
    const first = await _oidcCacheInternals.getJwks(ISSUER, { force: true });
    expect(first[0].kid).toBe('key-new');
    const callsAfterFirstForce = fetcher.calls.filter(u => u === DISCO_BODY.jwks_uri).length;
    // A second force IMMEDIATELY after should NOT fetch — cooldown active.
    fetcher.setKeys([{ kid: 'key-even-newer', kty: 'RSA', n: 'CCCC', e: 'AQAB' }]);
    const second = await _oidcCacheInternals.getJwks(ISSUER, { force: true });
    expect(second[0].kid).toBe('key-new'); // still the cached value, NOT 'key-even-newer'
    expect(fetcher.calls.filter(u => u === DISCO_BODY.jwks_uri).length).toBe(callsAfterFirstForce);
  });

  it('verifyIdToken: real Entra-style key rotation is handled by force-refresh-on-miss', async () => {
    // 1. Warm cache with the OLD key
    const fetcher = makeFetcher([JWK_OLD]);
    _oidcCacheInternals.setFetcher(fetcher);
    await _oidcCacheInternals.getJwks(ISSUER); // cache now has JWK_OLD only

    // 2. IdP rotates to a NEW key; tokens are now signed by JWK_NEW
    fetcher.setKeys([JWK_NEW]);

    // 3. Build a token whose header references the NEW kid. We can't really
    //    sign with a fake key, but verifyIdToken's job — when given a
    //    well-formed header pointing at JWK_NEW — should at minimum REACH
    //    the signature step (proving the kid was found via force-refresh)
    //    rather than throwing "no matching JWK".
    const hdr = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'key-new', typ: 'JWT' })).toString('base64url');
    const pld = Buffer.from(JSON.stringify({ iss: ISSUER, aud: 'client', exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url');
    const fakeToken = `${hdr}.${pld}.AAAA`;
    let threwAt = null;
    try { await _oidcCacheInternals.verifyIdToken(fakeToken, ISSUER, 'client'); }
    catch (e) { threwAt = e.message; }
    // Should NOT throw "no matching JWK" — should reach the signature step
    // (which fails because our token isn't really signed, but that's a
    // DIFFERENT error than the rotation-induced lockout we are fixing).
    expect(threwAt).not.toMatch(/no matching JWK/);
    // ... AND the force-refresh actually happened (jwks_uri called twice)
    expect(fetcher.calls.filter(u => u === DISCO_BODY.jwks_uri).length).toBeGreaterThanOrEqual(2);
  });

  it('verifyIdToken: rejects malformed JWT before touching the cache', async () => {
    let threw = null;
    try { await _oidcCacheInternals.verifyIdToken('not-a-jwt', ISSUER, 'client'); }
    catch (e) { threw = e.message; }
    expect(threw).toMatch(/Malformed JWT/);
  });
});
