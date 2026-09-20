# Established WebSocket session audit — 2026-09-20

Status: source checkpoint, not deployed. Both live instances remain on 8.96.8;
the account-email URL clarification is still pending for the combined rollout.

## Confirmed behavior and fix

The shared `/ws` endpoint validated a session only at connection time. After
logout it continued responding to client messages and forwarding broadcasts.
Exec, SSH and log startup also retained stale client objects across asynchronous
provider operations, allowing a stream to arrive after its client was cleaned up.

Connections now retain the SHA-256 session digest in their client record and use
the same database-backed session validation as HTTP. Before inbound commands and
outbound messages, the server checks expiry, validity, account activity, required
password change and the original global role/user ID. Changed roles require a new
connection rather than retaining old stream authorization. Database errors deny
access. A five-second sweep checks otherwise-idle clients.

All shared-endpoint outbound sends pass through the session guard, including local
and cross-replica broadcasts and stream callbacks. Invalid clients are detached
from the registry before stream destruction, preventing synchronous close/output
events from reentering cleanup or leaking a final payload. Tracked exec, log and
SSH streams/connections are closed. The session sweep stops when its WebSocket
server closes; the timer does not keep a stopped process alive.

Exec checks again after inspection, exec creation, start and resize. Only one
startup can be pending per client; a later start closes the previous stream.
Log startup checks after permission inspection and stream creation. SSH tracks
its connection before `ready` and rejects stale `ready`/shell callbacks. Late
resources are closed instead of attached to a discarded client. Output from
superseded exec/SSH streams is ignored.

Close code 4003 distinguishes revocation/changed account state from an initial
cookie-auth failure. The browser stops reconnecting and returns to login without
trying the existing token-in-query fallback. Required-password-change users are
also refused during the initial handshake with this code.

## Verification

- Two real WebSocket tests fail against the previous implementation: both client
  input and server broadcasts leave a logged-out socket open. They pass with the
  corrected implementation, which closes with 4003 before forwarding more data.
- Twenty new cases cover logout, real password reset, expiry, deactivation, role
  change, forced password change, storage failure, idle sweep, broadcasts, all four
  exec await boundaries, overlapping startup, late log/SSH resources, real socket
  exchange and frontend handling without a query token. Existing terminal, SSH
  verifier and stack-log tests were updated with explicit session fixtures.
- Full suite: 368 suites, 4,840 tests passed, one skipped; lint passes.
- Native canaries passed on LAN at 2026-09-20T07:44:11.877Z and VPS at
  2026-09-20T07:44:12.319Z. Each runs eleven checks: the eight earlier recovery/MFA
  checks plus real WebSocket input/broadcast revocation and expiry of an idle socket
  using the actual five-second timer. All owned test containers/volumes were removed.
- Canary runtime: image
  `sha256:1085b24aa2d0531faa15b62ae32b3ef93f92532a47d237ef978654464570741b`,
  SQLite 3.53.4, explicit SHA-256-verified source overlays, network disabled and no
  production data or Docker socket mounted. SMTP is mocked; Docker event collection
  is disabled in this fixture. Native tests do not invoke a production terminal.

Logs: `.git/ws-revalidation-before.log`, `ws-revalidation-full-tests.log`,
`ws-revalidation-lint.log`, `ws-revalidation-native-lan.log`,
`ws-revalidation-native-vps.log`. The companion JSON records source hashes/results.

## Boundaries and next work

The five-second sweep is subject to event-loop scheduling; messages perform their
own checks instead of waiting for it. Data already buffered before revocation
cannot be retracted. Closing a Docker/SSH stream does not guarantee termination of
a detached process or undo commands already issued. Native Docker/ESXi terminal
behavior was not exercised by this canary; asynchronous boundaries use mocked
providers in the regression tests.

This change covers `/ws`, not `/ws/provider-console`. Dedicated provider-console
revocation is the next work item. Fine-grained host/stack permission changes,
subscription/channel authorization, resource/backpressure limits and emergency-lock
changes during later provider awaits also need further review. Global-role changes
are covered here. HA depends on replicas reading the authoritative session state;
the native canaries run standalone and do not certify distributed DB consistency.
Large-client/high-output load testing remains open because each guarded send now
performs an indexed session lookup. Known image CVEs and LAN Docker API exposure
remain independent unresolved findings.

The revalidation and logout checks implement part of
[OWASP WebSocket security guidance](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html).
The outstanding items above prevent a claim of complete WebSocket hardening.
