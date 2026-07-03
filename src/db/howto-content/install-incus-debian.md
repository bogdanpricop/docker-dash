---
slug: install-incus-debian
title: Install Incus on Debian (test lab for docker-dash)
title_ro: Instalare Incus pe Debian (laborator de test pentru docker-dash)
category: homelab-setup
difficulty: beginner
icon: fas fa-cubes
summary: Spin up a Debian 12 VM, install Incus from the Zabbly repo, and register it in docker-dash.
summary_ro: Ruleaza un VM Debian 12, instaleaza Incus din repo-ul Zabbly si inregistreaza-l in docker-dash.
---

## Why Incus (and not just LXD)?

Incus is the community fork of LXD (2024). Same REST API for everything docker-dash cares about, but:
- **Not a snap** — cleaner install on Debian / non-Ubuntu
- Actively developed by the original LXD maintainers
- No Canonical opinions baked in
- Included in Debian 13 (trixie) base repos

For docker-dash testing purposes, LXD and Incus are interchangeable. Pick the one that matches your OS.

## Requirements

- Debian 12 (bookworm) or 13 (trixie) VM — 2 GB RAM, 2 vCPU, 20 GB disk
- On ESXi: same VM creation as [LXD](../howto/install-lxd-ubuntu), just pick "Debian" as guest OS

## Step 1 — Install Incus

**Debian 13 (trixie)** — Incus in base repos:
```bash
sudo apt update
sudo apt install -y incus incus-ui-canonical
```

**Debian 12 (bookworm)** — use the Zabbly repo (maintained by Stéphane Graber):
```bash
curl -fsSL https://pkgs.zabbly.com/key.asc | sudo gpg --dearmor -o /etc/apt/keyrings/zabbly.gpg
cat <<EOF | sudo tee /etc/apt/sources.list.d/zabbly-incus-stable.sources
Enabled: yes
Types: deb
URIs: https://pkgs.zabbly.com/incus/stable
Suites: $(. /etc/os-release && echo ${VERSION_CODENAME})
Components: main
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/zabbly.gpg
EOF

sudo apt update
sudo apt install -y incus
```

## Step 2 — Add your user to the incus-admin group

```bash
sudo usermod -aG incus-admin $USER
newgrp incus-admin    # or logout + login
```

## Step 3 — Initialize Incus

```bash
sudo incus admin init --minimal
```

Same defaults as `lxd init --minimal`: dir-backed storage pool + `incusbr0` bridge with DHCP.

For ZFS instead:
```bash
sudo incus admin init
# Same prompts as LXD's init. Answer:
# - Storage backend: zfs
# - New pool: yes, size 10GB
# - Bridge: yes, name incusbr0
```

## Step 4 — Launch a test instance

```bash
incus launch images:debian/12 test-container
incus list
```

Notice `images:` instead of `ubuntu:` — Incus uses the linuxcontainers.org image server. Available images:
```bash
incus image list images: | head -20
```

## Step 5 — Enable HTTPS remote access (for docker-dash on a different host)

```bash
sudo incus config set core.https_address :8443
sudo incus config set core.trust_password some-temporary-password

sudo cat /var/lib/incus/server.crt   # copy to docker-dash side
```

Same trust flow as LXD — on docker-dash side, generate a client cert:
```bash
openssl req -x509 -newkey rsa:4096 -keyout dd-incus.key -out dd-incus.crt \
  -days 3650 -nodes -subj "/CN=docker-dash"
```

Trust on Incus side:
```bash
sudo incus config trust add ./dd-incus.crt
sudo incus config unset core.trust_password
```

## Step 6 — Register Incus in docker-dash

### Case A: docker-dash on the same host

Mount the Incus socket:
```yaml
services:
  docker-dash:
    volumes:
      - /var/lib/incus/unix.socket:/var/lib/incus/unix.socket
```

Then in docker-dash:
- Sidebar → **Hosts** → **Non-Docker host (alpha)** → **Incus**
- Transport: **Unix socket**
- Socket path: `/var/lib/incus/unix.socket` (pre-filled)

### Case B: docker-dash on a different host

- **Non-Docker host (alpha)** → **Incus**
- Transport: **HTTPS**
- Endpoint: `https://192.168.13.23:8443`
- Paste `dd-incus.crt` and `dd-incus.key`
- Skip TLS verification: ☑

## Verification checklist

- [ ] Sidebar → **Incus / LXD (alpha)** appears (same nav entry serves both)
- [ ] Info card shows server version
- [ ] Instance list includes `test-container` with status **Running**

## Troubleshooting

**"apt: incus not found" on Debian 12**

You skipped the Zabbly repo. Redo step 1.

**Same troubleshooting as LXD** — the REST API is identical.

## References

- [Incus documentation](https://linuxcontainers.org/incus/docs/main/)
- [Zabbly Incus packages](https://github.com/zabbly/incus)
- [Docker Dash Incus integration howto](../howto/incus-integration)
