# Provider-console lifecycle audit — 2026-09-20

Status: source checkpoint, not deployed. LAN and VPS still serve 8.96.8 and both
returned healthy HTTP 200 at 2026-09-20T07:57:17Z. The combined authentication
rollout awaits the correct account-email URLs; current PUBLIC_URL is localhost.

## Findings and changes

The dedicated `/ws/provider-console` gateway validated the login session only
during upgrade. An authenticated serial relay continued forwarding provider data
after logout. Cleanup during a pending provider connection marked the session
finalized without closing the upstream when it later arrived.

The gateway now keeps a session digest and rechecks the authoritative login
session, original user ID/global role, host operate permission and effective
console lock. Required password changes and storage failures deny access. Checks
run before provider opening, after it resolves, during client attach, before
channel input/output or buffered reads, and every five seconds while idle.
Initial forced-password accounts are denied before consuming a console token;
initial authentication storage failures return 503 instead of escaping the upgrade
handler. Existing connections close with 4003 when access is lost.

Channels are registered before RFB handshake awaits so cleanup can immediately
close pending readers. Late upstream connections are closed even if finalization
already occurred. Cleanup removes the active entry and timers before destroying
channels; close-state/audit persistence failures cannot prevent transport cleanup.
Those persistence failures produce bounded warnings and are not silently treated
as successful audit writes.

ByteChannel previously returned immediately from its wait whenever any bytes were
buffered, even when readExact needed more. With a partial frame this spun promise
microtasks until the read deadline (normally 15 seconds), preventing the next
transport chunk or timer callback from running. Reads now wait for new data,
closure or timeout. Authorization also guards buffered reads and pending relay
chunks; closed channels discard buffered data.

## Verification

- Regression against the preceding source: the real provider-console logout test
  fails because the socket stays open; a fragmented-read test fails because the
  scheduled second chunk cannot run before the read times out. These both pass
  with this checkpoint. Two other deadline/close cases already passed the old code
  and are not claimed as reproduced failures.
- Twenty-two new tests cover session expiry/logout, disabled accounts, role and
  password state, host permission, console lock, storage failure, input/output,
  idle cleanup, late provider resolution, pending attach/RFB handshakes, buffered
  bytes, real WebSocket exchange and initial handshake rejection. Partial-frame
  tests use child processes with parent-owned deadlines.
- Full suite: 370 suites and 4,862 tests passed, one skipped. Lint passes.
- Native canaries: LAN at 2026-09-20T07:56:33.429Z and VPS at
  2026-09-20T07:56:33.637Z. Fifteen checks pass per host: eleven previous account
  recovery/MFA/shared-WebSocket checks plus three real provider-console socket
  revocations (input, output, idle) and a delayed fragmented read.
- Native runtime: SQLite 3.53.4 in deployed image
  `sha256:1085b24aa2d0531faa15b62ae32b3ef93f92532a47d237ef978654464570741b`,
  with explicitly verified source overlays. Network disabled, no host data or
  Docker socket mounted, mocked SMTP/provider adapters/console broker/host ACLs
  and console locks. Login sessions and gateway transport are real. All owned test
  containers and their anonymous volumes were removed.

The companion JSON records exact source hashes and canary results. Local evidence:
`.git/provider-console-revalidation-{before,full-tests,lint,final}.log`,
`.git/provider-console-native-{lan,vps}.log`, `.git/external-health-8.96.8.json`.

## Remaining boundaries

The canaries do not certify any actual hypervisor/VM console, provider ticket
revocation, or HA database consistency. Five seconds is an event-loop-dependent
idle interval; I/O performs independent checks. Bytes already sent or buffered by
the underlying transport cannot be retracted. Closing the relay cannot undo input
already executed or cancel an external request already dispatched to a provider.

Every guarded channel operation performs database authorization work. Sustained
RFB throughput, aggregate buffer limits/backpressure, host lifecycle changes,
origin allowlist deployment and multi-replica behavior need further review. A
storage outage can prevent close metadata/audit persistence even though transport
access is denied. This checkpoint does not resolve known container image CVEs,
LAN Docker API exposure or the deployment URL clarification.
