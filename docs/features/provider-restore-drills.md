# Provider restore drills

Docker Dash can prove that a Proxmox VE recovery point is bootable by restoring it to a new temporary QEMU/LXC target, disconnecting every NIC before boot, running bounded assertions, and recording RPO/RTO evidence. The workflow is disabled by default:

```env
DD_PROVIDER_RECOVERY_POINT_INVENTORY=true
DD_PROVIDER_RECOVERY_RESTORE=true
DD_PROVIDER_RESTORE_DRILLS=true
```

Enabling the release flags does not authorize a mutation. Manual runs still require administrator/host-operate permission, an `Idempotency-Key`, `DRILL <vmid>`, and—when success cleanup is selected—`DRILL DELETE <vmid>`. Each scheduled policy separately requires `AUTHORIZE DRILL <name>` and `ALLOW AUTOMATIC CLEANUP <name>`.

## Safety contract

1. Live restore preflight proves a verified/explicitly overridden canonical source, a new VMID, target node/storage compatibility, policy state, and provider capability.
2. Restore always uses create-only, unique-network, powered-off semantics (`force=0`, `unique=1`, `start=0`, no live restore).
3. Before the first boot, the target receives the exact `Docker Dash restore drill pdrr_<id>` marker and every `netN` is rewritten with `link_down=1`.
4. The handler re-reads the marker and every NIC. Any mismatch blocks start.
5. Boot is mandatory. QEMU can require or optionally observe guest-agent ping and bounded OS information. LXC is explicitly boot-only. Arbitrary scripts or guest commands are not accepted.
6. The target is shut down after assertions; bounded force-stop applies only to the marked target.
7. Automatic deletion is possible only after success, separate authorization, a fresh stopped-state/marker/isolation proof, and a task-backed destroy with `purge=0` and `destroy-unreferenced-disks=0`.
8. Failure, cancellation, ownership ambiguity, changed isolation, or an unexpected running target is retained for manual inspection.

Every non-idempotent boundary has a durable pre-submit checkpoint. A lost response is reconciled from provider task/state evidence and is never blindly replayed.

## Manual workflow

Open **Recovery Points**, choose **Drill**, select a canonical node/storage and unused VMID, review the live plan, and type both requested confirmations. The run appears on the same page with:

- source/target canonical IDs and operation link;
- state and fixed assertion evidence;
- recovery-point age (RPO evidence);
- restore-start to assertion-complete duration (RTO evidence);
- separately measured cleanup duration;
- `met`, `breached`, `failed`, `unknown`, or `never_tested` compliance;
- a SHA-256 evidence hash binding run ID, plan hash, state, measurements, and bounded evidence.

Follow the underlying `recovery.drill` operation in Activity Center. An `unknown` run retains operation locks until an administrator resolves the provider state with evidence.

## Scheduled policies

A restore-drill policy links one enabled backup policy whose `verification.restoreDrillRequired` option is true. It records:

- hourly/daily/weekly/monthly IANA-timezone schedule;
- canonical target node/storage;
- `auto`, required, optional, or disabled guest-agent policy;
- success-cleanup authorization;
- RPO/RTO objectives.

The leader-only minute wake-up deduplicates `(policy, due slot)`, refreshes backup scope and recovery inventory, prefers the least-recently tested workload, selects its newest verified point, allocates the current PVE next VMID, and reruns live preflight. A missing point, active/ambiguous prior run, unavailable endpoint, or failed preflight creates durable `blocked` evidence without provider mutation.

## API

```text
POST   /api/providers/:hostId/recovery-points/:pointId/drill/preflight
POST   /api/providers/:hostId/recovery-points/:pointId/drill
GET    /api/providers/:hostId/restore-drills
GET    /api/providers/:hostId/restore-drills/:runId
GET    /api/providers/:hostId/restore-drill-policies
POST   /api/providers/:hostId/restore-drill-policies
PUT    /api/providers/:hostId/restore-drill-policies/:policyId
DELETE /api/providers/:hostId/restore-drill-policies/:policyId
```

Proxmox VE QEMU/LXC is the only executable provider slice in this release. Xen Orchestra health checks informed the common behavior, but XO/XAPI/raw Xen and vSphere/ESXi remain capability-blocked until their restore mutation/task transports pass conformance testing.
