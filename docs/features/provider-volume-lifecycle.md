# Provider VM disk lifecycle

Docker Dash provides a provider-neutral workflow for virtual-disk create, grow, detach and storage move. Enable it explicitly:

```env
DD_PROVIDER_SDK_V2=true
DD_PROVIDER_VM_DISK_LIFECYCLE=true
```

Permanent deletion of a Docker Dash-owned detached backing is a second release decision:

```env
DD_PROVIDER_VM_DISK_DELETE=true
```

The lifecycle flag does not enable deletion by itself. Both flags are disabled by default.

## Safety model

Every mutation has a fresh preflight, a semantic SHA-256 plan hash, exact VM-name confirmation, operation-policy evaluation, one VM lock, native-task reconciliation where available and a positive hardware post-read. Disk shrink is rejected. A grow operation changes virtual capacity only; the guest partition and filesystem remain the operator's responsibility.

Detach always retains data. It is blocked for optical, read-only, shared, boot-ambiguous foreign and snapshot-dependent disks. Docker Dash records ownership only after it creates and positively verifies a backing. Provider-existing disks cannot be adopted implicitly or permanently deleted.

Permanent deletion additionally requires:

- a `detached` Docker Dash ownership record;
- `DD_PROVIDER_VM_DISK_DELETE=true`;
- no current VM snapshots;
- a verified VM recovery point within `DD_PROVIDER_VM_DISK_DELETE_RECOVERY_MAX_AGE_HOURS` (24 by default);
- the exact phrase `DELETE VOLUME <label>`;
- execution-time revalidation and positive provider absence verification.

## Provider behavior

- Proxmox VE QEMU uses bounded configuration/resize calls and native UPIDs for disk movement. Detach produces an unused volume. LXC mutation is not released.
- vSphere uses incremental `ReconfigVM_Task` requests and per-disk `RelocateVM_Task`. Detach omits `fileOperation`, so the VMDK is retained. Detached VMDK deletion is not released.
- managed XenAPI uses VDI/VBD records and `Async.*` tasks. Xen Orchestra REST and raw Xen remain explicitly unsupported because no conformance-tested common disk-mutation transport is available.

## API

```text
GET    /api/providers/:hostId/virtual-machines/:vmId/disks
POST   /api/providers/:hostId/virtual-machines/:vmId/disks/preflight
POST   /api/providers/:hostId/virtual-machines/:vmId/disks
POST   /api/providers/:hostId/virtual-machines/:vmId/disks/:diskId/preflight
POST   /api/providers/:hostId/virtual-machines/:vmId/disks/:diskId/actions
GET    /api/providers/:hostId/managed-volumes
POST   /api/providers/:hostId/managed-volumes/:volumeId/delete/preflight
DELETE /api/providers/:hostId/managed-volumes/:volumeId
```

Read routes require host-view access. Preflight and submission require administrator plus host-operate access. Responses and audit events contain only canonical IDs; provider VM, device, datastore, VDI/VBD and task references stay inside encrypted server-side stores.
