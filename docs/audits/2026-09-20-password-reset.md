# Password reset audit — 2026-09-20

Status: source checkpoint; not deployed. Both live installations still run
8.96.8. The configured account-email URL is `http://localhost:8101` on both,
with SMTP enabled. The user has been asked for the externally reachable URLs
before rollout. No live password, token, SMTP configuration or account was changed.

## Confirmed defects and changes

- Public reset and admin reset/invitation accepted a caller-provided `origin`.
  They now construct links exclusively from PUBLIC_URL, falling back to BASE_URL.
  HTTP(S), an optional path prefix and no credentials/query/fragment are accepted.
  Configure HTTPS for public use; HTTP remains supported for existing LAN setups.
- The public endpoint logged reset URLs when SMTP was missing or failed. It now
  refuses issuance without SMTP and revokes only the failed delivery's token.
  SMTP transport errors are reduced to a fixed message and allowlisted error code
  before logging or propagation; the raw message/body is not retained as a cause.
- ISO timestamps were compared lexically to SQLite timestamps. An already-expired
  token from the same day could still be accepted. Numeric date comparison now
  handles both formats and rejects malformed dates, used tokens and inactive users.
- Concurrent requests could both pass validation before bcrypt. Redemption now
  rechecks under an immediate SQLite write transaction after hashing, consumes once,
  writes the password, invalidates all sessions/remaining links and writes the audit.
  Audit/storage failure rolls everything back. No schema migration is required.
- Password changes and admin resets invalidate outstanding recovery/invitation
  links. Authenticated changes use the previously verified password hash as a
  compare-and-swap condition and recheck account activity after hashing.
- Email changes and deactivation invalidate links permanently, including after
  reactivation. Admin issuance routes now also enforce writeable mode.
- Public and admin reset lifetimes are both 15 minutes, matching the reset email;
  invitations remain 24 hours. Previously issued tokens retain their stored expiry.
- The reset page sets no-referrer and removes the token query from its current
  browser-history entry after reading it. Validation/submission retain the token
  only in the page's closure. This does not remove the original request from proxy
  access logs, previously captured history or email infrastructure.

## Verification

- The first nine route regression cases failed against the original code.
- 25 new Jest cases exercise the actual Express routes/SQLite transactions and
  mocked SMTP, concurrent redemption, expiry during hashing, audit/storage rollback,
  stale password authorization, link invalidation and transport-error redaction.
- Full suite: 364 suites, 4,787 passing tests, one skipped; lint passes.
- Chrome 153.0.8010.36 fixture: query removed, validation and reset retain the memory
  token, API requests have no Referer, and the success view renders. API responses
  were mocked and external networking blocked; no email was sent.
- Live configuration checks used SSH with the existing user's key and printed only
  URL structure, SMTP-enabled booleans and version. They did not expose credentials.

Local evidence: `.git/reset-security-before.log`, `reset-security-full-tests.log`,
`reset-security-lint.log`, `reset-security-browser.log`, `reset-security-live-config.json`.
Ignored local evidence is not part of the Git artifact; reproducible regression
tests are committed under `src/__tests__/password-reset-security.test.js` and
`src/__tests__/email-error-redaction.test.js`.

## Remaining boundaries

Public bodies remain generic, but awaiting SMTP still exposes a timing difference
for existing accounts. A bounded delivery queue/account-specific abuse controls
remain follow-up work; this checkpoint does not claim enumeration resistance.
Historical reset URLs in old logs/backups are not erased or globally revoked.
Recovery-page reload now requires reopening the original email link. Real SMTP
delivery, HTTPS routing, path-prefix proxy rewrites and multi-process native Linux
contention have not been validated by these tests. The documented LAN Docker API
exposure and image CVEs remain open independently of this change.

The trusted destination, short expiry, one-time token and session-invalidation
choices follow [OWASP's Forgot Password guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).
This report describes the implemented subset and its limits, not full compliance.
