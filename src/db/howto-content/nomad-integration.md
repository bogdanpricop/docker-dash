---
slug: nomad-integration
title: Nomad integration (alpha)
title_ro: Integrare Nomad (alpha)
category: docker-dash
difficulty: intermediate
icon: fas fa-tasks
summary: Register a HashiCorp Nomad cluster and view its jobs, allocations, and nodes.
summary_ro: Inregistreaza un cluster HashiCorp Nomad si vizualizeaza jobs, allocations, nodes.
---

## Positioning

Nomad is HashiCorp's workload orchestrator — a simpler alternative to Kubernetes. Popular in homelabs and small shops that want scheduling (Docker + exec + java + qemu + raw_exec + wasm) without the k8s surface area.

Docker Dash's Nomad support is **read-only in this alpha**. Jobs list, allocations table, node list, active deployments. Job submit / stop / restart lands in alpha.2.

## Register a Nomad cluster

### 1. If ACL is enabled: create a read-only token

On the Nomad server:
```bash
nomad acl policy apply -description "docker-dash read-only" docker-dash-read - <<EOF
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

nomad acl token create -name="docker-dash" -policy=docker-dash-read -type=client
```

Copy the `Secret ID` from the output.

### 2. If ACL is disabled

No token needed. Skip step 1.

### 3. Register the host

```bash
docker exec docker-dash node -e '
const { getDb } = require("/app/src/db");
const { encryptDaemonConfig } = require("/app/src/services/nomad");
const fs = require("fs");
const cfg = {
  endpoint: "https://nomad.example.com:4646",
  token: "SECRET-ID-UUID",              // omit if ACL disabled
  caCert: fs.readFileSync("/data/nomad-ca.crt", "utf8"),   // omit if CA is trusted or ACL disabled
  skipTlsVerify: false,
};
getDb().prepare(`INSERT INTO docker_hosts (name, connection_type, daemon_type, daemon_config)
  VALUES ("prod-nomad", "tcp", "nomad", ?)`).run(encryptDaemonConfig(cfg));
console.log("Nomad host registered");
'
```

### 4. Verify

Sidebar → **Nomad (alpha)** appears. Info card shows agent name + version + region + datacenter.

## What ships in this alpha

| Tab | Rows | Notes |
|---|---|---|
| Jobs | Name, Type, Status, Running count, Priority, DCs | Type = service / batch / system / sysbatch |
| Allocations | ID (short), Job, Task group, Client status, Desired, Node | Capped at 500 rows for the alpha |
| Deployments | ID, Job, Status, Description | Active rollouts only |
| Nodes | Name, Status, Scheduling eligibility, Node class, DC, Version | Nomad workers |

Namespace filter dropdown at the top (Enterprise). OSS returns `[]` from `/v1/namespaces` — the dropdown stays "default".

## Security notes

- ACL token is encrypted at rest via AES-256-GCM (`enc:` prefix on `daemon_config`)
- Use a token with the **minimum policy** — `read` on `namespace`, `node`, `agent` covers this alpha's read paths
- `X-Nomad-Token` header carries the token — TLS is strongly recommended (`skipTlsVerify: false` + valid `caCert`)
- Every read route requires docker-dash `requireAuth` — no unauthenticated proxying

## Alpha caveats

- Read-only. Job submit / stop / restart / eval land in alpha.2
- No log tail (deferred; the `/v1/client/fs/logs/{allocID}` streaming endpoint has a different content-type contract)
- No exec-into-allocation (never coming — see Kubernetes positioning)
- Allocations table capped at 500 rows for a first-pass — larger clusters will need pagination in alpha.2
- End-to-end not verified against a live Nomad cluster in this session

## Troubleshooting

**"Nomad API error: Permission denied"**

ACL token missing the right policy. Verify:
```bash
nomad acl token info $NOMAD_TOKEN
nomad acl policy info docker-dash-read
```

**"connect ECONNREFUSED"**

Wrong port. Nomad default is 4646 (server + client agent both listen here). Check with:
```bash
curl -s http://<nomad-node>:4646/v1/status/leader
```

**"501 Not Implemented" on namespaces**

You're on OSS. Namespaces are Nomad Enterprise. The alpha handles this gracefully (empty list); no action needed.

## References

- [Nomad HTTP API reference](https://developer.hashicorp.com/nomad/api-docs)
- [ACL bootstrap + policies](https://developer.hashicorp.com/nomad/tutorials/access-control)
- [Nomad on ARM / homelabs](https://developer.hashicorp.com/nomad/tutorials/get-started)
