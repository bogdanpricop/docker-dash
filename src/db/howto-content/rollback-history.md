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

The displayed history is limited to ten entries; this is not deletion of older
records. Encryption does not make container replacement transactional. Failure
after Docker has removed the current container can still require manual recovery.
Keep deployment configuration and independent backups available.
