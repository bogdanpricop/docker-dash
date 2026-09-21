# Desktop Streamer Prune Coordination

## Non-Disruptive Refusal Follow-Up

At 19:56:39 and 19:57:00 UTC on 2026-09-21, two more `Prune all` requests
(audit 127/128) were rejected before dispatching cleanup. The first transient
barrier nevertheless fenced a new Desktop Streamer qualification operator:
its journal stopped at `created`, before any start intent. No cleanup action
was accepted. The temporary barrier was released by its original owner.

Version `8.96.8+monitoring.1.prune.2` first inventories retained recovery work
and refuses without creating a barrier when the exclusion is already known.
This early read is only a non-disruptive rejection path, not authorization:
prune still creates its barrier and repeats the full inventory before dispatch.
An uncertain read fails closed. The native canary checks both no-barrier refusal
and a reservation appearing between the two reads; no global prune is used.
Runtime deployment evidence for this follow-up must be recorded separately.

Status: deployed and verified on the VPS; LAN deployment is not claimed.

The user approved this cross-project correction after the VPS audit showed two
`system_prune` operations of type `all` on 2026-09-21. The request at 17:50:26 UTC
interrupted Desktop Streamer successor qualification by removing stopped
operators. It also removed earlier production observation containers and the
unused qualification image. Running Desktop Streamer production containers and
ownership files were verified unchanged; missing historical operators are not
recreated by this patch.

This private backport starts at deployed revision `caf8b195` and retains its
monitoring-access correction. It does not ship the newer authentication audit
branch, change dependencies or add database migrations.

## Contract

- `com.desktop-streamer.release-operation` and
  `com.desktop-streamer.release-reservation` block coordinated prune in every
  container state, including terminal and never-started evidence.
- A non-running container with `com.desktop-streamer.cutover-owner` also blocks
  prune. Legacy `ds-cutover-host-*` operators block in every state.
- A running application alone, including a published successor candidate, does
  not reserve cleanup. Unrelated containers are not treated as release owners.
- New publishers create their container with
  `com.docker-dash.prune-protect=true` before checking that the daemon-wide
  `dd-maintenance-prune-lock` is absent. Only then may they start the effect.
  This closes both orderings of concurrent create/prune with the existing
  one-label Docker exclusion. Missing/error observations never permit start.
- Retained release evidence deliberately keeps cleanup blocked after a failed
  or completed invocation until explicitly reconciled. No TTL, automatic
  deletion or journal rewrite is introduced.

The correction applies to manual, fleet and disk-pressure operations already
using `withPrune`. External CLI commands, direct container deletion and old
publishers that do not implement the handshake remain outside this guarantee.
The patch does not pretend that labels can be changed on already-created Docker
containers. Historical unprotected, unstarted operators must not be silently
started by the updated publisher.

## Verification

Local verification passed: 363 suites, 4,813 tests and one existing skip; ESLint
and 60/60 page-help coverage passed. The first run exposed the isolated worktree's
missing synthetic encryption key and a CRLF CA fixture. Rerunning with an explicit
test-only key and LF fixture bytes passed; no production credentials or unrelated
application behavior were changed. The focused prune suite contains 31 cases.

Unit cases include all operation/reservation states, missing lifecycle metadata,
legacy evidence, the running-application exception and the existing prune failure
and concurrency paths. The real canary extends the existing namespaced adapter
with Desktop Streamer evidence refusal and late protected-container survival.
Every destructive canary call retains a positive invocation label; no
production-wide prune is used to prove this change.

The Dockerfile layers only the guard, release metadata and EN/RO change/help text
on the exact deployed image
`sha256:d525e7e556aab759c6315894306f13a7e7fb6591d0ea70c5f821a2f367672753`.
Production backup, bundled-source identity, native canary and health checks are
required before claiming this patch installed. Existing image vulnerability
findings and unrelated audit work remain open.

## VPS Deployment

Source `05f6cf2bd2059f03a887bb506e59a6896f650f90` is deployed as
`8.96.8+monitoring.1.prune.1`, image
`sha256:ac2f9a054418b5cf1fc1a61143a22e8515806372cd872c60bc20a426279ac226`.
All eight native Docker canary checks passed with the complete base layer prefix
and dependency lock preserved. Exact hashes of all seven copied runtime files
match the immutable source archive. A second check against the module bundled
in the running application returned 409 for a real Desktop Streamer reservation
without invoking the supplied action. No global prune was executed.

The private SQLite backup is 651,038,720 bytes, integrity OK, SHA-256
`fcad64d21427a42aceffa3bf871f9ab22f5bec03ca796bfaae61215f48e0ba6b`.
User/host counts remain 2/1 and the migration count remains 177. Environment,
keys, mounts, network aliases and runtime configuration are preserved. Anonymous
metrics and cluster status still return 401; Prometheus completed a fresh
authenticated scrape after restart. Desktop Streamer application/database/proxy
and Docker Dash monitoring containers retained their exact runtime fingerprints.

Two verification interruptions were reconciled without weakening the contract:
BuildKit required the existing local image tag instead of a bare image ID in
FROM, so the qualifier verifies that tag against the expected immutable ID;
Compose reordered environment and bind arrays, whose contents were verified
identical after sorting. The latter verification resumed against the same new
container without restarting it. Owned temporary reservations were removed only
after inspection, while old/new image pins remain for explicit recovery.

Private qualification, backup and deployment receipts are under
`/opt/docker-dash/checkpoints/8.96.8+monitoring.1.prune.1-05f6cf2b/`.
The paired Desktop Streamer start handshake still needs its own integrated
qualification and tooling publication; this deployment does not qualify it.
