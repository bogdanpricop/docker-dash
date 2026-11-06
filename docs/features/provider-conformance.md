# Provider conformance and compatibility

Docker Dash validates provider adapters and real endpoints before using their capability evidence as a release gate. The kit is read-only: it probes capabilities and bounded inventory, but never starts, stops, snapshots, migrates or otherwise changes a VM or hypervisor.

## What is checked

- provider manifest, ownership, variants, API families and release rings;
- complete Provider SDK capability catalog;
- inventory method/schema mapping and stable canonical IDs;
- sanitized fixtures for Proxmox, vSphere and Xen XO/XAPI/raw;
- timeout, expired authentication, partial response, redirect and lost-task behavior;
- mutation safety requirements for future actions;
- secret leakage in stored/API evidence;
- live read-only capabilities and at most 25 items per advertised inventory kind.

Every live run stores weighted checks, a grade (`certified`, `conditional` or `failed`) and a deterministic SHA-256 evidence hash. The product scorecard maps every capability to `shipped`, `partial` or `planned` and links it to live or fixture evidence.

## API

| Method | Endpoint | Access | Purpose |
|---|---|---|---|
| GET | `/api/providers/manifests` | authenticated | compatibility and release metadata |
| GET | `/api/providers/scorecard` | authenticated | provider capability scorecard and conformance SLO |
| GET | `/api/providers/conformance/export` | admin | portable JSON evidence export with integrity hash |
| GET | `/api/providers/:hostId/conformance` | host view | recent runs |
| GET | `/api/providers/:hostId/conformance/:runId` | host view | run and checks |
| POST | `/api/providers/:hostId/conformance` | admin + host view | start `live_readonly` certification |

The POST body can be empty or `{ "mode": "live_readonly" }`. Only one run per host is allowed at a time.

## Endpoint protection

Requests share a per-host adaptive concurrency budget. Repeated transient failures open a circuit; after cooldown, exactly one half-open request tests recovery. Defaults can be changed with:

- `DD_PROVIDER_MAX_CONCURRENCY=2`
- `DD_PROVIDER_MAX_QUEUE=64`
- `DD_PROVIDER_REQUEST_TIMEOUT_MS=30000`
- `DD_PROVIDER_CIRCUIT_FAILURES=3`
- `DD_PROVIDER_CIRCUIT_COOLDOWN_MS=30000`
- `DD_PROVIDER_CONFORMANCE_RETENTION_DAYS=365`

The retention job runs before a new certification and deletes only completed conformance runs older than the configured window. Related checks are removed through the database foreign key.

## Interpreting evidence

`fixture-tested` proves adapter contract behavior against a sanitized corpus. `endpoint-tested` proves that a named environment passed a live read-only run. Neither state claims that future mutations are safe: each mutating batch still needs operation-engine integration, capability gates, disposable-resource preflight and post-action verification.
