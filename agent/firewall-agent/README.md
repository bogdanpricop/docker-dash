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

## Mutual TLS (recommended for non-loopback)

The bearer token alone is fine on `127.0.0.1`. If the agent is reachable over a
network, enable **mutual TLS** so both sides authenticate with certificates.

Generate a tiny private CA + a server cert (for the agent) + a client cert (for
docker-dash):

```bash
# CA
openssl genrsa -out ca.key 4096
openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 -subj "/CN=dd-fw-ca" -out ca.crt

# Agent server cert (CN/SAN = the host/IP docker-dash connects to)
openssl genrsa -out agent.key 2048
openssl req -new -key agent.key -subj "/CN=agent-host" -out agent.csr
printf "subjectAltName=IP:192.168.13.20" > san.ext   # adjust to your host/IP
openssl x509 -req -in agent.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 825 -sha256 -extfile san.ext -out agent.crt

# docker-dash client cert
openssl genrsa -out client.key 2048
openssl req -new -key client.key -subj "/CN=docker-dash" -out client.csr
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 825 -sha256 -out client.crt
```

On the agent host, install the server cert + CA and turn on TLS in the service:

```ini
Environment=FW_AGENT_TLS=1
Environment=FW_AGENT_TLS_CERT=/opt/firewall-agent/agent.crt
Environment=FW_AGENT_TLS_KEY=/opt/firewall-agent/agent.key
Environment=FW_AGENT_TLS_CA=/opt/firewall-agent/ca.crt
```

In docker-dash (Firewall page → Configure agent → Mutual TLS), set the URL to
`https://…`, keep the token, and paste **client.crt**, **client.key**, and
**ca.crt**. docker-dash then presents its client cert and verifies the agent's
server cert against the CA (`rejectUnauthorized: true`).

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
