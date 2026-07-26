# Provider SDK v2 — capability contract

Provider SDK v2 is the read-only foundation for a common virtualization control plane. It currently normalizes capability evidence for Proxmox VE, VMware vSphere/ESXi, and Xen providers (Xen Orchestra, XAPI, raw `xl`, and legacy `xm`).

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

## Current boundary

V0.1 does not add VM mutations. It reports only what existing adapters actually implement. Upstream product support does not become `supported` until the corresponding Docker Dash operation and its safety tests exist.
