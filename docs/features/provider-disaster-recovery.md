# Provider disaster recovery

Docker Dash can combine verified recovery points, measured restore drills and provider replication evidence into application-level protection groups. Enable the feature explicitly:

```env
DD_PROVIDER_SDK_V2=true
DD_PROVIDER_RECOVERY_POINT_INVENTORY=true
DD_PROVIDER_DR_RUNBOOKS=true
```

The release flag exposes definitions, posture, previews and non-mutating rehearsals. It does not authorize automatic failover, failback, network cutover, provider cleanup or any other provider mutation.

## Protection groups

Each group contains 1–64 canonical VMs, an RPO/RTO objective, one primary and recovery endpoint, an optional canonical node/storage target, bounded network mappings and a dependency DAG. Members have boot stages and explicit dependencies. The service rejects duplicates, cycles, missing dependencies, later-stage dependencies, stale identities and identities owned by the wrong endpoint.

Strategies remain explicit:

- `backup_restore` uses the newest verified recovery point and the latest measured successful restore drill;
- `provider_replication` requires a healthy matching replication record;
- `hybrid` requires every member to select its recovery source.

Enabling or re-enabling a group requires the exact text `AUTHORIZE DR <group name>`. Deleting a group soft-deletes its definition and retains rehearsal evidence.

## Plans and rehearsals

The deterministic compiler supports `planned_failover`, `unplanned_failover`, `failback` and `test`. Plans include dependency-ordered steps, providers/endpoint IDs, mappings, capability evidence, blockers, warnings and a semantic SHA-256 hash. Unplanned plans also bind the bounded incident declaration into the hash and evidence.

Real plans are permanently blocked in this execution slice with `DR_AUTOMATIC_EXECUTION_NOT_RELEASED`, plus the provider capability blocker where applicable. They describe the required fencing, synchronization, promotion, validation and reprotection sequence but cannot submit it.

A rehearsal is a separate, non-mutating evidence operation. The administrator first requests a rehearsal preflight, reviews the exact hash, then types `REHEARSE <group name>`. Docker Dash evaluates every step; provider-mutation steps are recorded as `not_executed`. The durable run binds the plan, stable recovery evidence, compliance and completion timestamp under an evidence SHA-256 hash. If decision evidence changes between preview and confirmation, the request fails as stale.

## RPO/RTO compliance

Group posture uses the worst member result:

- `met`: every selected recovery source is within RPO and has a successful measured restore drill within RTO;
- `breached`: the required measurements exist but at least one objective is exceeded;
- `failed`: the latest relevant automated drill failed or was cancelled;
- `unknown`: required provider or measurement evidence is incomplete;
- `never_tested`: no successful automated restore drill exists.

A runbook rehearsal does not turn an untested workload into a tested workload. Manual acknowledgements and backup timestamps alone are not accepted as recovery proof.

## Provider boundary

Proxmox VE exposes read-only storage-replication jobs as asynchronous, crash-consistent, intra-cluster evidence. Native VMIDs, job IDs and node names are mapped to opaque canonical IDs and are not returned. Storage replication is not advertised as cross-site DR.

vSphere requires a separately integrated VMware Live Recovery/SRM recovery-plan boundary. Xen requires a discovered, task-backed Xen Orchestra or XAPI recovery workflow. Those provider mutations, as well as Proxmox recovery-plan mutation, remain explicitly unsupported.

## API

```text
GET    /api/providers/:hostId/dr/overview
GET    /api/providers/:hostId/dr/replications
GET    /api/providers/:hostId/dr/protection-groups
POST   /api/providers/:hostId/dr/protection-groups
PUT    /api/providers/:hostId/dr/protection-groups/:groupId
DELETE /api/providers/:hostId/dr/protection-groups/:groupId
POST   /api/providers/:hostId/dr/protection-groups/:groupId/preflight
POST   /api/providers/:hostId/dr/protection-groups/:groupId/rehearse
GET    /api/providers/:hostId/dr/runs
```

Read routes require host-view access. Authoring, preview and rehearsal routes require administrator plus host-operate access. All errors are typed and sanitized; write and preview actions are audited without credentials or native provider references.
