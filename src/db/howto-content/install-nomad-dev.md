---
slug: install-nomad-dev
title: Install Nomad dev agent (test lab for docker-dash)
title_ro: Instalare Nomad ca dev agent (laborator de test pentru docker-dash)
category: homelab-setup
difficulty: beginner
icon: fas fa-tasks
summary: Install HashiCorp Nomad as a single-node dev agent and register it in docker-dash.
summary_ro: Instaleaza HashiCorp Nomad ca dev agent cu un singur nod si inregistreaza-l in docker-dash.
---

## Why Nomad

Nomad is HashiCorp's workload orchestrator — Kubernetes-adjacent but MUCH simpler. One Go binary, no etcd, no separate control plane. Runs Docker containers, exec commands, Java apps, QEMU VMs, raw processes.

Popular in small shops that want scheduling without Kubernetes's surface area. A dev agent is one binary + one command — perfect for testing docker-dash's Sprint 10 integration.

## Requirements

- 1 VM: **1 GB RAM**, 1 vCPU, 10 GB disk
- Any modern Linux (Debian / Ubuntu / RHEL / Fedora)
- Docker installed (Nomad's default driver runs containers via Docker)

## Step 1 — Create the VM

Same procedure as k3s but smaller — a 1 GB Ubuntu VM is fine. Nested virtualization not needed unless you want the QEMU driver.

Static IP `192.168.13.25`.

## Step 2 — Install Nomad + Docker

```bash
ssh <user>@192.168.13.25

# Install Docker (for Nomad's docker driver)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Install Nomad
wget https://releases.hashicorp.com/nomad/1.9.0/nomad_1.9.0_linux_amd64.zip
unzip nomad_1.9.0_linux_amd64.zip
sudo install -m 755 nomad /usr/local/bin/nomad

# Verify
nomad version
# Nomad v1.9.0 ...
```

## Step 3 — Run Nomad as a dev agent

For a first test — just run in dev mode (no persistence, all-in-one server + client):

```bash
sudo nomad agent -dev -bind=0.0.0.0 -log-level=INFO
```

Leave this running in one terminal. Alternatively, as a systemd unit:

```bash
sudo tee /etc/nomad.d/nomad.hcl > /dev/null <<'EOF'
data_dir  = "/opt/nomad/data"
bind_addr = "0.0.0.0"

server {
  enabled          = true
  bootstrap_expect = 1
}

client {
  enabled = true
}
EOF

sudo mkdir -p /opt/nomad/data /etc/nomad.d
sudo tee /etc/systemd/system/nomad.service > /dev/null <<'EOF'
[Unit]
Description=Nomad
Documentation=https://developer.hashicorp.com/nomad
After=network-online.target

[Service]
User=root
Group=root
ExecStart=/usr/local/bin/nomad agent -config=/etc/nomad.d
KillMode=process
Restart=on-failure
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now nomad
sudo systemctl status nomad
```

Verify:
```bash
nomad node status
# ID        Node Pool  DC   Name    Class   Drain  Eligibility  Status
# xxx-xxx   default    dc1  ...     <none>  false  eligible     ready

nomad server members
# Name  Address           Port  Status  Leader  Protocol  Build  Datacenter  Region
# ...   192.168.13.25     4648  alive   true    2         1.9.0  dc1         global
```

## Step 4 — Deploy a test job

Create a simple Nomad job spec:

```bash
cat > redis.nomad.hcl <<'EOF'
job "redis-test" {
  datacenters = ["dc1"]

  group "cache" {
    count = 1

    network {
      port "db" {
        to = 6379
      }
    }

    task "redis" {
      driver = "docker"

      config {
        image = "redis:7-alpine"
        ports = ["db"]
      }

      resources {
        cpu    = 100
        memory = 128
      }
    }
  }
}
EOF

nomad job run redis.nomad.hcl
# → Job registration successful
```

Verify:
```bash
nomad job status
nomad alloc status <alloc-id>
```

## Step 5 — Register Nomad in docker-dash

Nomad dev agent has ACL disabled by default. Simplest possible registration:

- Sidebar → **Hosts** → **Non-Docker host (alpha)** → **Nomad**
- Name: `homelab-nomad`
- Endpoint: `http://192.168.13.25:4646` (**http**, not https, for dev)
- ACL token: leave empty
- CA certificate: leave empty
- Skip TLS verification: doesn't matter (http)
- Submit

Sidebar → **Nomad (alpha)** appears.

## Verification checklist

- [ ] Info card shows agent name + version 1.9.0 + region `global` + DC `dc1`
- [ ] Jobs tab lists `redis-test` with status `running` and 1 running task
- [ ] Allocations tab shows the redis allocation with `client status = running`
- [ ] Deployments tab shows the initial rollout (successful)
- [ ] Nodes tab shows the single client node

## Enable ACL (for a more realistic test)

Dev mode has ACL off. Prod-like:

```bash
# In /etc/nomad.d/nomad.hcl, add:
acl {
  enabled = true
}
```

Restart Nomad:
```bash
sudo systemctl restart nomad

# Bootstrap ACL:
nomad acl bootstrap
# → prints a management token (save it as NOMAD_TOKEN)

# Create a read-only policy for docker-dash:
export NOMAD_TOKEN=<management-token-from-bootstrap>

cat > dd-policy.hcl <<'EOF'
namespace "*" {
  policy = "read"
}
node {
  policy = "read"
}
agent {
  policy = "read"
}
EOF

nomad acl policy apply -description "docker-dash read-only" docker-dash-read dd-policy.hcl
nomad acl token create -name="docker-dash" -policy=docker-dash-read -type=client
# → prints Secret ID — paste into docker-dash wizard
```

Update the docker-dash host with the token (via SQL — the "edit host" UI for non-Docker hosts is on the roadmap).

## Troubleshooting

**"connect ECONNREFUSED 192.168.13.25:4646"**

Nomad not running. `sudo systemctl status nomad`. If in dev mode, the process must be kept in the foreground (or use `nohup`).

**"501 Not Implemented" on namespaces**

You're on OSS. Namespaces are Enterprise. The alpha handles this gracefully — nothing to do.

**"Nomad API error: Permission denied"**

ACL enabled but token missing/wrong permissions. Redo the policy from the ACL section.

## Next step

- Set up other daemon types: [Homelab setup checklist](../howto/homelab-setup-checklist)
- Deeper integration doc: [Nomad integration](../howto/nomad-integration)

## References

- [Nomad Learn tutorials](https://developer.hashicorp.com/nomad/tutorials)
- [Nomad agent config reference](https://developer.hashicorp.com/nomad/docs/configuration)
