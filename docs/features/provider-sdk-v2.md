# Provider SDK v2 — capabilities and common resources

Provider SDK v2 is the read-only foundation for a common virtualization control plane. It normalizes capability evidence and resource inventory for Proxmox VE, VMware vSphere/ESXi, and Xen providers (Xen Orchestra, XAPI, raw `xl`, and legacy `xm`).

## Endpoint

```http
GET /api/providers/:hostId/capabilities
GET /api/providers/:hostId/capabilities?refresh=true
```

The first form is available to authenticated users who can view that host. The refresh form requires an administrator and writes `provider_capability_refresh` to the audit log.

The response uses schema `1.0` and contains:

- provider type, variant, product/API version, and endpoint identity;
- probe status, timestamp, duration, and cache state;
- the complete neutral capability catalog;
- evidence state, source, reason, and bounded constraints for every feature.

States are `supported`, `conditional`, `unsupported`, and `unknown`. `unsupported` means the endpoint or Docker Dash adapter is confirmed not to provide the feature. `unknown` means the probe or available evidence cannot make that claim safely.

## Security and behavior

- credentials, endpoint URLs, native references, raw provider errors, SOAP/XML bodies, and SSH stderr are never returned;
- live probe failures return a safe `unreachable` envelope instead of converting capabilities into false `unsupported` claims;
- cache TTL is 60 seconds for success and 10 seconds for failed probes;
- concurrent probes for one host are deduplicated;
- host update, delete, or reconnect invalidates cached evidence;
- response size is capped at 256 KiB;
- Prometheus metrics use only bounded provider/status/cache labels.

The endpoint is controlled by `DD_PROVIDER_SDK_V2` (default `true`). It is additive and does not alter the legacy `/api/system/info` response.

## Common resource inventory

```http
GET /api/providers/:hostId/resources/:kind
GET /api/providers/:hostId/resources/:kind?limit=200
```

Accepted kinds are `virtual-machines`, `hosts`, `clusters`, `storages`, `networks`, and `tasks`. The endpoint requires authenticated `view` access to the selected host, checks live capability evidence before reading inventory, defaults to 200 items, and accepts an explicit limit from 1 to 500.

Every item uses resource schema `1.0` with a common base (`id`, `displayName`, provider, identity, labels, relationships, spec, status, actions, extensions). Canonical IDs have the opaque form `ddr_<kind>_<hash>` and are stable within one provider endpoint. Provider UUIDs are retained when stable; raw Xen domains are explicitly marked `transient`.

Provider-native references are never serialized. Docker Dash stores only their SHA-256 lookup hash and an AES-256-GCM encrypted value in `provider_resource_identities`, scoped by endpoint and resource kind. A stable provider UUID keeps the same canonical ID when an XAPI reference or vSphere managed-object reference changes.

Provider coverage in V0.2:

| Provider | Inventory kinds |
|---|---|
| Proxmox VE | virtual machines, hosts, storages |
| vSphere / ESXi | virtual machines, hosts, storages, networks |
| Xen Orchestra / XAPI | virtual machines, hosts, clusters, storages, networks, tasks |
| Raw Xen (`xl`/`xm`) | virtual machines and host; unsupported kinds are rejected by capability gating |

Inventory is deterministic and bounded. Provider errors are replaced with safe error codes, task result/error summaries are allowlisted and redacted, and a failed normalization rolls back the local identity transaction.

## Current boundary

V0.2 does not add VM mutations or cursor pagination. It reports only inventory already implemented by each adapter. Upstream product support does not become `supported` until the corresponding Docker Dash operation and its safety tests exist.
