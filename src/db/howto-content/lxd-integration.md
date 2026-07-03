---
slug: lxd-integration
title: LXD integration (alpha)
title_ro: Integrare LXD (alpha)
category: docker-dash
difficulty: intermediate
icon: fas fa-cubes
summary: Register a Canonical LXD daemon in Docker Dash and manage its containers + VMs.
summary_ro: Inregistreaza un daemon LXD (Canonical) in Docker Dash si gestioneaza containere + VM-uri.
---

## Why LXD and not just Incus?

LXD is Canonical's system container + KVM VM manager. In 2024 the LXD lead maintainer and community forked it into **Incus**. Docker Dash added Incus in v8.9.0 (Sprint 3) and now adds LXD support in v8.9.3-alpha.1 (Sprint 8).

**Why both?** The two share the exact same REST API for every operation Docker Dash cares about (instances, snapshots, projects, operations polling). But Ubuntu servers install LXD by default via snap — many production LXD deployments have never migrated to Incus. Supporting LXD directly saves them the migration step.

Under the hood, `IncusClient` is reused with `daemonType='lxd'` and a different default socket path.

## Register an LXD daemon

### 1. Local LXD (same host as Docker Dash)

Mount the LXD Unix socket into the docker-dash container:

```yaml
services:
  docker-dash:
    volumes:
      # Snap install (Ubuntu default) — the most common case:
      - /var/snap/lxd/common/lxd/unix.socket:/var/snap/lxd/common/lxd/unix.socket
      # Or, if you have a legacy /var/lib/lxd/ install:
      # - /var/lib/lxd/unix.socket:/var/lib/lxd/unix.socket
```

Then INSERT a host row into the DB via the docker-dash shell:

```bash
docker exec docker-dash node -e '
const { getDb } = require("/app/src/db");
const { encryptDaemonConfig } = require("/app/src/services/incus");
const cfg = { transport: "unix", socket: "/var/snap/lxd/common/lxd/unix.socket" };
getDb().prepare(`INSERT INTO docker_hosts (name, connection_type, daemon_type, daemon_config)
  VALUES ("local-lxd", "unix", "lxd", ?)`).run(encryptDaemonConfig(cfg));
console.log("LXD host registered");
'
```

### 2. Remote LXD (HTTPS + client cert)

LXD's default TLS listener runs on port 8443. Trust a client cert on the LXD side first:

```bash
# On the LXD host:
lxc config trust add ./docker-dash.crt      # PEM-encoded client cert
```

Then, encrypted config in docker-dash:

```bash
docker exec docker-dash node -e '
const { getDb } = require("/app/src/db");
const { encryptDaemonConfig } = require("/app/src/services/incus");
const fs = require("fs");
const cfg = {
  transport: "https",
  endpoint: "https://lxd.example.com:8443",
  cert: fs.readFileSync("/data/docker-dash.crt", "utf8"),
  key: fs.readFileSync("/data/docker-dash.key", "utf8"),
  skipTlsVerify: false,
};
getDb().prepare(`INSERT INTO docker_hosts (name, connection_type, daemon_type, daemon_config)
  VALUES ("remote-lxd", "tcp", "lxd", ?)`).run(encryptDaemonConfig(cfg));
console.log("Remote LXD host registered");
'
```

## What works in this alpha

Same feature set as Incus (Sprint 3), because it's the same client code:

- List instances (containers + KVM VMs) with status, IPs, memory, CPU
- Per-instance start / stop / restart / freeze / unfreeze / delete
- Snapshot list / create / restore / delete
- Read-only images + projects listings

## Differences from Incus

At the code level: **none that matter for Docker Dash's current features.** The two forks agree on everything we call. Divergence exists on:

- Newer LXD-only features (e.g. Canonical's cluster-wide roles) — not exposed here
- Newer Incus-only features (e.g. OCI image support) — not exposed here

If either fork adds an endpoint we want to use later, the client will need a daemon-type check. Right now, the client is daemon-type-agnostic.

## Where LXD is visible in the UI

Sidebar entry **"Incus / LXD (alpha)"** shows up when at least one host has `daemon_type IN ('incus', 'lxd')`. Same page, same URL (`/#/incus-instances`), same table.

## Security notes

- All Incus/LXD write actions are audit-logged under `incus_*` action names, with `daemonType` in the `details` field for provenance
- `daemon_config` is encrypted at rest via AES-256-GCM (`enc:` prefix) — identical helper to the Incus / Proxmox / git credential storage
- Client certs (PEM) live in `daemon_config.cert` + `daemon_config.key` — same encryption applies
- LXD's cert-fingerprint trust model is preserved (`skipTlsVerify: false` by default; set to `true` only for testing)

## Troubleshooting

**"connect ENOENT /var/snap/lxd/common/lxd/unix.socket"**

The snap socket path isn't the one your install uses. Try the legacy path `/var/lib/lxd/unix.socket` or check with `lxc config get core.remote_address` on the LXD host.

**"HTTP 403 / trust cert not accepted"**

The client cert hasn't been added to LXD's trust store. Run `lxc config trust add ./docker-dash.crt` on the LXD host, or set `skipTlsVerify: true` in dev to bypass (never in production).

**Both LXD and Incus registered, only one shows in sidebar**

`data-fleet-daemon="incus,lxd"` OR-matches. If the sidebar hides, verify `/api/hosts` returns your rows with `daemonType` set (`GET /api/hosts | jq '.[].daemonType'`).

## References

- [LXD documentation (Canonical)](https://documentation.ubuntu.com/lxd/)
- [Incus documentation (community fork)](https://linuxcontainers.org/incus/docs/main/)
- [Incus vs LXD API comparison](https://linuxcontainers.org/incus/docs/main/faq/#incus-vs-lxd)
