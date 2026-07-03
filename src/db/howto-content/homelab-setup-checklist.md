---
slug: homelab-setup-checklist
title: Homelab setup — install everything docker-dash can manage
title_ro: Configurare homelab — instaleaza tot ce poate gestiona docker-dash
category: homelab-setup
difficulty: intermediate
icon: fas fa-network-wired
summary: Master checklist for standing up a homelab with all 7 daemon types + Wasm-capable Docker, and connecting each to docker-dash.
summary_ro: Checklist master pentru configurarea unui homelab cu toate cele 7 tipuri de daemoni + Docker cu suport Wasm, si conectarea fiecaruia la docker-dash.
---

## Why this exists

You have docker-dash running and a LAN with ESXi. This is the master guide that tells you, in order, what to spin up and how to connect it to docker-dash. Each row links to a step-by-step install howto.

**Secondary purpose:** running through this whole checklist is exactly what turns the current alpha releases into betas. Each successful integration = one blocker cleared.

## The reference LAN topology

```
192.168.13.20  → docker-dash (this app)  [Docker]
192.168.13.21  → proxmox-test            [Proxmox VE 8]
192.168.13.22  → homelab-lxd             [Ubuntu 24.04 + LXD snap]
192.168.13.23  → homelab-incus           [Debian 12 + Incus (Zabbly)]
192.168.13.24  → homelab-k3s             [Ubuntu 24.04 + k3s]
192.168.13.25  → homelab-nomad           [Ubuntu 24.04 + Nomad dev + Docker]
192.168.13.26  → homelab-podman          [Rocky Linux 9 + Podman]
192.168.13.27  → homelab-wasm            [Debian 12 + Docker + WasmEdge runtime]
```

All hosted as nested VMs on your existing ESXi. Approximate RAM budget: **2 + 8 + 2 + 2 + 2 + 1 + 1 + 2 = 20 GB** across 8 VMs.

## Setup order (recommended)

Each step is a separate howto. Do them **in this order** — each builds on the previous:

### 1. Proxmox (biggest, do first while you have patience)
[Install Proxmox VE 8 on ESXi](../howto/install-proxmox-on-esxi)
- **20-30 min setup**
- Unblocks: Sprint 4 (Proxmox), Sprint 7 (VM Migration)
- Register in docker-dash as **Proxmox VE** with API token

### 2. LXD (fastest big-impact win)
[Install LXD on Ubuntu](../howto/install-lxd-ubuntu)
- **10 min setup** — one snap install command
- Unblocks: Sprint 8 (LXD)
- Register in docker-dash as **LXD** with Unix socket or HTTPS + client cert

### 3. Incus (alternative to LXD; do only if you want to test both forks)
[Install Incus on Debian](../howto/install-incus-debian)
- **10 min setup** — one apt install command
- Unblocks: Sprint 3 (Incus)
- Register in docker-dash as **Incus**

### 4. k3s
[Install k3s single-node](../howto/install-k3s-single-node)
- **5 min setup** — one curl-pipe-sh command
- Unblocks: Sprint 5 (Kubernetes)
- Register in docker-dash as **Kubernetes** with ServiceAccount bearer token

### 5. Nomad
[Install Nomad dev agent](../howto/install-nomad-dev)
- **10 min setup** — one Go binary + one systemd unit
- Unblocks: Sprint 10 (Nomad)
- Register in docker-dash as **Nomad**

### 6. Podman
[Install Podman on Rocky/Fedora/RHEL](../howto/install-podman-rhel)
- **5 min setup**
- Unblocks: Sprint 1 (Podman auto-detection)
- Register in docker-dash as **regular Docker host via SSH** — auto-detects Podman badge

### 7. Wasm-capable Docker host (optional but validates Sprint 9)
1. Take any existing Docker host (or spin up a new Debian VM)
2. Install WasmEdge + containerd shim per the [Wasm workloads howto](../howto/wasm-workloads)
3. Register `/etc/docker/daemon.json`:
   ```json
   {
     "runtimes": {
       "io.containerd.wasmedge.v1": {
         "path": "/usr/local/bin/containerd-shim-wasmedge-v1"
       }
     }
   }
   ```
4. `sudo systemctl restart docker`
5. In docker-dash → System page → check `runtimeCategories.wasm` in the info panel (v8.9.5+)

## Test workloads after each setup

To make sure each integration surfaces data (not just an empty screen), deploy one test workload per host:

| Daemon | Test workload | Command |
|---|---|---|
| **Proxmox** | New VM (small) | Proxmox UI → Create VM (ISO boot) |
| **LXD** | `test-container` (Ubuntu 24.04) | `lxc launch ubuntu:24.04 test-container` |
| **Incus** | `test-container` (Debian 12) | `incus launch images:debian/12 test-container` |
| **k3s** | Nginx deployment (2 replicas) | `kubectl create deployment nginx --image=nginx --replicas=2` |
| **Nomad** | Redis job | `nomad job run redis.nomad.hcl` (see Nomad howto) |
| **Podman** | Nginx container | `podman run -d --name web -p 8080:80 nginx:alpine` |
| **Wasm Docker** | Wasm hello-world | `docker run --rm --runtime=io.containerd.wasmedge.v1 --platform=wasi/wasm michaelirwin244/wasm-example` |

## Full end-to-end migration test

Once Proxmox is set up, run through [ESXi → Proxmox migration](../howto/esxi-to-proxmox-migration). This is the **highest-value single verification** — it exercises Sprint 7 (the killer feature) against real infrastructure.

## What each successful integration unlocks

| Verified integration | Promotes | To |
|---|---|---|
| Proxmox — register + browse tabs | v8.9.1 Proxmox | alpha → beta candidate |
| LXD — register + browse instances | v8.9.3 LXD | alpha → beta candidate |
| Incus — register + browse instances | v8.9.0 Incus | alpha → beta candidate |
| Kubernetes — register + browse tabs | v8.9.4 Kubernetes | alpha → beta candidate (only after write ops in alpha.2) |
| Nomad — register + browse tabs | v8.9.5 Nomad | alpha → beta candidate (only after write ops in alpha.2) |
| Podman — auto-detect badge | v8.7.44 Podman | already stable-adjacent |
| Wasm — `runtimeCategories.wasm` populated | v8.9.5 Wasm detection | alpha → beta |
| VM Migration — full ESXi → Proxmox run | v8.9.2 VM Migration | alpha → beta candidate |

## Reporting back

Once a daemon is registered and you can see data in docker-dash:
1. Take a screenshot of the info card + first tab
2. Note anything that broke or was unclear
3. File under the corresponding sprint's github issue (or just tell me in the next session)

The bugs you find during this exercise are **the real blocker** for beta. Every alpha caveat in the changelog says "end-to-end not verified against a live daemon" — this checklist is what turns that into "verified against a live daemon."

## Estimated total time

- **Fast path** (all 7 daemons, no test workloads, no VM Migration): ~2-3 hours across all setups
- **Full path** (with test workloads and one migration): ~4-6 hours
- **Split it up** — one daemon per evening

## References

- [Docker Dash hosts page](/#/hosts)
- [What's New](/#/whatsnew)
- Individual howtos linked above
