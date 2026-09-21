# Desktop Streamer Prune Coordination

Status: implementation checkpoint; deployment evidence must be recorded separately.

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
