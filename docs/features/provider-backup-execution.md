# Provider backup execution

Provider backup execution is a separately gated extension of the backup-policy page. It currently supports durable Proxmox VE `vzdump` tasks and remains disabled by default.

Enable both prerequisite read/planning features and execution:

```env
DD_PROVIDER_RECOVERY_POINT_INVENTORY=true
DD_PROVIDER_BACKUP_POLICIES=true
DD_PROVIDER_BACKUP_EXECUTION=true
```

After deployment, an administrator must still authorize each policy as `manual` or `scheduled` by typing its exact name. Saving a policy or generating a plan never starts a backup.

Each VM backup is a durable provider operation with:

- policy-scoped request idempotency;
- VM and repository locks;
- current VM/repository revalidation;
- encrypted native UPID tracking;
- bounded cancellation;
- post-task live recovery-point discovery;
- separate verification state and deadline;
- explicit `retentionMutationAuthorized:false`.

Current execution limitations:

- Proxmox VE only;
- crash-consistent common semantics only;
- no disk exclusions;
- no prune/delete/garbage collection;
- no restore or restore drill;
- XO/XAPI/raw Xen and vSphere remain read-only/fail-closed for provider backup mutation.

Keep the flag off until a disposable Proxmox/PBS endpoint has passed the V3.3 promotion checks. A successful native task alone is not accepted as success; Docker Dash must observe a new canonical recovery point.
