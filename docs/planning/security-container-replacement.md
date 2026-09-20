# Recoverable container replacement

Update, safe update, pipeline and historical rollback currently remove the only
usable container before create/start/health validation. Replace this with a shared
state machine on the selected Docker daemon. A stopped, renamed original remains
available until the candidate passes verification and required audit/state writes.
On failure remove only the identified candidate, restore original networking/name/
restart policy and its prior running state. Never delete shared volumes.

Use an atomic, deterministic Docker container-name reservation as the daemon-wide
lock, including across separate dashboard instances and duplicate host records.
The reservation never runs and has no host mounts/network. Persist operation IDs,
container IDs, recovery name and phases in SQLite before changes; never put secrets
in the journal or lock labels. Revalidate the original identity/configuration after
acquiring the lock, so queued requests cannot apply stale inspection data.

Preserve healthcheck, stop signal, process settings, named/anonymous volumes and
configured endpoint settings. Dynamic endpoint IDs must not be copied. Single
container update must use the selected daemon, not run local Compose based on a
remote container label. Whole-stack Compose changes remain a separate workflow.

Refuse auto-remove, paused/restarting/dead containers and unsupported recovery
conditions before changing them. Do not claim application-data rollback: candidate
processes can write shared volumes. No expiring lock that could authorize two
writers. A process/daemon interruption leaves a durable lock and retained original;
manual recovery must first ensure the previous writer is stopped. Do not silently
steal a lock or remove an unknown container during recovery.

Verify create/start/health/audit failures, uncertain Docker responses, cleanup
failure, stopped containers, competing writers and stale requests. Exercise real
Docker on isolated named resources, including anonymous data volumes and network
aliases/static IPs. Keep journal/cleanup limitations explicit until independently
verified; a green mocked test alone does not prove lifecycle correctness.
