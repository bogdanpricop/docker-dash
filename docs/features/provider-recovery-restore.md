# Provider recovery restore

Docker Dash can create a new, powered-off Proxmox VE QEMU VM or LXC container from a canonical recovery point. The workflow is disabled by default:

```env
DD_PROVIDER_RECOVERY_POINT_INVENTORY=true
DD_PROVIDER_RECOVERY_RESTORE=true
```

The backup source must already be visible on the Recovery Points page. Restore does not reuse snapshot-revert semantics and does not depend on a backup policy or execution remaining present.

## Safe workflow

1. Open **Recovery Points** and refresh live evidence.
2. Select **Restore plan** for a point.
3. Choose a canonical target node and storage, then enter a new VMID.
4. Review capability, repository, verification, storage content/capacity, conflict, release, and operation-policy findings.
5. Type `RESTORE <vmid>`. For stale/unverified/unknown evidence, first supply a reason and type `RESTORE UNVERIFIED <vmid>`.
6. Follow the durable `vm.restore` operation in Activity Center.

A recovery point with failed verification cannot be overridden. Repeating the same request with the same `Idempotency-Key` reuses the operation; reusing the key with different intent is rejected.

## Provider behavior

Proxmox VE receives a node-scoped create/restore request with:

- a new VMID;
- the archive and storage resolved server-side from encrypted native identities;
- `force=false` so existing guests cannot be overwritten;
- unique network identity generation;
- `start=false` and no live restore;
- optional explicit bandwidth translation from Mbps to KiB/s.

The returned UPID is encrypted and reconciled by the common operation engine. Success requires live canonical inventory to prove the expected QEMU/LXC target on the selected node in a non-running state.

## Failure, cancellation, and ambiguity

Restore is non-idempotent. Docker Dash writes a durable pre-submit checkpoint and never submits again after an ambiguous response. If no target/task result can be proven, the operation becomes `unknown` and keeps its target locks until an administrator records evidence.

Stopping a task does not prove that partial VM config or disks were removed. Failed, cancelled, and ambiguous operations therefore report:

```text
partialTargetMayExist=true
automaticCleanupAuthorized=false
startAfterRestore=false
overwrite=false
```

Inspect Proxmox VE before deleting anything or retrying with another VMID. Docker Dash never performs automatic restore cleanup.

## Current boundaries

- executable: full create-only QEMU/LXC restore through Proxmox VE;
- not executable: overwrite, power-on, instant/live restore, file restore, disk restore, or differential restore;
- Xen Orchestra product restore features remain visible in research evidence, but Docker Dash does not use its undiscovered JSON-RPC mutation transport yet;
- XAPI, raw Xen, vSphere, and ESXi remain fail-closed;
- boot, guest-agent, and application assertions belong to the automated restore-drill batch.

## API

```text
POST /api/providers/:hostId/recovery-points/:pointId/restore/preflight
POST /api/providers/:hostId/recovery-points/:pointId/restore
```

Both routes require an administrator with host `operate` access. Submit additionally passes the global write gate and requires an `Idempotency-Key`. Progress, events, cancellation, and manual resolution use `/api/operations`.
