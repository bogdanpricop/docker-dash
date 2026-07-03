---
slug: install-podman-rhel
title: Install Podman on Rocky/Fedora/RHEL (test lab for docker-dash)
title_ro: Instalare Podman pe Rocky/Fedora/RHEL (laborator de test pentru docker-dash)
category: homelab-setup
difficulty: beginner
icon: fab fa-docker
summary: Install Podman with the Docker-compatible REST API and register it in docker-dash — appears as a Podman-badged host.
summary_ro: Instaleaza Podman cu API REST compatibil Docker si inregistreaza-l in docker-dash — apare cu badge Podman.
---

## Why Podman

Podman is Red Hat's rootless container runtime. Docker CLI-compatible, and — critically for docker-dash — its socket exposes the **same REST API as Docker**. Docker Dash detects it dynamically via `version.Components` inspection (no separate integration needed).

**No new daemon type.** Podman hosts use `daemon_type='docker'` (or leave it as default), and docker-dash auto-detects the Podman badge. Test this to verify Sprint 1 correctness.

## Requirements

- 1 VM: 1 GB RAM, 1 vCPU, 10 GB disk
- Rocky Linux 9 / Fedora 40+ / RHEL 9 / CentOS Stream 9

## Step 1 — Create the VM (on ESXi)

Same as k3s but pick **Red Hat Enterprise Linux 9 (64-bit)** as guest OS. Install with default profile. Static IP `192.168.13.26`.

## Step 2 — Install Podman

**Rocky / RHEL / CentOS Stream:**
```bash
ssh <user>@192.168.13.26
sudo dnf install -y podman podman-docker
```

**Fedora 40+:**
```bash
sudo dnf install -y podman
```

Verify:
```bash
podman version
# Client:       Podman Engine
# Version:      5.x.x
# ...
# Server:       Podman Engine
# Version:      5.x.x
```

## Step 3 — Enable the Podman socket

Podman ships with a systemd socket unit that exposes the Docker-compatible REST API. Two variants:

**Rootful (system-wide):**
```bash
sudo systemctl enable --now podman.socket
ls -la /run/podman/podman.sock
# srw-rw---- 1 root root 0 ... /run/podman/podman.sock
```

**Rootless (per-user, no sudo needed for containers):**
```bash
systemctl --user enable --now podman.socket
ls -la /run/user/$UID/podman/podman.sock
```

For docker-dash → the rootful socket is easier to expose over TCP (see step 4).

## Step 4 — Expose the socket over TCP (for a remote docker-dash)

Podman socket is a Unix domain socket by default. To reach it from docker-dash on another host, expose it over TCP with TLS.

**Option A: SSH tunnel (recommended for a test lab — simpler)**

Just add the host to docker-dash with connection type SSH and point at `/run/podman/podman.sock`.

**Option B: TCP with TLS**

Follow the [Podman remote socket guide](https://docs.podman.io/en/latest/markdown/podman-system-connection-add.1.html).

## Step 5 — Deploy a test container

```bash
podman run -d --name web -p 8080:80 nginx:alpine
curl http://192.168.13.26:8080
# → nginx welcome page
```

## Step 6 — Register Podman in docker-dash

**Via SSH (Option A):**
- Sidebar → **Hosts** → **Add host** (NOT the "Non-Docker host" button — Podman is `daemon_type='docker'` because the API is Docker-compatible)
- Name: `homelab-podman`
- Connection type: **SSH Tunnel**
- SSH host: `192.168.13.26`
- SSH port: 22
- SSH username: `<your-user>`
- SSH private key: paste the private key that authenticates against the VM
- Docker socket: `/run/podman/podman.sock`
- Submit

Docker Dash's SSH tunnel service will bring up the tunnel, then talk to the podman socket as if it were Docker's.

## Verification checklist

- [ ] Host card shows **"Podman"** badge (not "Docker Engine") — this is auto-detected via `version.Components`
- [ ] Containers page lists your `web` container
- [ ] `docker exec` / start / stop actions all work identically to Docker
- [ ] **Swarm** and **BuildKit** menu items are hidden (Podman doesn't support these) — this is done via the capability matrix

## Notes on Podman-specific behavior

- **No Swarm.** The Swarm tab won't appear.
- **No BuildKit.** Podman uses buildah under the hood; the BuildKit UI stays hidden.
- **Rootless containers.** Podman default is rootless (containers run as your user, not root). Some Docker Compose features that assume root won't work identically.
- **Pod support.** Podman has native "pod" (multi-container Kubernetes-style) support that Docker doesn't. Not surfaced in docker-dash yet; individual containers appear normally.

## Troubleshooting

**Podman connect fails with "permission denied"**

The socket file has strict permissions. For rootful:
```bash
sudo chmod 666 /run/podman/podman.sock  # test only, not for production
```

Better: use systemd drop-in to set `SocketMode=0660` and add your user to a socket group.

**"Podman badge doesn't show, appears as Docker Engine"**

Version inspection failed. Check the docker-dash log — should see the version response. Podman 4.4+ reliably reports `Components: [{Name: "Podman Engine", ...}]`.

## References

- [Podman documentation](https://docs.podman.io/)
- [Docker-compatible REST API in Podman](https://docs.podman.io/en/latest/markdown/podman-system-service.1.html)
