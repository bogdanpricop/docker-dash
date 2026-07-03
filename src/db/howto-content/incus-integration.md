---
slug: incus-integration
title: Incus Integration (alpha)
title_ro: Integrare Incus (alpha)
category: docker-dash
difficulty: advanced
icon: fas fa-cubes
summary: Add an Incus (LXC + KVM) daemon as a host in Docker Dash. Alpha — read carefully before deploying.
summary_ro: Adaugă un daemon Incus (LXC + KVM) ca host în Docker Dash. Alpha — citește atent înainte de deploy.
---

## What is Incus

[Incus](https://github.com/lxc/incus) is a "system container and virtual machine manager". It's the community-driven fork of LXD (created after Canonical relicensed LXD under a restrictive CLA). It manages **LXC system containers** (containers that run systemd and sshd, look like tiny VMs) and **KVM virtual machines** through the same REST API.

Different audience from Docker: many self-hosters prefer Incus for services like Nextcloud, PostgreSQL, and mail servers because system containers feel more "server-like" than Docker containers.

## Alpha status

Docker Dash's Incus integration is currently in **alpha** (v8.9.0-alpha.x). What ships:

- IncusClient (thin HTTP wrapper over `http`/`https`)
- Backend routes: read (list instances, snapshots, images, projects) + write (start, stop, restart, freeze, unfreeze, delete instance; create/restore/delete snapshot)
- Frontend page: instance list with status, IPs, memory, CPU, and Start/Stop/Restart/Delete actions
- `daemon_type` migration on `docker_hosts` table (columns `daemon_type` + `daemon_config`)

What does NOT ship yet:

- WebSocket console (LXC `exec` streaming, VM noVNC/SPICE)
- Instance creation form (use `incus launch` from the CLI)
- Snapshot management UI (backend routes exist; UI in v8.9.0 proper)
- Profiles / networks / storage pools management
- Cluster-aware routing (multi-node Incus clusters expose one API but per-node placement)

Do not use in production yet. Test in a dev environment, report issues.

## Prerequisites

- Incus 6.x installed on the target host (Debian 12 / Ubuntu 24.04 / Fedora / Arch — see [distro packages](https://linuxcontainers.org/incus/getting-started/))
- Incus is initialized (`incus admin init`) and running
- Access to modify `docker-compose.yml` on the docker-dash host

## Setup (rootful, same-host)

The simplest case: docker-dash and Incus run on the same physical host. docker-dash needs to see Incus's Unix socket.

### 1. Bind-mount the Incus socket

Edit your `docker-compose.yml` and add the Incus socket to docker-dash's volumes:

```yaml
services:
  app:
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - docker-dash-data:/data
      # v8.9.0-alpha: bind-mount the Incus socket so the container can talk to it
      - /var/lib/incus/unix.socket:/var/lib/incus/unix.socket
```

The socket is owned by `root:incus-admin` on most distros. If docker-dash runs as non-root you'll need to either:

- Add the docker-dash UID to `incus-admin` group, or
- Bind-mount with permissive flags (not recommended), or
- Run docker-dash as root (the default in the shipped compose file)

Restart the stack:

```bash
docker compose up -d app
```

### 2. Register the host in Docker Dash

There is no UI to add non-Docker hosts yet (alpha limitation). Register the row manually. Log into the docker-dash container:

```bash
docker exec -it docker-dash sh
```

Then run this SQL against the SQLite DB:

```bash
sqlite3 /data/docker-dash.db <<'SQL'
INSERT INTO docker_hosts (name, connection_type, daemon_type, daemon_config, is_default, is_active)
VALUES (
  'Local Incus',
  'socket',
  'incus',
  '{"transport":"unix","socket":"/var/lib/incus/unix.socket"}',
  0,  -- not default
  1   -- active
);
SQL
```

### 3. Verify

From inside the container, hit the health endpoint:

```bash
docker exec docker-dash node -e '
const { getDb } = require("/app/src/db");
const { fromHostRow } = require("/app/src/services/incus");
const row = getDb().prepare("SELECT * FROM docker_hosts WHERE daemon_type = ?").get("incus");
if (!row) { console.error("no incus row"); process.exit(1); }
fromHostRow(row).info().then(i => console.log(JSON.stringify(i.metadata, null, 2)));
'
```

You should see the Incus server info (version, kernel, API extensions).

### 4. Use the UI

- Open Docker Dash
- Use the host selector (top of the sidebar) to switch to "Local Incus"
- Click **Incus (alpha)** in the sidebar
- Instances appear with status, IPs, memory, CPU; row actions work

## Setup (remote Incus via HTTPS)

If your Incus daemon is on a different machine and exposes the REST API on port 8443, use HTTPS + client cert auth.

### 1. Enable remote API

On the Incus host:

```bash
incus config set core.https_address :8443
```

### 2. Create a trust token in Incus

```bash
incus config trust add-certificate --projects default -- name=docker-dash
```

Follow the prompts to get a trust token. Then, on the docker-dash host, generate a client cert:

```bash
openssl req -x509 -newkey rsa:4096 -keyout /tmp/incus.key -out /tmp/incus.crt -sha384 -days 3650 -nodes \
  -subj "/CN=docker-dash"
```

### 3. Register the host

The `daemon_config` JSON needs the endpoint + PEM cert + key inline:

```json
{
  "transport": "https",
  "endpoint": "https://incus.example.com:8443",
  "cert": "-----BEGIN CERTIFICATE-----\nMIIF...\n-----END CERTIFICATE-----\n",
  "key": "-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n",
  "skipTlsVerify": false
}
```

Insert into the DB the same way as the local case. **Note**: the key is stored unencrypted in the SQL row in alpha; encryption-at-rest for Incus creds ships in the follow-up release.

## What works and what doesn't

| Feature | Status |
|---|---|
| List instances (containers + VMs) | Works |
| Instance detail | Works |
| Start / Stop / Restart | Works |
| Freeze / Unfreeze | API works; no UI button in alpha |
| Delete instance | Works |
| Snapshot list | Works (API) |
| Snapshot create / restore / delete | Works (API); no UI in alpha |
| Console (LXC exec) | Not implemented |
| Console (VM noVNC/SPICE) | Not implemented |
| Create instance form | Not implemented (use `incus launch` CLI) |
| Profiles CRUD | Not implemented |
| Storage pools | Not implemented |
| Networks | Not implemented |
| Cluster routing | Not implemented (works against a single node) |
| Credential encryption at rest | Not implemented (deferred) |

## Troubleshooting

**"Host X is not an Incus daemon" from the API**

Wrong host is selected. Use the host selector to switch to the Incus row.

**"ECONNREFUSED /var/lib/incus/unix.socket"**

The socket bind-mount is missing from `docker-compose.yml`, the path is wrong, or Incus isn't running on the host. Verify:

```bash
sudo ls -l /var/lib/incus/unix.socket
sudo curl --unix-socket /var/lib/incus/unix.socket http://localhost/1.0
```

Some Incus versions use `/run/incus/incus.socket` instead. Adjust the bind-mount accordingly.

**"Permission denied" on the socket**

docker-dash's UID needs to be in the `incus-admin` group, OR docker-dash needs to run as root (default), OR the socket needs group-write permission.

**Operations time out**

VM operations can take 30-60 s legitimately. The client waits up to 5 min. If you're seeing shorter timeouts, check network latency to the Incus API.

**Cluster shows only one node's instances**

Alpha doesn't do cluster-aware routing. Register each cluster member as a separate host row with different `daemon_config.endpoint` values.

## References

- [Incus documentation](https://linuxcontainers.org/incus/docs/main/)
- [Incus REST API reference](https://linuxcontainers.org/incus/docs/main/api/)
- [Docker Dash Incus deep-spec](../../plans/deep-spec-sprint-3-incus.md) (project-internal roadmap)
