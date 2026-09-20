'use strict';

// Live Cloudflare API smoke test — v6.9.2
//
// Intentionally SKIPPED unless CLOUDFLARE_TEST_TOKEN is set. When provisioned
// (e.g. as a GitHub Actions secret via `env: CLOUDFLARE_TEST_TOKEN: ${{ secrets.CLOUDFLARE_TEST_TOKEN }}`),
// this test hits Cloudflare's `/user/tokens/verify` endpoint to confirm:
//
//   1. Our credential-validation path still works against the current CF API
//      (catches breaking changes upstream, deprecated endpoints, etc.)
//   2. The provided token is actually valid (not revoked)
//   3. Our format-heuristic rejects Global API Keys correctly
//
// What it deliberately does NOT do:
//   - Touch Let's Encrypt staging (requires Caddy container + domain control)
//   - Create DNS records (requires Zone:Edit scope + risk of side effects)
//   - Issue certificates end-to-end (too much infra for a unit test)
//
// Those end-to-end tests live in a separate staging soak — see
// docs/planning/v6.5/letsencrypt-wizard/README.md. This is the minimal slice
// that CI can safely run on every push when the secret is present.

process.env.APP_ENV = 'test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-for-jest-32chars';

const HAS_TOKEN = Boolean(process.env.CLOUDFLARE_TEST_TOKEN);

// Pattern: `(CONDITION ? describe : describe.skip)(...)`. Jest runs this as
// normal suite when token is set; as skipped placeholder otherwise. The
// suite block still appears in test output so "0 tests ran" doesn't feel
// like silent failure — you see explicit "skipped".

const runOrSkip = HAS_TOKEN ? describe : describe.skip;

runOrSkip('Cloudflare live API — credential validation (requires CLOUDFLARE_TEST_TOKEN)', () => {
  const dnsProviders = require('../services/dns-providers');

  it('validates a real scoped Cloudflare token successfully', async () => {
    const result = await dnsProviders.validate('cloudflare', {
      api_token: process.env.CLOUDFLARE_TEST_TOKEN,
    });
    // A working token: ok=true with a "looks good" message
    // A revoked/invalid token: ok=false with CF error verbatim
    // Either way, the call completes — we assert CF didn't return a network-level failure.
    expect(result).toHaveProperty('ok');
    expect(result).toHaveProperty('message');
    if (!result.ok) {
      console.warn('Cloudflare token validation returned ok=false:', result.message);
    }
    // In CI, we expect a valid token. Locally, a dev-supplied revoked token
    // would log the warning above and fail here — desired behavior.
    expect(result.ok).toBe(true);
  }, 15_000);

});

describe('Cloudflare credential validation — offline rejection', () => {
  const dnsProviders = require('../services/dns-providers');

  it('rejects a deliberately malformed token without hitting the API', async () => {
    // 37 hex chars = old Cloudflare Global API Key format. We reject these
    // client-side before calling CF. This test runs even with a valid
    // CLOUDFLARE_TEST_TOKEN because it uses a synthetic bad value.
    const result = await dnsProviders.validate('cloudflare', {
      api_token: 'a'.repeat(37),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Global API Key/i);
  });

  it('rejects empty credentials with a clear error', async () => {
    const result = await dnsProviders.validate('cloudflare', {});
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/api_token/);
  });
});

// Always-present marker so test runners report something when the suite is
// skipped — helps debug "was this test actually touched?" in CI logs.
describe('Cloudflare live API — runtime environment', () => {
  it('reports whether CLOUDFLARE_TEST_TOKEN is configured', () => {
    // This test always passes — it's just a visible marker.
    if (!HAS_TOKEN) {
      console.log('[acme-cloudflare-live] CLOUDFLARE_TEST_TOKEN not set — live tests SKIPPED');
    }
    expect(typeof HAS_TOKEN).toBe('boolean');
  });
});
