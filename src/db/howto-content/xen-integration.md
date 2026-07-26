---
slug: xen-integration
title: Xen, XCP-ng and XenServer integration
category: docker-dash
difficulty: advanced
icon: fas fa-cloud
summary: Register Xen Orchestra, native XAPI, or a standalone Xen Project host and manage capability-gated VM operations.
---

## Choose the management plane

Use **Xen Orchestra** for a multi-pool fleet, **XAPI** for direct XCP-ng/XenServer access, or **Raw Xen** for a standalone Xen Project dom0.

| Choice | Credentials | Best fit |
|---|---|---|
| Xen Orchestra | token (recommended), or username/password | central fleet management |
| XAPI | dedicated username/password | one XCP-ng/XenServer pool |
| Raw Xen | pinned SSH key + restricted sudo | standalone `xl`/libxl; legacy `xm` fallback |

## Register

1. Open **Hosts → Non-Docker host**.
2. Select **Xen / XCP-ng / XenServer**.
3. Select the management plane and complete its fields.
4. Prefer a trusted CA. Use **Skip TLS verification** only for a temporary test.
5. Press **Test connection**, save, then open **Xen / XCP-ng** in the sidebar.

The Xen page shows pools, hosts, VMs, storage repositories, networks and asynchronous tasks. Power and snapshot buttons appear only when both the provider and your role support them.

## Production checklist

- Create a least-privilege service identity and grant only the required pool/VM operations.
- Pin the CA for HTTPS, or the SHA-256 server host key for raw SSH.
- Keep emergency access to the native Xen console before testing power or snapshot operations.
- Review all writes in **Audit Log**.
- Treat legacy Xend/`xm` as a migration bridge; it is obsolete and exposes a smaller capability set.

See the full [compatibility and security reference](https://github.com/bogdanpricop/docker-dash/blob/main/docs/features/xen-integration.md).
