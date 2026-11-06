# Safe common VM power operations

Docker Dash exposes one guarded power workflow for Proxmox VE, VMware vSphere/ESXi, Xen Orchestra and XenAPI endpoints. Supported actions are start, graceful shutdown, graceful reboot, force off and force reboot. Availability is computed for each VM from provider capabilities, current state, native allowed operations, guest tools, operation policy and effective host permission.

The feature is off by default. Enable it only after inventory and capability conformance have been verified:

```dotenv
DD_PROVIDER_VM_POWER=true
```

Restart the application after changing the flag. Raw Xen/libxl resources remain visible, but common durable power actions stay blocked because a domid is transient and cannot be reconciled safely after a worker or dom0 restart.

## Operator flow

1. Open **Virtual Machines** and select one endpoint.
2. Open one VM, or select up to 20 VMs for a bulk operation.
3. Review the live preflight plan, current and expected states, warnings and blockers.
4. Confirm the operation. Forced actions require the exact VM name; bulk force requires every exact name.
5. Follow the operation in **Activity**. Submission returns immediately while native task polling and post-state verification continue durably.

Bulk creation is all-or-none. If one VM is missing, blocked, conflicting or no longer in the planned state, no operation in that request is created.

## API

```http
POST /api/providers/:hostId/virtual-machines/:resourceId/power/preflight
POST /api/providers/:hostId/virtual-machines/:resourceId/power
POST /api/providers/:hostId/virtual-machines/power/preflight
POST /api/providers/:hostId/virtual-machines/power
```

Mutation calls require an `Idempotency-Key`, `confirm: true`, and the exact `planHash` returned by the immediately preceding preflight. A changed or expired plan is rejected with `409`. Forced single operations also require `confirmName`; bulk operations use a `confirmNames` map.

Only admins and operators with effective `operate` access to the endpoint can use these routes. Global read-only mode and provider-operation policies are enforced again at submit time. Every accepted submission writes a bounded audit record without native references or credentials.

## Failure and reconciliation behavior

- Provider mutations are never automatically retried.
- A dropped response or timeout after a possible submit enters reconciliation.
- Proxmox UPIDs, vSphere Task MoRefs and Xen task references are encrypted at rest.
- Success requires the expected VM power state after native task completion.
- An unverified outcome becomes `unknown` and retains the resource lock for manual investigation.
- Provider-confirmed Proxmox task cancellation can finish as cancelled; an unconfirmed cancellation becomes `unknown`.

Do not use a production VM as a mutation smoke target. Designate a disposable VM, record its initial state and verify its final state and audit trail.
