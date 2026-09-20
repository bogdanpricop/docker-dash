# Recoverable container replacement — 8.96.3

Update, safe update, pipeline and historical rollback previously removed the
original before validating a replacement. The shared replacement service now
retains it through verification and a SQLite transaction covering required audit
writes and the operation commit. Failures before commit restore the original ID
where Docker remains available; ambiguous/failed recovery keeps the daemon lock.

Migration 177 stores metadata-only recovery records. The existing encrypted
history now also includes complete process configuration, volume identities and
configured network endpoints. Daemon name reservations serialize dashboard
replacements, including duplicate host entries; reserved recovery names cannot
start another replacement. Mutable image pull references are retained separately
from the exact immutable ID used for creation.

## Verification

- Full Jest suite: 353 suites, 4,580 passed, one existing live test skipped.
- 30 focused lifecycle tests cover create/start/health/audit/journal faults,
  competing writers, stale inspection, lost create responses, cleanup failures,
  missing volumes, unsupported states, ownership and transaction rollback.
- 65 admission/route tests continue to cover permissions, scanner denial,
  immutable-image use and encrypted history, now through the shared service.
- Real Docker canaries on LAN and VPS: successful replacement, injected create
  failure and failed healthcheck. Verified anonymous-volume identity and contents,
  original-ID restoration on failure, static IP, network alias and restart policy.
  VPS Docker was accessed over a host-verified SSH tunnel to its Unix socket.
- Final focused rerun: 95 tests passed. ESLint passed with zero warnings; browser
  library/YAML editor smoke passed under CSP.
- Only test-owned resources were created/removed; canary networks were internal,
  unpublished and checked against existing Docker networks and host routes. LAN
  default address pools were exhausted, so a verified unused explicit subnet was
  used. No existing network or daemon configuration was changed.

Raw sanitized evidence is in the adjacent JSON file. Deployment evidence is
recorded separately after rollout; these canaries are not an application deploy.

## Boundaries

No automatic stale-lock takeover or crash reconciler is provided. Administrators
must stop the previous writer, inspect the operation IDs and actual Docker state,
then follow the EN/RO rollback recovery guide. Other Docker clients/prune commands
do not obey this reservation. Shared-volume writes by a candidate are not reversed.
Older snapshots cannot reconstruct fields they never recorded. Running processes
without healthchecks are observed for five seconds; healthchecks have 30 seconds.
An interruption after commit may leave cleanup work with the candidate active.

Known image vulnerabilities, LAN Docker TCP exposure and remaining project-audit
work are unchanged. Public image admission/publication gates remain enabled.
