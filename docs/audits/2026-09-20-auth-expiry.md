# Authentication expiry and credential consumption — 2026-09-20

Status: tested source checkpoint, not deployed. Live LAN/VPS remain 8.96.8.
The pending account-email URL question still applies to the combined rollout.

## Findings and correction

Sessions, MFA challenges and OIDC state were issued using ISO timestamps with
`T`/`Z`, while validation compared them lexically with SQLite's space-separated
`datetime('now')`. An expired credential from earlier the same day could remain
accepted. Some malformed dates also sorted as future values. Conversely, the
production login-attempt writer used SQLite timestamps that sorted before the
ISO cutoff, causing the IP lockout query to ignore recent failures. The old
lockout unit test explicitly substituted ISO timestamps and missed that path.

Validation now compares `julianday` values and rejects invalid dates. Session
listing, session/MFA cleanup and manual password-reset-token cleanup use matching
expiry semantics. Cleanup removes malformed expiry rows as well as expired/used
credentials. Login attempts and windowed security alerts parse both sides of
their time comparisons. The lockout test now calls the real production writer.
Both valid stored timestamp formats remain supported. Migration 178 adds numeric
time indexes for lockout and alert windows; query-plan assertions verify range
searches. The grouped-IP alert query explicitly selects the time index to avoid
an optimizer choice that scanned every failed login. Building the indexes adds
startup work and disk usage proportional to the existing histories.

MFA verification, challenge consumption, recovery-code removal and session creation
now share an immediate SQLite write transaction. A storage error cannot consume a
factor without creating the session, and competing processes cannot spend the same
recovery code twice. The synchronous cryptographic verification occurs under this
transaction; no provider/network wait is introduced while holding the write lock.
OIDC consumes valid state using a single conditional DELETE RETURNING before
provider I/O, closing its cross-process read/delete race.

The parser choice follows [SQLite's date/time documentation](https://www.sqlite.org/lang_datefunc.html):
`julianday` returns numeric values and accepts the supported ISO and SQLite formats,
including timezone offsets. This is compatible with the repository's bundled
SQLite 3.53.4; arbitrary JavaScript date formats are not newly accepted.

## Evidence

- Eight initial regressions failed before the correction: same-day session expiry,
  malformed session dates, expired TOTP/recovery challenges, production lockout
  timestamps, cleanup and expired OIDC state. They now pass.
- Seventeen new cases also cover valid future timestamps in both formats, real HTTP
  rejection, session-insert failure rollback, single-use MFA, mixed audit formats
  and OIDC state remaining consumed after provider failure. Notifications and OIDC
  provider requests were mocked; no email or external identity request was sent.
- Full suite: 366 suites, 4,820 passed, one skipped. Lint passes.
- Extended `scripts/smoke-password-reset.js` passed eight checks on each Docker
  host. New native checks reject expired sessions through actual HTTP auth, reject
  expired MFA, enforce production-format IP lockout, and let exactly one of two
  independent Node processes use a shared recovery code across distinct challenges.
  The four earlier reset/delivery checks also passed again.
- LAN: 2026-09-20T07:30:11.862Z; VPS: 2026-09-20T07:30:12.686Z. Both used the 8.96.8
  runtime image `sha256:1085b24aa2d0531faa15b62ae32b3ef93f92532a47d237ef978654464570741b`
  with SHA-256-verified source overlays, SQLite 3.53.4, network disabled and temporary
  data only. Owned containers/anonymous volumes were removed. These are isolated
  source checks, not evidence of a live deployment or a newly built image.

Local logs: `.git/auth-expiry-before.log`, `auth-expiry-full-tests.log`,
`auth-expiry-lint.log`, `auth-expiry-native-lan.log`, `auth-expiry-native-vps.log`.
The companion JSON preserves native results and source hashes.

## Open audit work

`src/ws/index.js` currently authenticates once and caches the user. Existing exec,
SSH and log streams need ongoing revocation/expiry/role checks, including checks
after asynchronous starts. The provider-console gateway also needs review of its
active-session lifecycle. Fixing validateSession expiry helps new checks but does
not revoke these already-open channels. This is the next authentication work item.

Further authentication review must cover login/password-change races, invalidating
pending MFA challenges on credential changes, TOTP replay across distinct challenges,
and OIDC browser binding/PKCE. This checkpoint does not certify the entire login flow.
Other raw expiry comparisons found in posture mutes, provider security exceptions,
trial monitoring and provider-lock diagnostics require their own format/behavior
review; they were not changed indiscriminately. Wall-clock jumps and multi-host
clock skew remain deployment concerns. Known image findings and LAN Docker API
exposure remain open independently of this fix.
