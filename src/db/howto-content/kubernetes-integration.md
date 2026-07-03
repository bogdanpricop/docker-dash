---
slug: kubernetes-integration
title: Kubernetes integration (alpha)
title_ro: Integrare Kubernetes (alpha)
category: docker-dash
difficulty: intermediate
icon: fas fa-dharmachakra
summary: Register a Kubernetes cluster (k3s / k0s / MicroK8s / kubeadm) in Docker Dash and see its Deployments, Pods, Services, and Nodes.
summary_ro: Inregistreaza un cluster Kubernetes (k3s / k0s / MicroK8s / kubeadm) in Docker Dash si vizualizeaza Deployments, Pods, Services, Nodes.
---

## Positioning — what this is (and is not)

Docker Dash's Kubernetes support exists so a **Docker-first operator who also runs a small k3s at home** can see what's running there without opening Lens. It is **NOT** a Lens / Rancher / Portainer replacement.

Explicit non-goals:
- No YAML editor, no Helm chart install, no Ingress editing, no RBAC editor
- No `kubectl`-in-browser terminal (security nightmare in a web app; use `kubectl exec` locally)
- No Secret / ConfigMap viewer (accidental disclosure risk)
- No CRD viewer
- No cluster-wide event stream (Prometheus + Grafana own that)

If you need any of the above → use Lens or `kubectl`. That is the design, not a failure.

## What ships in this alpha

Read-only tabs:
- **Deployments** — namespace, name, image(s), ready/desired replicas, created-at
- **Pods** — namespace, name, phase, restart count, node, containers
- **Services** — namespace, name, type, cluster IP, external IPs, ports
- **Namespaces** — name, status, created-at
- **Nodes** — name, ready status, roles, kubelet version, OS, capacity

Info card at the top shows apiserver version + Go build.

Namespace filter dropdown at the top scopes Deployments/Pods/Services queries.

## Register a Kubernetes cluster

### 1. Create a ServiceAccount + token on the cluster

Docker Dash uses **bearer-token auth** — the same mechanism `kubectl` uses when it reads a token from a kubeconfig. Create a dedicated ServiceAccount with read-only cluster-wide permissions:

```yaml
# docker-dash-readonly.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: docker-dash-readonly
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: docker-dash-readonly
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: view          # built-in cluster role: list/get most resources; no secret access
subjects:
  - kind: ServiceAccount
    name: docker-dash-readonly
    namespace: kube-system
```

Apply it:
```bash
kubectl apply -f docker-dash-readonly.yaml
```

**Why `view` and not `admin`?** The alpha only lists resources. `view` is the least-privilege role that covers every read this alpha needs. When alpha.2 adds write ops (scale, rollout restart, pod delete), the howto will show you how to bind the appropriate roles per namespace.

### 2. Extract the token

For **k3s / k0s / MicroK8s / kubeadm ≥ 1.24** — you need to create a Secret manually (auto-token-creation was removed):

```yaml
# docker-dash-token.yaml
apiVersion: v1
kind: Secret
metadata:
  name: docker-dash-readonly-token
  namespace: kube-system
  annotations:
    kubernetes.io/service-account.name: docker-dash-readonly
type: kubernetes.io/service-account-token
```

```bash
kubectl apply -f docker-dash-token.yaml
kubectl -n kube-system get secret docker-dash-readonly-token -o jsonpath='{.data.token}' | base64 -d
```

Copy the output — that's your bearer token.

### 3. Get the CA cert (optional but recommended)

```bash
kubectl -n kube-system get secret docker-dash-readonly-token -o jsonpath='{.data.ca\.crt}' | base64 -d > k8s-ca.crt
```

Or, if the cluster uses a self-signed cert and you're OK with `skipTlsVerify` (testing only):

```bash
# In production this SHOULD stay false. Only flip during initial testing.
```

### 4. Register the host in Docker Dash

