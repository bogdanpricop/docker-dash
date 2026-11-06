# Common VM snapshot lifecycle

Docker Dash provides one guarded snapshot workflow for Proxmox VE, VMware vSphere/ESXi, Xen Orchestra and XenAPI. The common contract supports live inventory, crash-consistent create, evidence-gated quiesced create, revert and leaf-only delete. Raw Xen/libxl remains deliberately unsupported because it has no portable durable snapshot/task contract.

Snapshots remain in the VM/provider storage failure domain. They are not independent backups, disaster-recovery copies or proof of recoverability. This boundary is included in every inventory/preflight response and displayed in every confirmation dialog.

The mutation canary is off by default:

```dotenv
DD_PROVIDER_VM_SNAPSHOTS=true
DD_PROVIDER_VM_SNAPSHOT_MAX_COUNT=32
DD_PROVIDER_VM_SNAPSHOT_MAX_DEPTH=16
```

Restart the application after changing these settings. Inventory remains available for validation while the mutation flag is off.

## Safety model

- Snapshot IDs are opaque `dds_snap_*` identifiers scoped to one endpoint and VM.
- Provider-native task/snapshot references such as MoRefs and Xen refs are encrypted at rest and are never returned by the common API; the portable operator-assigned snapshot name remains public metadata.
- Every mutation requires a fresh live preflight, exact `planHash`, explicit confirmation and an `Idempotency-Key`.
- Revert requires the exact VM name. Delete requires the exact snapshot name and refuses snapshots with children.
- Create rejects duplicate names, invalid parent graphs, excessive count and excessive chain depth.
- Quiesced create is rejected unless the provider advertises it for that VM; there is no silent downgrade to crash consistency.
- The durable `vm.snapshot` handler revalidates inventory, ownership and limits immediately before dispatch.
- Provider mutations are non-idempotent and never automatically replayed after ambiguous transport failures.
- Native task completion is followed by inventory verification. An unverifiable result becomes `unknown` and retains the VM lock for investigation.

## API

```http
GET    /api/providers/:hostId/virtual-machines/:vmId/snapshots
POST   /api/providers/:hostId/virtual-machines/:vmId/snapshots/preflight
POST   /api/providers/:hostId/virtual-machines/:vmId/snapshots
POST   /api/providers/:hostId/virtual-machines/:vmId/snapshots/:snapshotId/revert/preflight
POST   /api/providers/:hostId/virtual-machines/:vmId/snapshots/:snapshotId/revert
POST   /api/providers/:hostId/virtual-machines/:vmId/snapshots/:snapshotId/delete/preflight
DELETE /api/providers/:hostId/virtual-machines/:vmId/snapshots/:snapshotId
```

Mutations require admin/operator role, effective endpoint `operate` access and writeable mode. Accepted submissions write bounded audits and return an Activity Center operation link.

## Provider behavior

| Provider | Crash create | Quiesced create | Durable completion |
|---|---:|---:|---|
| Proxmox VE | yes, storage-dependent | no | UPID polling and inventory verification |
| vSphere/ESXi | yes, capability-dependent | powered-on VM plus running guest tools | Task polling and inventory verification |
| XenAPI/XCP-ng | yes | only when `snapshot_with_quiesce` is advertised | XAPI task polling and inventory verification |
| Xen Orchestra | yes | no in the common adapter | task polling when returned, otherwise inventory verification |
| raw Xen/libxl/xm | no | no | unsupported |

The provider may still reject an operation because of storage, device, FT, guest-agent or concurrent provider state that changed after preflight. Such failures are surfaced as bounded provider errors; they do not trigger fallback semantics.

## Operator rollout

1. Verify provider capability discovery and live snapshot inventory with the flag off.
2. Take a consistent Docker Dash database backup and preserve the current environment file.
3. Enable the flag for a canary endpoint.
4. Use only a designated disposable VM for create/revert/delete smoke testing.
5. Confirm the Activity timeline, audit event, provider inventory and final VM state.
6. Treat any `unknown` operation as a manual reconciliation incident before another mutation on that VM.

The implementation follows the provider-native task and snapshot models documented by [VMware vSphere Web Services](https://developer.broadcom.com/xapis/vsphere-web-services-api/latest/vim.VirtualMachine.html), [VirtualMachineSnapshot](https://developer.broadcom.com/xapis/vsphere-web-services-api/latest/vim.vm.Snapshot.html), [XAPI snapshot guidance](https://xapi-project.github.io/xen-api/snapshots.html) and the [XAPI VM methods](https://xapi-project.github.io/xen-api/classes/vm.html).
