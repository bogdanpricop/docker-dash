---
slug: install-k3s-single-node
title: Install k3s single-node (test lab for docker-dash)
title_ro: Instalare k3s cu un singur nod (laborator de test pentru docker-dash)
category: homelab-setup
difficulty: beginner
icon: fas fa-dharmachakra
summary: Install k3s (Rancher Labs' lightweight Kubernetes) on a small VM and register it in docker-dash.
summary_ro: Instaleaza k3s (Kubernetes lightweight de la Rancher Labs) pe un VM mic si inregistreaza-l in docker-dash.
---

## Why k3s (and not full Kubernetes)?

k3s is Kubernetes packed into a single ~50 MB binary. Same API, same objects, no separate `etcd` / kubelet / kube-apiserver processes to run.

**Perfect for docker-dash testing** — one command install, uses `sqlite` instead of etcd, boots in seconds, uses ~500 MB RAM. Feature parity with upstream k8s for everything docker-dash's Sprint 5 exposes.

## Requirements

- 1 VM: **2 GB RAM**, 2 vCPU, 15 GB disk
- Ubuntu / Debian / Fedora — any modern Linux
- Static IP in your LAN

## Step 1 — Create the VM (on ESXi)

Same procedure as [LXD](../howto/install-lxd-ubuntu):
- Guest OS: Ubuntu (or Debian)
- 2 vCPU, 2 GB RAM, 15 GB disk
- Nested virtualization: **not needed** — k3s uses containerd, no VMs

Install Ubuntu Server 24.04 with SSH enabled, static IP `192.168.13.24`.

## Step 2 — Install k3s

```bash
ssh <user>@192.168.13.24
curl -sfL https://get.k3s.io | sh -
```

That's it. The installer:
- Fetches the k3s binary
- Sets up systemd unit `k3s.service` and starts it
- Writes kubeconfig to `/etc/rancher/k3s/k3s.yaml`
- Deploys default components: coredns, traefik ingress, metrics-server, local-path storage class

Verify:
```bash
sudo systemctl status k3s
sudo k3s kubectl get nodes
# NAME                STATUS   ROLES                  AGE   VERSION
# 192-168-13-24     Ready    control-plane,master   30s   v1.31.x+k3s1
```

Copy the kubeconfig somewhere you can use it:
```bash
sudo cp /etc/rancher/k3s/k3s.yaml ~/kubeconfig
sudo chown $USER ~/kubeconfig
```

## Step 3 — Create the docker-dash ServiceAccount

Create the least-privilege ServiceAccount + token:

```bash
cat <<EOF | sudo k3s kubectl apply -f -
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
  name: view
subjects:
  - kind: ServiceAccount
    name: docker-dash-readonly
    namespace: kube-system
---
apiVersion: v1
kind: Secret
metadata:
  name: docker-dash-readonly-token
  namespace: kube-system
  annotations:
    kubernetes.io/service-account.name: docker-dash-readonly
type: kubernetes.io/service-account-token
EOF

# Extract the token
sudo k3s kubectl -n kube-system get secret docker-dash-readonly-token \
  -o jsonpath='{.data.token}' | base64 -d
echo
# → eyJhbG... (long JWT)

# Extract the CA cert
sudo k3s kubectl -n kube-system get secret docker-dash-readonly-token \
  -o jsonpath='{.data.ca\.crt}' | base64 -d
# → -----BEGIN CERTIFICATE----- ...
```

Copy both — you'll paste them into the docker-dash wizard.

## Step 4 — Deploy a test workload

So you have something to look at in docker-dash:

```bash
sudo k3s kubectl create deployment nginx --image=nginx:alpine --replicas=2
sudo k3s kubectl expose deployment nginx --port=80 --type=ClusterIP
sudo k3s kubectl get pods
# NAME                     READY   STATUS    RESTARTS   AGE
# nginx-xxxx-xxxx          1/1     Running   0          15s
# nginx-xxxx-yyyy          1/1     Running   0          15s
```

## Step 5 — Register k3s in docker-dash

- Sidebar → **Hosts** → **Non-Docker host (alpha)** → **Kubernetes**
- Name: `homelab-k3s`
- API server endpoint: `https://192.168.13.24:6443`
- Bearer token: paste the JWT from step 3
- CA certificate: paste the PEM from step 3 (optional but recommended)
- Skip TLS verification: leave ☐ **unchecked** (you provided the CA)
- Submit

Sidebar → **Kubernetes (alpha)** appears. Click it. Info card shows the cluster version.

## Verification checklist

- [ ] Deployments tab shows `nginx` with 2/2 ready
- [ ] Pods tab shows both nginx pods with phase `Running`
- [ ] Services tab shows `nginx` service (ClusterIP)
- [ ] Namespaces tab shows `default`, `kube-system`, `kube-public`, `kube-node-lease`
- [ ] Nodes tab shows the single control-plane node

## Multi-node lab (optional)

Add a worker:
```bash
# On the k3s server:
sudo cat /var/lib/rancher/k3s/server/node-token
# → K10...long string

# On the new worker VM:
curl -sfL https://get.k3s.io | K3S_URL=https://192.168.13.24:6443 \
  K3S_TOKEN=K10...paste-here sh -
```

Refresh docker-dash → **Nodes** tab now shows two.

## Troubleshooting

**"Kubernetes API error: Unauthorized"**

Token expired or wrong. Re-extract with `kubectl -n kube-system get secret ... -o jsonpath='{.data.token}' | base64 -d`.

**"connect ECONNREFUSED 192.168.13.24:6443"**

k3s not running. `sudo systemctl status k3s` → `sudo systemctl restart k3s`.

**"Forbidden: cannot list namespaces"**

ClusterRoleBinding missing. Re-apply the YAML from step 3.

## Cleanup

Uninstall k3s:
```bash
/usr/local/bin/k3s-uninstall.sh
```

## Next step

- Set up other daemon types: [Homelab setup checklist](../howto/homelab-setup-checklist)
- Deeper integration doc: [Kubernetes integration](../howto/kubernetes-integration)

## References

- [k3s documentation](https://docs.k3s.io/)
- [k3s quick start](https://docs.k3s.io/quick-start)
