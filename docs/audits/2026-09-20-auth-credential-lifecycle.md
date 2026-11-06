# Credential lifecycle audit — 2026-09-20

Status: source checkpoint, not deployed. Both live instances remain on 8.96.8;
the combined authentication rollout still awaits the account-email URL clarification.

## Confirmed findings

- Resetting a password left existing MFA challenges usable. A challenge represents
  a previously verified password; completing it could create a fresh session after
  the old password and sessions were revoked.
- Login read account state before asynchronous bcrypt/directory verification and
  issued credentials from that snapshot afterward. Concurrent reset, account or
  factor changes could therefore be bypassed by an already-running login.
- Concurrent failed logins overwrote the same failure count instead of accumulating
  toward lockout. Successful in-flight verification could also clear a newer lock.
- MFA setup could overwrite an enabled authenticator, and repeated enable could
  regenerate recovery codes. Existing sessions could survive disable/reactivate.

Five regression tests fail against the previous implementation: pending challenge
after admin reset, login completing after reset, concurrent failure counting,
overwriting enrollment, and reviving a session through reactivation. The comparison
temporarily used the old auth source and omitted the new migration's behavior;
all working files were restored afterward.

## Changes

Migration 179 adds users.auth_version and SQLite triggers. A changed password hash,
authentication source, active flag, TOTP secret or enabled flag increments the
version and deletes the user's pending MFA challenges. Password/source/activity
changes additionally invalidate sessions and outstanding reset links. Trigger work
shares the mutating statement's transaction and rolls back with it. MFA deletion
uses a new user_id index; existing session/reset user indexes remain in use.

At upgrade, existing MFA challenges are cleared because their password proof may
predate a credential change. Users at the MFA screen must repeat login. The
migration itself preserves established sessions and reset links. Application code
requires migration 179 before accepting login requests; normal startup runs it.

After bcrypt/directory verification, login opens an immediate write transaction,
reloads the account, checks the credential version/activity and current account/IP
lockout, then updates failures or issues a session/MFA challenge. Password hashing
and external directory I/O stay outside that transaction. Current role and account
flags are used. Password change and MFA disable also compare the version, covering
deactivation/reactivation while their password verification was pending.

Setup/enable run transactionally, require an active account and refuse replacing
an enabled factor. TOTP/recovery login requires MFA to still be enabled. All four
MFA configuration HTTP routes apply the existing writeable policy gate. Existing
route audit events are retained; database triggers add revocation to the same
credential mutation, including direct application SQL writes.

## Verification

- 28 new cases cover credential mutation paths, held local/LDAP verification,
  concurrent failures, current role, account/IP lockout, reactivation, factor
  state, rollback, read-only HTTP routes and migration upgrade/down behavior.
- Full suite: 371 suites, 4,890 passed, one skipped; lint passes. The final MFA
  user index was then verified with the 53 lifecycle/reset tests and native runs.
- Existing reset tests now assert that the concurrent password/deactivation change
  itself revokes links. The step-up fixture uses its existing enrolled secret;
  it no longer overwrites enrollment as test setup.
- Eighteen native checks pass on each Docker host. Added checks cover real reset
  invalidation of an issued MFA challenge, a separate Node process held after real
  bcrypt verification while the parent resets the password, and two independent
  processes accumulating failed passwords to the configured account threshold.
  The fifteen earlier recovery/MFA/WebSocket/console checks also pass.
- Canary runtime: SQLite 3.53.4, deployed 8.96.8 image with SHA-256-verified source
  overlays including migration 179. Containers have no external network, host
  data or Docker socket. SMTP and provider adapters are mocked. All owned test
  containers and anonymous volumes were removed. Exact times/hashes are in JSON.
- Fresh npm registry checks return no outdated packages and zero npm audit
  advisories. This does not cover the unresolved findings in bundled image tools
  and operating-system packages; no dependency versions changed in this checkpoint.

Local evidence: `.git/auth-credential-lifecycle-{before,full-tests,lint,final}.log`,
`.git/auth-credential-native-{lan,vps}.log`,
`.git/npm-{outdated,audit}-auth-credentials.json`. The companion JSON preserves
native results, source identities and npm metadata.

## Remaining boundaries

The [MFA replay follow-up](2026-09-20-mfa-replay-and-attempts.md) covers counter reuse
across challenges/step-up and challenge/account attempt limits. Enrollment fresh-auth
policy and OIDC/browser binding remain audit items. A local version cannot detect
directory-side credential changes after a
successful directory response without an additional provider contract. Existing
sessions are not globally reauthenticated merely when MFA is enabled; this change
revokes pending password proofs and prevents stale login completion.

The credential version tracks the listed credential fields, not all possible
authorization changes. Initial unknown-user LDAP provisioning, external SSO paths,
distributed database consistency, password-age timestamp parsing and audit-failure
semantics across every auth route still require separate review. Native tests use
local SQLite processes, not a real LDAP server or a distributed HA database.

Production deploy, reachable HTTPS/email destinations, known image CVEs and LAN
Docker API exposure remain unresolved independently of this source checkpoint.
