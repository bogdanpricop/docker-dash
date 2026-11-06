---
slug: rollback-history
title: Container rollback history and recovery
title_ro: Istoricul de rollback si recuperarea containerelor
category: docker-dash
difficulty: intermediate
icon: fas fa-history
summary: Understand encrypted rollback configuration, key recovery and backup limits.
summary_ro: Intelege configuratia criptata de rollback, recuperarea cheii si limitele backup-urilor.
---

## What version history retains

Container update, safe update, deployment pipeline and rollback retain a copy of
the current configuration before replacing it. Environment variables, commands,
labels and mount configuration may contain secrets, so the complete snapshot is
encrypted with the installation's `ENCRYPTION_KEY`. The history dialog shows
image and deployment metadata; it does not return this private configuration.

Existing snapshots are encrypted during migration 176 at startup. A failed
migration aborts without partially replacing earlier rows. Invalid historical
configuration remains encrypted but cannot be restored. Subsequent operations
stop before modifying the current container if saving its snapshot fails.

## Recover a previous version

Open a container's **Rollback** dialog and select an available previous image.
The image must still exist on the selected Docker host. Rollback recreates the
container and can interrupt service. Operators need permission for both the
current stack and the saved configuration's stack. History from another host or
container name cannot be used. The authenticated snapshot also binds the saved
host, original container identity, name and image identity.

Keep `ENCRYPTION_KEY` stable, backed up separately and accessible only to trusted
administrators. A changed/lost key or damaged snapshot causes rollback to refuse
the operation before stopping the container. Restore the correct key from your
protected backup; do not disable validation or replace the ciphertext with JSON.
Legacy entries with no saved configuration retain the administrator-only fallback
using the current configuration with the previous image.

## Backup and failure boundaries

Encryption of live rows does not erase earlier plaintext from backups, SQLite
WAL copies, free pages or storage snapshots. Restrict access to these copies and
handle them under your retention policy. Rotate secrets that may have been exposed.
The key and database together can decrypt the stored configuration, so protect
both. No new automatic expiry policy is imposed on existing history.

The displayed history is limited to ten entries; older records are not deleted.
Container recovery does not undo writes to shared volumes. An incompatible database
migration by the candidate may require an independent application-data restore.

## Automatic recovery during replacement

Update, safe update, pipeline and rollback retain the stopped original until the
candidate passes verification and the required audit/state writes are committed.
Create, start, health or audit failures attempt to restore that same original ID,
name, restart policy and networks. Anonymous volumes retain their actual Docker
volume names. New snapshots also preserve healthchecks, stop signals and configured
network endpoints. Older snapshots cannot recover fields that were never saved.
A running container without a healthcheck must stay running for five seconds;
healthchecks have a 30-second verification limit. Pipeline Skip Verify skips the
healthcheck, but still requires the process to stay running. Originally stopped
containers stay stopped. This is a startup check, not a continuous health guarantee.

Single-container update uses the selected Docker host even for Compose-labelled
containers; use the stack workflow to apply Compose file changes or dependencies.
Auto-remove, paused, restarting, dead and Swarm-managed containers are refused.
A daemon-level name reservation rejects competing dashboard replacements. It has
no expiry: an interrupted operation must be reconciled before another replacement.
Other Docker tools and prune commands do not participate in this coordination.

## Interrupted operation or cleanup required

The error/warning includes an operation ID. A successfully verified replacement can
remain active even if removing the retained original or reservation fails. Do not
repeat the update or prune stopped containers to clear this warning.

1. Stop the dashboard instance(s) running the old operation and ensure no writer
   can resume. Inspect the selected Docker daemon, not another host with the same
   container name. Take a protected application-data backup before intervention.
2. Read its row in `container_replacements`: `daemon_id`, `original_id`,
   `candidate_id`, `lock_id`, `recovery_name`, `history_id`, `phase`,
   `was_running` and `restart_policy`. The related encrypted history provides
   the original network intent. The journal itself contains no environment secrets.
3. Match every immutable ID and the `com.docker-dash.replacement` operation label
   on the candidate/reservation. Never delete a resource just because its name
   starts with `dd-`. An original may be named `dd-recovery-<operation ID>`.
4. For `committed`, `complete` or `cleanup_required`, verify the candidate is the
   intended active service. Remove only confirmed retained resources, preserving
   volumes. If the original is already gone, only the reservation may need cleanup.
5. For interrupted pre-commit phases or `recovery_required`, preserve the original.
   An administrator can stop/remove the identified candidate without deleting
   volumes, restore the original name and disconnected networks from its encrypted
   snapshot, restore its recorded restart policy and prior running/stopped state.
   Confirm port bindings, network aliases/static addresses and application data.
6. Remove the identified reservation last, only after the intended service and
   ownership have been verified. Keep the journal/history as recovery evidence.

A crash after a Docker request can leave the journal one step behind. Inspect actual
state before deciding which path applies. Never steal a lock based on its age.
