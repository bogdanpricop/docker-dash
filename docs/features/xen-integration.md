# Xen integration

Docker Dash exposes one normalized `xen` daemon type while keeping the native management plane explicit. This avoids guessing product editions from version strings and allows the API and UI to gate every operation on detected capabilities.

## Compatibility contract

| Provider | Products / generations | Transport | Inventory | Power | Snapshots | Notes |
|---|---|---|---|---|---|---|
| `xo` | Xen Orchestra managing XCP-ng or XenServer pools | HTTPS REST `/rest/v0` | pools, hosts, VMs, SRs, networks, tasks | yes | yes | Recommended for multi-pool fleets |
| `xapi` | XCP-ng, XenServer, Citrix Hypervisor and compatible XAPI appliances | HTTPS JSON-RPC 2.0, automatic XML-RPC fallback | pools, hosts, VMs, SRs, networks, tasks | async tasks | async tasks | Follows pool-master redirects and renews invalid sessions |
| `raw` | Xen Project with `xl`/libxl; legacy Xend installations with `xm` | SSH, strict command allowlist | running domains and dom0 information | capability-gated | no portable contract | `xm` is detected only when `xl` is absent; Domain-0 is protected |

“All Xen versions” means the management surfaces above, including the legacy `xm` read/action subset. It does not promise identical features on every historic release. The page shows the provider's capability matrix and suppresses unavailable actions. Xend/`xm` is obsolete and should be used only while migrating an old installation.

Authoritative protocol references:

- [XCP-ng API guidance](https://docs.xcp-ng.org/management/manage-locally/api/)
- [Xen Orchestra REST API](https://docs.xen-orchestra.com/restapi/)
- [XenServer wire protocol](https://docs.xenserver.com/en-us/xenserver/developer/xenserver-9/management-api/wire-protocol.html)
- [XenServer API session/task guidance](https://docs.xenserver.com/en-us/xenserver/developer/sdk-guide/using)
- [Xen Project xl manual](https://xenbits.xenproject.org/docs/4.17-testing/man/xl.1.html)
- [Legacy xm manual](https://xenbits.xen.org/docs/4.3-testing/man/xm.1.html)

## Registration

Open **Hosts → Non-Docker host**, choose **Xen / XCP-ng / XenServer**, then choose a management plane.

For Xen Orchestra, use an authentication token and a trusted CA certificate. Username/password Basic authentication is supported as a compatibility fallback.

For XAPI, target the pool coordinator when possible and use a dedicated account. `auto` tries JSON-RPC first and falls back to XML-RPC. If a supporter responds with `HOST_IS_SLAVE`, Docker Dash reconnects to the coordinator while preserving the configured TLS policy.

For raw Xen, create a dedicated SSH account. Prefer key authentication, pin `hostKeySha256`, and grant passwordless sudo only for the required `xl`/`xm` commands. The integration never opens a shell supplied by the browser: actions and identifiers pass strict allowlists and Domain-0 cannot be targeted.

## Security and operations

- Provider credentials, tokens, CA material, and SSH keys are AES-256-GCM encrypted in `daemon_config`.
- Read endpoints require host `view`; state-changing endpoints require host `operate`, global admin, and writeable mode.
- Force shutdown/reboot, snapshot revert, and snapshot deletion require explicit confirmation. Force actions can require typing the VM name in the UI.
- Every state-changing Xen operation is written to the common audit log.
- XAPI opaque references are used only inside the active session. Persistent UI identity uses VM/SR/network UUIDs.
- XAPI sessions are renewed after `SESSION_INVALID` and logged out when a client is evicted or its host config changes.
- Async operations return task references and appear in the Tasks tab. Completed native XAPI task records can be deleted from the UI so clients comply with XAPI task-lifecycle guidance.

## GitOps host shape

The existing host GitOps schema accepts `daemonType: xen`. As with other non-Docker providers, secret values are registered interactively and GitOps preserves them by reference; do not put credentials in a repository.

```yaml
hosts:
  - name: xcp-production
    daemonType: xen
    environment: production
```

## Deliberate boundaries

Provisioning, console proxying, backup orchestration, migration, PCI/SR mutation, and host power operations are not part of this first contract. They require additional storage/network policy and stronger recovery workflows. Raw `xl`/`xm` snapshots are intentionally unavailable because there is no backend-neutral safe snapshot contract.
