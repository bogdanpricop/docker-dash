# docker-dash firewall-agent

A tiny, dependency-free (Node stdlib only) local service that performs
**whitelisted** firewall operations on the host it runs on, so docker-dash never
needs host privileges. Use it for the machine docker-dash itself runs on, or for
any host where you don't want docker-dash to have SSH-as-root.

It reuses the **exact same** validation + backend builders as the dashboard — the
files under `lib/` are verbatim copies of `src/services/firewall/*`. There is **no
raw-command endpoint**; only `/detect`, `/list`, `/snapshot`, `/apply`, `/remove`
with strictly-validated rule specs.

## Install

```bash
sudo mkdir -p /opt/firewall-agent
sudo cp -r agent/firewall-agent/agent.js agent/firewall-agent/lib /opt/firewall-agent/

# Generate a long shared secret and put it in BOTH the agent and docker-dash:
TOKEN=$(openssl rand -hex 32); echo "$TOKEN"

sudo cp agent/firewall-agent/firewall-agent.service /etc/systemd/system/
sudo sed -i "s/CHANGE_ME_TO_A_LONG_RANDOM_SECRET/$TOKEN/" /etc/systemd/system/firewall-agent.service
sudo systemctl daemon-reload
sudo systemctl enable --now firewall-agent
sudo systemctl status firewall-agent
```

Requires `node` on the host (`apt install nodejs` / `dnf install nodejs`).

## Least-privilege (recommended)

Instead of `User=root`, run as a dedicated user and allow only the firewall
binaries via sudo:

```bash
sudo useradd --system --no-create-home firewall-agent
sudo tee /etc/sudoers.d/firewall-agent >/dev/null <<'EOF'
firewall-agent ALL=(root) NOPASSWD: /usr/sbin/iptables, /usr/sbin/iptables-save, /usr/sbin/iptables-restore, /usr/bin/firewall-cmd, /usr/sbin/ufw
EOF
```

Then in the service file set `User=firewall-agent` and
`Environment=FW_AGENT_SUDO=1`.

## Register in docker-dash

In docker-dash, edit the host and store the agent endpoint + token (see the
Firewall page → "Configure agent"). Internally this is saved encrypted in the
host's `daemon_config.firewallAgent = { url, token }`. When present, docker-dash
routes firewall operations for that host through the agent instead of SSH.

If docker-dash runs in a container and the agent runs on the host, use
`http://host.docker.internal:9090` (add `extra_hosts: ["host.docker.internal:host-gateway"]`
to the compose service on Linux).

## Endpoints (all POST, `Authorization: Bearer <token>`)

- `/detect`   → `{ backend }`
- `/list`     → `{ backend, raw }`
- `/snapshot` → `{ backend, content }`
- `/apply`    body `{ spec, uuid, reason }` → `{ ok, backend, built }`
- `/remove`   body `{ rule }` → `{ ok }`

`spec` = `{ action: allow|block, scope: host|docker|container, source_ip?,
destination_port?, protocol? }` — validated exactly as in the dashboard.

## Keeping `lib/` in sync

`lib/validate.js` and `lib/backends/*` are copies of `src/services/firewall/`.
If you change those in the repo, re-copy them here (they are pure, zero-dep
modules). MVP1 keeps them as copies to make the agent a self-contained deployable
with no build step.
