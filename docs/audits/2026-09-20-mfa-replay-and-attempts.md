# MFA replay and attempt audit — 2026-09-20

Status: source checkpoint, not deployed. Both instances remain on 8.96.8; account
email URL configuration is still pending for the combined authentication rollout.

## Confirmed behavior and fix

The previous implementation verified a TOTP value without recording its counter.
Different login challenges could accept the same code, and a login code could also
authorize privileged step-up. Request quotas were per endpoint/IP; neither a
challenge nor the account had its own persisted factor-failure budget.

Migration 180 adds the last accepted TOTP counter, account MFA failure/cooldown
state and challenge attempt count. The utility matches all accepted time steps
(current plus/minus one) and returns a counter; authentication conditionally stores
only a newer counter. Enrollment, login and privileged step-up share that boundary.
Login consumption and session creation share an immediate SQLite write transaction;
storage failure rolls back both. Step-up and enrollment also consume atomically.

An MFA challenge allows five attempts in total, shared between TOTP and recovery.
The fifth valid attempt may succeed; five failed attempts permanently exhaust it.
Malformed factor input consumes an attempt when tied to a valid challenge. Account
failure state spans tokens, IPs, recovery, TOTP login, enrollment confirmation and
step-up. It uses the existing LOCKOUT_ATTEMPTS and LOCKOUT_DURATION_MS settings
(default ten failures, thirty minutes) but is separate from password failure state.
A correct password/fresh challenge does not reset it. Successful factor verification
clears it; an expired cooldown starts a new budget. Malformed stored cooldowns deny
verification. Recovery codes do not bypass the cooldown. Rejections are recorded in
the account state and bounded application warnings without factor values.

Before upgrade there is no reliable record of accepted counters. For existing
enrollments, migration 180 excludes the old current/past/future acceptance window;
with a synchronized authenticator this may require waiting up to 60 seconds after
upgrade. New enrollment starts with no counter. Replacing the stored encrypted
authenticator secret resets replay/cooldown state; password changes do not. This
preserves the boundary across password reset and prevents a password holder from
clearing the MFA failure budget by starting another login.

The one-use rule follows [RFC 6238 section 5.2](https://www.rfc-editor.org/rfc/rfc6238#section-5.2),
which requires rejecting an OTP already successfully accepted. The existing
30-second step and one-step clock-skew allowance are preserved. Counter state is
per account/enrollment, not an assertion that all MFA security requirements are met.

## Verification

- Seven selected regression cases fail against the previous auth/utility source
  without migration 180: repeated TOTP across login challenges, both login/step-up
  orders, exhaustion through TOTP/recovery/mixed guesses, and an account budget
  that cannot be bypassed by requesting another challenge.
- Twenty new tests cover those cases plus enrollment consumption, the next/older
  counter, fifth-attempt success, cooldown expiry/corruption, rollback on storage
  failure, secret replacement, malformed recovery inputs and migration upgrade/down.
- Existing expiry tests reset replay state between independent fixtures. The
  enrolled step-up test uses a fresh counter instead of reusing the enrollment code.
- Full suite: 372 suites, 4,910 tests passed, one skipped; lint passes. An earlier
  full run timed out in the existing large-script SSH early-exit test. All 17 SSH
  cases passed separately, followed by the successful complete rerun; that test
  was not weakened or skipped. The timeout log is retained as
  `.git/mfa-replay-full-tests-timeout.log`. Page-help coverage
  passes for all 60 routes. Profile help now explains MFA behavior in EN/RO and
  corrects the obsolete statement that password changes preserve other sessions.
- Native canaries pass 21 checks on each host: LAN at 2026-09-20T08:17:00.367Z,
  VPS at 2026-09-20T08:17:01.494Z. Two independent Node processes race the same code
  across two logins and login/step-up; exactly one wins. Two processes issuing six
  failed requests together stop at five persisted attempts on a shared challenge.
  The eighteen earlier authentication/transport checks also pass.
- Runtime: SQLite 3.53.4, deployed 8.96.8 image with verified source overlays.
  Containers have no external network, host data or Docker socket; SMTP/provider
  adapters are mocked. Every owned test container and anonymous volume was removed.
  These are source canaries, not a newly built image or live deployment.

Evidence: `.git/mfa-replay-{before,full-tests,lint,final}.log`,
`.git/mfa-replay-native-{lan,vps}.log`; source hashes/results are retained in JSON.

## Boundaries

TOTP is not phishing-resistant; a stolen unused code can still be raced. The
clock-skew allowance and cooldown use wall time; large clock corrections can
affect availability. An adversary with the password or an authenticated session
can cause a temporary MFA lockout. Secret replacement starts a new replay history;
administrative key migration/restore must preserve or safely reinitialize this
state. No distributed HA database consistency or real authenticator browser journey
was certified by the native process tests.

Enrollment fresh authentication, OIDC/browser binding, complete audit-failure
semantics across all auth routes and password-age parsing still require review.
The source fixes do not resolve image CVEs, LAN Docker API exposure, HTTPS/email
configuration or the pending production rollout.
