# Provider VM console gateway

Docker Dash provides a same-origin browser console for running virtual machines without disclosing provider API credentials, console tickets or VNC passwords to the browser. The gateway supports RFB/noVNC and serial sessions through one audited authorization boundary.

## Enablement

```env
DD_PROVIDER_VM_CONSOLE=true
DD_PROVIDER_VM_CONSOLE_ACCESS_OVERRIDE=managed
```

The feature defaults to false. Users require an administrator or operator role plus `operate` permission on the selected provider endpoint. A live capability probe, a running or paused VM and an unlocked console scope are also mandatory.

Operational bounds are configurable:

```env
DD_PROVIDER_VM_CONSOLE_TOKEN_TTL_SECONDS=45
DD_PROVIDER_VM_CONSOLE_MAX_PENDING_PER_USER=5
DD_PROVIDER_VM_CONSOLE_MAX_ACTIVE_PER_USER=3
DD_PROVIDER_VM_CONSOLE_MAX_ACTIVE_PER_IP=5
DD_PROVIDER_VM_CONSOLE_MAX_SESSION_SECONDS=3600
```

## Security model

- launch tokens contain 256 bits of randomness, are user-bound, single-use and stored only as SHA-256 hashes;
- the token travels in the URL fragment for the initial page handoff, is removed immediately, then travels in a dedicated WebSocket subprotocol rather than a query string;
- the gateway requires an authenticated session cookie, same-origin WebSocket request, endpoint permission and current emergency-lock state;
- provider tickets, session cookies, API tokens and VNC passwords remain server-side;
- upstream RFB authentication terminates in the gateway; the already-authorized browser receives a synthetic no-auth RFB 3.8 stream;
- WebSocket compression is disabled, payload and connection counts are bounded, and every issue/open/failure/close is audited;
- global, endpoint and VM locks stop active sessions and block new ones. `deny` provides an environment-level incident-response lock; `allow` is an explicit recovery override.

## Provider behavior

| Provider | Browser protocol | Upstream transport |
|---|---|---|
| Proxmox VE | noVNC/RFB | short-lived `vncproxy` ticket plus `vncwebsocket`; SPICE-display guests use the provider's browser-compatible VNC proxy |
| vSphere/ESXi | noVNC/RFB | one-time `AcquireTicket(webmks)` WebSocket; VMware RFB extensions negotiate down to standard RFB 3.8 |
| Xen Orchestra | noVNC/RFB | authenticated `/api/consoles/:id` WebSocket proxy; requires a scoped XO token |
| XenServer/XCP-ng direct XAPI | noVNC/RFB or serial | console record location via WSS, with the documented HTTPS CONNECT fallback |
| raw Xen `xl`/`xm` | serial | pinned SSH host key and an interactive `xl console`/`xm console` PTY |

Native SPICE `.vv` handoff is intentionally not exposed in this batch because it would place a short-lived provider password in a client file. RDP and VMConnect remain guest-network/native-client concerns rather than hypervisor-console transports.

noVNC 1.5.0 is self-hosted and bundled reproducibly with `npm run build:novnc`. It is distributed under MPL-2.0; the exact package source and license remain available through the pinned production dependency.
