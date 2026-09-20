# Account recovery delivery — 2026-09-20

Status: source changes tested locally and in isolated LAN/VPS canaries; not
deployed. This extends the [token/link correction](2026-09-20-password-reset.md).
The requested externally reachable account-email URLs are still pending.

## Behavior

Previously, an existing account's public recovery request awaited SMTP while an
unknown address returned immediately. A generic JSON body did not hide this
observable difference. The response now finishes before account lookup, account
quota verification or mail transport. All outcomes use the same public body.

The per-process queue admits at most 32 active/pending jobs, with two workers.
Over-capacity, invalid-input and shutdown requests do not enqueue work. Jobs hold
only a bounded email, normalized language and the resolved client IP; the HTTP
request/response objects are not retained. There is no arbitrary-delay timer or
unbounded SMTP concurrency. A stalled SMTP operation retains its worker slot.

Existing IP limits remain. A second quota uses the database account ID, so email
case and source IP changes cannot reset it. The shared limiter allows three
deliveries per hour: sliding windows in standalone, Redis fixed windows in HA.
The Redis key contains no email address. Unknown accounts create no account quota
keys. Invalid quota decisions, errors and a three-second deadline stop issuance;
late successful decisions cannot revive abandoned work.

After asynchronous quota verification, issuance rechecks the account's current
email and active flag under the same SQLite write lock that creates the token.
Admin reset/invitation issuance uses the same recipient check, preventing another
process from changing the destination between validation and issuance. Token issuance and audit intent are committed together
before SMTP. Delivery completion is a separate `password_reset_delivery` audit
event; failures revoke the delivery's token. Shutdown refuses new jobs, discards
pending jobs and revokes in-flight links before closing SQLite. Late mail/quota
callbacks cannot issue links, audit or reopen the database after shutdown.

## Evidence

- The HTTP completion regression fails against the prior route: a held SMTP
  promise prevents the response until the client's one-second deadline. It passes
  with the queued handler while the same SMTP promise remains unresolved.
- Sixteen new tests cover response completion/order, queue capacity/concurrency,
  account identity/casing/IP, denied/invalid/error/late quotas, lifecycle changes,
  shutdown and audit rollback. Existing token tests wait for asynchronous effects.
- Full Jest suite: 365 suites, 4,803 passed, one skipped. Lint passes.
- `scripts/smoke-password-reset.js` ran on both Docker hosts using network-isolated
  disposable containers, no Docker socket/host data mounts/published ports and
  mocked SMTP. Each verified four behaviors: HTTP completion before SMTP,
  configured link origin, account quota across casing/IP, and exactly one native
  SQLite redemption/audit across two independent Node processes.
- LAN run: 2026-09-20T07:19:02.647Z; VPS: 2026-09-20T07:19:02.586Z. SQLite 3.53.4.
  Both used the deployed 8.96.8 runtime image
  `sha256:1085b24aa2d0531faa15b62ae32b3ef93f92532a47d237ef978654464570741b`
  with explicitly overlaid, SHA-256-verified application sources. These are source
  canaries, not evidence that the live app contains the fix. Both owned containers
  and their anonymous test volumes were removed after success. The smoke script
  defaults to checking bundled source hashes for future candidate-image validation.

Local logs: `.git/reset-delivery-before.log`, `reset-delivery-full-tests.log`,
`reset-delivery-lint.log`, `reset-delivery-native-lan.log`,
`reset-delivery-native-vps.log`. Committed JSON records retain the native outputs.

## Limits

The queue is intentionally volatile: a restart loses pending work. Full queues
still return the generic response, so HTTP 200 does not guarantee delivery. The
client may retry later; sustained distributed traffic can exhaust capacity. No
CAPTCHA or durable mail outbox is claimed. The response no longer awaits account
work, but this is not a formal constant-time guarantee for the whole server.

Redis fixed-window boundaries can allow two adjacent bursts, and restarting a
standalone process resets its in-memory quota. Admin reset/invite actions remain
synchronous behind authentication and are outside this public delivery quota.
Native canaries used standalone mode; Redis quota primitives were verified in
earlier HA canaries, but this test does not prove cross-replica mail delivery.
Real SMTP, production URL routing/TLS and the next built-image rollout remain
unverified. Known image CVEs and the exposed LAN Docker API remain open.

The asynchronous response and account-level controls follow
[OWASP Forgot Password guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html);
the limits above remain part of the audit rather than being hidden by green tests.