```bash
docker exec docker-dash node -e '
const { getDb } = require("/app/src/db");
const { encryptDaemonConfig } = require("/app/src/services/kubernetes");
const fs = require("fs");
const cfg = {
  endpoint: "https://k3s.example.com:6443",
  token: "eyJhbG...",                        // paste the base64-decoded token
  caCert: fs.readFileSync("/data/k8s-ca.crt", "utf8"),  // optional
  skipTlsVerify: false,
};
getDb().prepare(`INSERT INTO docker_hosts (name, connection_type, daemon_type, daemon_config)
  VALUES ("homelab-k3s", "tcp", "kubernetes", ?)`).run(encryptDaemonConfig(cfg));
console.log("Kubernetes host registered");
'
```

### 5. See it in the UI

- Sidebar → **Kubernetes (alpha)** appears when at least one `daemon_type='kubernetes'` host is registered
- The page fetches `/version` for the info card; namespaces populate the dropdown; each tab hits its list endpoint

## Common cluster distros — quick reference

| Distro | API endpoint | Notes |
|---|---|---|
| **k3s** | `https://<k3s-node>:6443` | Default. Token via ServiceAccount as above. |
| **k0s** | `https://<k0s-node>:6443` | Same as k3s. |
| **MicroK8s** | `https://<microk8s-node>:16443` | Different port. `microk8s.kubectl get sa …` to create the SA. |
| **kubeadm** | `https://<control-plane>:6443` | Full-stack; same instructions apply. |
| **Docker Desktop k8s** | `https://kubernetes.docker.internal:6443` | Local dev. Grab kubeconfig, extract token. |

## Security notes

- **Bearer token is encrypted at rest** via AES-256-GCM (`enc:` prefix on `daemon_config`) — same helper used for Incus / Proxmox / git credentials
- **`skipTlsVerify: false` is strongly recommended** — set the `caCert` from the cluster instead
- **Least-privilege by design** — use the built-in `view` ClusterRole for alpha.1's read-only routes. Rotate the token by re-generating the Secret and re-registering (or updating `daemon_config`)
- **No Secret viewing** in docker-dash. If someone gets access to the token they get the same view an operator with `view` role gets — no access to Secret contents (Kubernetes RBAC enforces that server-side even if the token has some scope)
- **Every read route requires `requireAuth`** (docker-dash session). No unauthenticated proxying to the apiserver

## Troubleshooting

**"Kubernetes API error: Unauthorized"**

Token expired or the ServiceAccount was deleted. Regenerate the Secret (step 2) and update `daemon_config.token` (via SQL or via the future "edit host" UI).

**"Kubernetes API error: Forbidden — cannot list resource"**

The ServiceAccount is missing the `view` ClusterRoleBinding, or the cluster uses a custom PSP/OPA policy blocking read access. Verify:
```bash
kubectl auth can-i list pods --as system:serviceaccount:kube-system:docker-dash-readonly
```

**"connect ECONNREFUSED" or timeout**

Wrong endpoint or port. `k3s` defaults to 6443; MicroK8s to 16443. Check with:
```bash
kubectl cluster-info | grep 'is running at'
```

**Certificate errors**

Either provide the correct `caCert` (from step 3), or set `skipTlsVerify: true` **temporarily** and never leave it that way in production.

## Alpha caveats

- Read-only. Write ops (scale Deployment, rollout restart, delete Pod, tail logs) land in alpha.2
- No pod log streaming
- No exec-into-pod (never coming — see positioning above)
- No YAML view for a resource (deferred; deep-spec calls it "view YAML" as an in-scope alpha.2 feature)
- Pagination not yet implemented — very large clusters (>500 pods in a single namespace) may exceed the 16 MB response cap

## References

- [Kubernetes API concepts](https://kubernetes.io/docs/reference/using-api/api-concepts/)
- [ServiceAccount tokens (post-1.24)](https://kubernetes.io/docs/concepts/security/service-accounts/#get-a-token)
- [Built-in cluster roles (`view`, `edit`, `admin`, `cluster-admin`)](https://kubernetes.io/docs/reference/access-authn-authz/rbac/#user-facing-roles)
- [Deep spec for this integration](../../plans/deep-spec-sprint-5-kubernetes.md)
