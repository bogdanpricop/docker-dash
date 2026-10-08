# VM snapshot policies and managed retention

Docker Dash can schedule portable snapshot creation and bounded retention for a single VM across Proxmox VE, vSphere/ESXi, XenAPI/XCP-ng and Xen Orchestra. The scheduler persists policy runs in SQLite and submits every provider mutation through the durable `vm.snapshot` operation engine.

Snapshot retention is not backup retention. Snapshots stay in the VM/provider storage failure domain and provide no independent recovery, immutability or restore-verification guarantee.

Both mutation gates must be explicitly enabled:

```dotenv
DD_PROVIDER_VM_SNAPSHOTS=true
DD_PROVIDER_VM_SNAPSHOT_AUTOMATION=true
```

The automation flag is off by default. A new policy is disabled and in `dry_run` mode by default, even when both environment flags are enabled.

## Policy model

- one policy per endpoint and stable VM identity;
- hourly, daily or weekly UTC schedule at minute `0`, `15`, `30` or `45`;
- crash-consistent or evidence-gated quiesced create;
- exact managed prefix, default `dd-auto`;
- keep-newest count, optional maximum age and per-run deletion cap;
- typed VM-name confirmation when execute mode is enabled or run manually;
- soft deletion preserves policy-run evidence and Activity operations.

The leader-only minute job is only a wake-up. Slot deduplication, active-run exclusion and orchestration state are persisted, so a restart does not replay an ambiguous create or delete.

## Retention safeguards

Only snapshots whose names begin with the configured `<prefix>-` can become candidates. The evaluator protects manual/unowned snapshots, the newest retained set, current snapshots, snapshots with children, invalid graphs and snapshots without a trustworthy creation timestamp. It refreshes inventory and submits at most one leaf deletion after the create child operation succeeds.

If a child provider operation becomes `unknown`, the policy run also becomes `unknown`; operators must reconcile it in Activity Center before further mutation.

## API

```http
GET    /api/providers/:hostId/virtual-machines/:vmId/snapshot-policy
PUT    /api/providers/:hostId/virtual-machines/:vmId/snapshot-policy
DELETE /api/providers/:hostId/virtual-machines/:vmId/snapshot-policy
POST   /api/providers/:hostId/virtual-machines/:vmId/snapshot-policy/preview
POST   /api/providers/:hostId/virtual-machines/:vmId/snapshot-policy/run
GET    /api/providers/:hostId/virtual-machines/:vmId/snapshot-policy/runs
```

Read/history require endpoint `view` access. Policy changes and runs require an administrator, endpoint `operate` access and writeable mode. Preview is read-only at the provider but restricted to administrators because it evaluates an operational draft against live inventory.

## Canary rollout

1. Keep execute automation off and validate live inventory plus a draft preview.
2. Save an enabled `dry_run` policy and observe at least one scheduled run.
3. Back up the Docker Dash database and preserve the current environment file.
4. Designate a disposable VM, enable the automation flag and type the exact VM name to change the policy to `execute`.
5. Verify the create operation, refreshed inventory, any leaf deletion and the terminal policy-run evidence.
6. Disable the policy or automation flag immediately if any result is `unknown`.

The conservative defaults follow [Broadcom snapshot guidance](https://knowledge.broadcom.com/external/article?legacyId=1025279), while the portable schedule aligns with the concepts in [XAPI VMSS](https://xapi-project.github.io/xen-api/classes/vmss.html) and its [scheduled snapshot design](https://xapi-project.github.io/xapi/design/schedule-snapshot.html).
