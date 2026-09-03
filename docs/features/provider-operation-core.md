# Durable provider operation core

Docker Dash uses a persistent operation engine for Provider SDK mutations. V0.3 supplies the safety and observability substrate; the VM power, snapshot, provisioning, migration and storage handlers are added in their provider-specific batches.

## Activity Center API

```http
GET  /api/operations
GET  /api/operations/:id
GET  /api/operations/:id/events
POST /api/operations/:id/cancel
POST /api/operations/:id/resolve
```

List accepts `state`, `hostId`, and `limit` (1–500). Responses never expose the encrypted request, idempotency key/hash, worker lease owner, lock internals, or native provider task reference. A user sees only operations on hosts where they have `view`; cancel requires `operate`; only an admin can resolve `unknown`.

The operation schema is version `1.0`. States are `queued`, `running`, `waiting_retry`, `reconciling`, `cancel_requested`, `succeeded`, `failed`, `cancelled`, and `unknown`. Database state is authoritative; WebSocket channel `provider:operations` provides best-effort live refresh.

Activity Center also projects the operation owner, native-task presence/state, timing and server-derived `canCancel`/`canResolve` permissions. Native provider references remain encrypted and hidden. Cancellation is exposed only while it can still be requested; an admin can resolve `unknown` only after recording evidence, and the UI requires the exact operation ID before releasing the retained lock.

## Safety behavior

- every mutation requires a caller-generated idempotency key;
- reusing a key with the same request deduplicates; reusing it for a different request returns conflict;
- request payloads and native task refs use AES-256-GCM at rest;
- resource lock sets are acquired atomically and have worker-owner leases;
- retry applies only to transient errors from idempotent handlers;
- timeout and expired worker lease enter reconciliation rather than blind replay;
- unconfirmed cancellation and an unreconcilable timeout become `unknown`;
- an `unknown` operation retains its resource lock until manual resolution, initially for 24 hours;
- manual resolution requires bounded evidence and writes an audit event;
- results, errors, progress events and policy reasons are bounded and redacted.

## Control policies

```http
GET /api/operations/policies
PUT /api/operations/policies/:scopeType/:scopeKey
```

Policies are admin-only. `scopeType` is `global`, `provider`, or `host`; modes are `active`, `read_only`, `emergency_stop`, and `frozen`. A frozen policy requires explicit ISO start/end timestamps. Global dynamic read-only is also enforced by the common `writeable` middleware. Policy administration and manual resolution remain available as recovery paths.

Emergency stop cancels queued work locally and sends running/native work through the handler's safe cancel path. It never declares provider cancellation successful without confirmation.

## Worker configuration

```dotenv
DD_PROVIDER_OPERATION_CONCURRENCY=4
DD_PROVIDER_OPERATION_POLL_MS=1000
DD_PROVIDER_OPERATION_LEASE_MS=30000
```

The worker timer is unreferenced and is stopped explicitly during graceful shutdown. Values are bounded in code even if the environment contains an unsafe value.

## Current boundary

There is deliberately no public generic create-operation endpoint. Only registered server-side handlers can enqueue work. Legacy ACME, remediation, migration and procedure jobs keep their existing contracts; their later convergence will use explicit adapters rather than a destructive data migration.

Provider task semantics follow the official [vSphere Task model](https://developer.broadcom.com/xapis/vsphere-web-services-api/latest/vim.Task.html), [XAPI task contract](https://xapi-project.github.io/xen-api/classes/task.html) and [Proxmox task/UPID guidance](https://pve.proxmox.com/pve-docs/pve-admin-guide.pdf). A cancellation request is never treated as proof of cancellation.
