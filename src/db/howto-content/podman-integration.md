---
slug: podman-integration
title: Podman Integration
title_ro: Integrare Podman
category: docker-dash
difficulty: intermediate
icon: fas fa-cube
summary: Run Docker Dash against a Podman socket instead of the Docker daemon.
summary_ro: Rulează Docker Dash împotriva unui socket Podman în loc de daemon Docker.
---

## Overview

Docker Dash speaks the Docker Engine REST API v1.40+. Podman exposes a Docker-compatible REST socket that implements the same protocol, so Docker Dash can manage Podman hosts with **no code changes** — you only redirect the mounted socket path.

The dashboard detects Podman automatically at runtime and:

- Shows a purple **PODMAN** badge on the Engine card
- Renames "Docker Engine" to **Podman** in the Info tab
- Hides Docker-only features that Podman doesn't implement (Swarm, plugins, BuildKit endpoints)

## Rootful Podman setup (recommended for headless servers)

Enable the Podman API socket via systemd:

```bash
sudo systemctl enable --now podman.socket
```

Verify the socket exists and is Docker-compatible:

```bash
sudo curl --unix-socket /run/podman/podman.sock http://localhost/_ping
# should print: OK
```

Point Docker Dash at the Podman socket by setting `DOCKER_SOCKET` in your `.env`:

```env
DOCKER_SOCKET=/run/podman/podman.sock
```

Restart:

```bash
docker compose up -d app
```

Open **System → Info** — the Engine card now reads **Podman** with the detected version.

## Rootless Podman (single-user desktop / development)

Rootless Podman runs the socket under the current user's XDG runtime directory:

```bash
systemctl --user enable --now podman.socket
ls -l "$XDG_RUNTIME_DIR/podman/podman.sock"
# example: /run/user/1000/podman/podman.sock
```

Rootless works but has these caveats:

- The socket is owned by the user, not `root`. You must run Docker Dash as the same UID or bind-mount with matching ownership.
- Rootless networking uses `slirp4netns` by default — port bindings work but per-container IP addresses differ from rootful.
- Some storage drivers behave differently under user namespaces.

For rootless setup, mount the user socket into the Docker Dash container:

```yaml
services:
  app:
    volumes:
      - ${XDG_RUNTIME_DIR}/podman/podman.sock:/var/run/docker.sock:ro
    user: "1000:1000"   # match your UID
```

## SELinux notes (Fedora / RHEL / CentOS Stream)

On SELinux-enforcing hosts, add the `:Z` flag to the bind mount so the socket gets a container-friendly context:

```yaml
    volumes:
      - /run/podman/podman.sock:/var/run/docker.sock:ro,Z
```

If Podman denies the connection with a permission error, check:

```bash
sudo ausearch -m avc -ts recent | grep podman
```

and consider setting the container-manage_cgroup boolean:

```bash
sudo setsebool -P container_manage_cgroup on
```

## What works and what doesn't

| Feature | Docker | Podman | Notes |
|---|---|---|---|
| Containers CRUD | Yes | Yes | Full parity |
| Images CRUD | Yes | Yes | Full parity |
| Networks | Yes | Yes | Podman uses CNI or Netavark |
| Volumes | Yes | Yes | Full parity |
| Compose | Yes | Yes | Podman ships `podman compose` and supports Docker compose plugin |
| Swarm mode | Yes | **No** | Hidden in UI on Podman hosts |
| Docker plugins | Yes | **No** | Hidden in UI on Podman hosts |
| BuildKit | Yes | **No (uses Buildah)** | Hidden in UI; use `podman build` from CLI |
| Docker events stream | Yes | Yes | Podman implements the events endpoint |
| Container stats | Yes | Yes | May differ slightly in field naming |
| Exec into container | Yes | Yes | Full parity |

## Multi-host: mixing Docker and Podman

Docker Dash detects the daemon type **per host**. You can have Host A running Docker and Host B running Podman in the same dashboard. The Engine card and menu items adjust per-host — no configuration needed beyond setting the correct socket path when you add each host.

## Troubleshooting

**"docker: Cannot connect to the Docker daemon" in the UI**

The socket path is wrong or the socket file has restrictive permissions.

- Rootful: check `sudo ls -l /run/podman/podman.sock` — should be `srw-rw----` root:root
- Rootless: check `ls -l "$XDG_RUNTIME_DIR/podman/podman.sock"` — should be user-owned
- SELinux: add `:Z` to the bind mount (see above)

**"Swarm not available" — but I'm on Docker!**

The daemon detection reported the host as Podman. Check `docker version` output:

```bash
docker version --format '{{json .Server.Components}}'
```

If the `Name` field of any component contains "Podman", detection worked correctly. If you're actually on Docker but the detection is wrong, please file an issue with the raw output.

**Podman API is much older than my Docker Dash**

Podman < 4.x has narrower Docker API compatibility. Recent Podman versions (4.x, 5.x) cover the endpoints Docker Dash needs. If you must run older Podman, some features may return 404 — this is upstream, not a Docker Dash bug.

## References

- Podman REST API documentation: https://docs.podman.io/en/latest/markdown/podman-system-service.1.html
- Podman REST API vs Docker API blog post: https://podman.io/blogs/2020/07/01/rest-versioning.html
- Podman socket activation tutorial: https://github.com/containers/podman/blob/main/docs/tutorials/socket_activation.md
