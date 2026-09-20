# Prune coordination and recovery preservation

Status: corrected and tested in source; pending the next deployment checkpoint.
Live LAN/VPS application containers remain at 8.96.7.

## Findings and correction

Manual/fleet prune previously called Docker's unrestricted container/image prune.
Stopped replacement locks, retained originals and egress snapshot helpers were
eligible for removal. With no helper container active, the configured egress image
was also eligible for image prune. This is a confirmed code path, not proof of
which actor caused the helper's historical disappearance from the VPS.

The cleanup path now creates a never-started, named reservation on the selected
daemon before inspecting operation/recovery containers. Replacement and egress
operations create their existing reservations before checking for cleanup. This
ordering makes overlapping operations observe one another before destructive
work, across application replicas. Existing recovery names and legacy operation
labels also block cleanup. Recovery requires explicit reconciliation.

One common label excludes all newly created reservations from container prune.
Real tests rejected an initial multiple-negative-label implementation: those
filters did not preserve the union of reserved roles. The final implementation
uses exactly one exclusion label, verified against both Docker daemons.

The cleanup reservation references the configured egress image, keeping it in
use until image prune ends. If the helper is unavailable, a local image is used
for the reservation and the response reports that the helper is unavailable.
If no image is available, cleanup is refused. This is not automatic helper repair.

The disk-pressure policy uses the same reservation, skips a selected helper image,
and propagates uncertain deletion results instead of continuing to delete other
resources. Manual prune records an audit request before dispatch and a completed
record with protection details only after successful completion. Fleet cleanup
uses the protected service path. The UI help documents these safeguards in EN/RO.

Individual image deletion also sets `noprune=true`, so selecting one image does
not implicitly remove its untagged parents. During development, cleanup of a test
image exposed this default on the VPS and removed the untagged helper parent.
The exact previously verified helper was restored, the test cleanup was corrected,
and the final test verifies the base helper remains present.

## Verification

Full validation: 362 suites, 4762 tests passed, one skipped; lint passed and
all 60 routed pages retain help coverage.

Unit tests cover existing recovery objects, concurrent reservations, preflight
failure, uncertain responses, ownership changes, missing helpers, the actual
Docker service's exclusion filter, and nonrecursive image deletion. Integration
tests verify replacement/egress stop before target mutation, and disk-pressure
cleanup respects the barrier and preserves the helper.

Five real Docker scenarios passed per host: named reservation exclusion;
container prune retaining reservations created after preflight; image prune
retaining a helper referenced only by the reservation; retained originals
blocking cleanup; and uncertain outcomes retaining the barrier.

The native test uses a namespaced adapter and positive invocation-label filters
for every destructive prune API call. It builds a dedicated fixture image and
deletes only labeled test resources. It never invokes production-wide prune or
changes existing containers, volumes or networks. Uncertain-response testing is
fault injection before dispatch; it does not claim a lost real daemon response.
Results and source hash: [JSON evidence](2026-09-20-prune-recovery.json).

## Operational limits

An uncertain accepted prune can continue after the HTTP connection disappears.
The stopped `dd-maintenance-prune-lock` container is therefore retained without a
TTL. Do not delete it merely because it is old or stopped. Confirm daemon-side
completion, inspect affected resources and the audit trail, then remove only the
verified reservation as an explicit operator recovery action. Ownership mismatch
or failure to remove the reservation also blocks future cleanup.

All application replicas that share a daemon must run this protocol before
concurrent cleanup is supported. Old workers and external Docker/CLI administrators
do not honor it. Manual resource deletion outside these coordinated cleanup paths
can still destroy recovery state. This change does not certify those paths or
protect arbitrary unused rollback images after their retaining container is gone.
Prune remains an administrator-only destructive action; it does not restore deleted
data. No daemon, host firewall or live cleanup policy was reconfigured.

Docker behavior references: [image prune](https://docs.docker.com/reference/cli/docker/image/prune/),
[image removal](https://docs.docker.com/reference/cli/docker/image/rm/).

Rezumat: curatarea manuala, fleet si disk-pressure pastreaza rezervarile de
recuperare si imaginea helper egress. Operatiile concurente sunt refuzate inainte
de modificarea tintei. Un rezultat incert pastreaza rezervarea pentru verificare
manuala. Corectia este testata, dar nu este instalata inca in aplicatiile live.
