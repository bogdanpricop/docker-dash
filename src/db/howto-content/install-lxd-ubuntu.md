---
slug: install-lxd-ubuntu
title: Install LXD on Ubuntu (test lab for docker-dash)
title_ro: Instalare LXD pe Ubuntu (laborator de test pentru docker-dash)
category: homelab-setup
difficulty: beginner
icon: fas fa-cubes
summary: Spin up an Ubuntu VM (on ESXi or bare metal), install LXD via snap, and register it in docker-dash.
summary_ro: Ruleaza un VM Ubuntu (pe ESXi sau hardware), instaleaza LXD via snap si inregistreaza-l in docker-dash.
---

## Why this recipe

LXD is Canonical's system container + KVM VM manager. It's **installed by default on Ubuntu Server** (via snap) — so setting up a test lab is basically "spin up an Ubuntu VM, run one command, done."

Perfect for verifying docker-dash's LXD support (v8.9.3+) end-to-end before promoting Sprint 8 out of alpha.

## Requirements

- ESXi or any hypervisor that can boot Ubuntu (VirtualBox, KVM, Hyper-V — LXD does NOT need nested virtualization for containers, but does for KVM VMs inside LXD)
- 1 VM: 2 GB RAM, 2 vCPU, 20 GB disk
- Ubuntu Server 22.04 or 24.04 LTS ISO
- Static IP in your LAN

## Step 1 — Create the Ubuntu VM on ESXi

Same procedure as [Proxmox on ESXi](../howto/install-proxmox-on-esxi) but simpler:

- Guest OS: **Ubuntu Linux (64-bit)**
- 2 vCPU, 2 GB RAM, 20 GB disk
- Mount the Ubuntu Server ISO
- **Enable nested virtualization on the CPU** only if you want to test LXD KVM VMs (not needed for containers)
- Boot and install:
  - Default Ubuntu Server profile
  - Static IP (e.g. `192.168.13.22`)
  - Enable OpenSSH server
  - **Skip** all the featured server snaps (LXD comes preinstalled)
  - Create a user

## Step 2 — Initialize LXD

SSH in and initialize LXD with sane defaults:

```bash
ssh <user>@192.168.13.22

# Add your user to the lxd group so you don't need sudo
sudo usermod -aG lxd $USER
newgrp lxd    # or logout + login

# Initialize with defaults
sudo lxd init --minimal
```

`lxd init --minimal` creates:
- Default storage pool `default` (dir backend, in `/var/snap/lxd/common/lxd/storage-pools/default`)
- Default bridge `lxdbr0` with DHCP for containers

For a slightly better lab (ZFS storage):
```bash
sudo lxd init
# Answer the prompts. Recommended:
# - Storage backend: zfs
# - Create a new ZFS pool: yes
# - Loop device: yes (or provide a real block device)
# - Size in GB: 10
# - Bridge: yes, name lxdbr0
# - MAAS: no
# - Available over network: no (or yes if you want HTTPS remote — see step 4)
# - Trust password: (only if network access enabled)
```

## Step 3 — Launch a test instance to verify

```bash
lxc launch ubuntu:24.04 test-container
lxc list
lxc exec test-container -- bash
# inside the container:
apt update && apt install -y curl
curl -s https://ifconfig.me
exit
```

You should see the container's public IP (routed via the LXD bridge → NAT on the host).

Verify VM support:
```bash
lxc launch ubuntu:24.04 test-vm --vm --config limits.memory=1GB
lxc list
```

This will fail with "KVM not available" if you didn't enable nested virtualization on ESXi. That's OK for now — containers alone are enough to verify docker-dash's LXD integration.

## Step 4 — Enable HTTPS remote access (for docker-dash from another host)

If docker-dash runs on the SAME host as LXD, skip this — use the Unix socket path.

If docker-dash runs on a different host (e.g. VPS or another LAN box), you need HTTPS + client cert:

```bash
# On the LXD host:
sudo lxc config set core.https_address :8443
sudo lxc config set core.trust_password some-temporary-password

# Show the LXD server certificate — copy this to the docker-dash side:
sudo cat /var/snap/lxd/common/lxd/server.crt
```

Now create a client cert on the docker-dash host:
```bash
openssl req -x509 -newkey rsa:4096 -keyout dd-lxd.key -out dd-lxd.crt \
  -days 3650 -nodes -subj "/CN=docker-dash"
cat dd-lxd.crt  # copy to LXD host
```

Trust the client cert on the LXD host:
```bash
# On the LXD host:
sudo lxc config trust add ./dd-lxd.crt

# Verify:
sudo lxc config trust list
```

Then clear the trust password (only meant to be temporary):
```bash
sudo lxc config unset core.trust_password
```

## Step 5 — Register LXD in docker-dash

### Case A: docker-dash on the same host as LXD

1. Mount the LXD socket into the docker-dash container. Edit `docker-compose.yml`:
   ```yaml
   services:
     docker-dash:
       volumes:
         - /var/snap/lxd/common/lxd/unix.socket:/var/snap/lxd/common/lxd/unix.socket
   ```
2. `docker compose up -d docker-dash`
3. Sidebar → **Hosts** → **Non-Docker host (alpha)** → daemon type **LXD**
4. Transport: **Unix socket**
5. Socket path: `/var/snap/lxd/common/lxd/unix.socket` (pre-filled)
6. Submit

### Case B: docker-dash on a different host (HTTPS + client cert)

1. Sidebar → **Hosts** → **Non-Docker host (alpha)** → daemon type **LXD**
2. Transport: **HTTPS (remote, client cert)**
3. Endpoint: `https://192.168.13.22:8443`
4. Client certificate: paste the content of `dd-lxd.crt`
5. Client key: paste the content of `dd-lxd.key`
6. Skip TLS verification: ☑ **checked** (LXD uses a self-signed cert by default)
7. Submit

## Verification checklist

- [ ] Sidebar → **Incus / LXD (alpha)** appears
- [ ] Info card shows server name + version (e.g. `LXD 5.21.1`)
- [ ] `test-container` from step 3 shows in the instances list with status **Running**
- [ ] IP address column shows the container's LXD-assigned IP
- [ ] Try Start/Stop actions from the row menu

## Troubleshooting

**"connect ECONNREFUSED /var/snap/lxd/common/lxd/unix.socket"**

Either:
- LXD isn't installed (rare on Ubuntu Server) — install with `sudo snap install lxd`
- Wrong socket path (legacy `/var/lib/lxd/unix.socket` if you have the deb package instead of snap)
- Socket wasn't mounted into docker-dash

**"HTTP 400: not authorized"**

Client cert not trusted. Re-run `lxc config trust add ./dd-lxd.crt` on the LXD host.

**"TLS handshake error"**

`skipTlsVerify` needs to be true (LXD's self-signed cert). Toggle it in the wizard or update the daemon_config directly.

## Next step

- Migrate a test VM from ESXi to Proxmox: [ESXi → Proxmox migration](../howto/esxi-to-proxmox-migration)
- Set up other daemon types: [Homelab setup checklist](../howto/homelab-setup-checklist)

## References

- [LXD documentation (Canonical)](https://documentation.ubuntu.com/lxd/)
- [Docker Dash LXD integration howto](../howto/lxd-integration)
