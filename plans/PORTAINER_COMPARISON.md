# Docker Dash vs Portainer CE — Detailed Feature Comparison

Last updated: 2026-03-23

Legend:
- [x] = We have it
- [ ] = We are missing it
- [~] = Partial / planned

---

## 1. Container Management

| Feature | Docker Dash | Portainer CE | Priority |
|---------|:-----------:|:------------:|----------|
| List all containers (running + stopped) | [x] | [x] | - |
| Start / Stop / Restart / Kill / Pause / Unpause | [x] | [x] | - |
| Inspect (full config view) | [x] | [x] | - |
| Logs with search + download | [x] | [x] | - |
| Live log streaming (WebSocket) | [x] | [x] | - |
| Container console (xterm.js exec) | [x] | [x] | - |
| Container attach (foreground process) | [ ] | [x] | Nice-to-have |
| One-shot stats (CPU/mem/net/IO) | [x] | [x] | - |
| Live stats with graphs (refresh rate) | [x] via WS broadcast | [x] with adjustable refresh | - |
| Create container (from image) | [x] | [x] | - |
| Container creation wizard (guided) | [x] plan 09 | [x] (form-based) | Essential |
| Duplicate / Clone container | [ ] | [x] | **Essential** |
| Edit container (recreate with changes) | [x] update/recreate | [x] edit = recreate | - |
| Rename container | [x] | [x] | - |
| Remove container (with force + volumes) | [x] | [x] | - |
| Bulk actions (multi-select) | [x] | [x] | - |
| Container resource limits update (live) | [x] | [x] | - |
| Export config as compose YAML | [x] | [ ] | **We have, they don't** |
| Export config as `docker run` command | [x] | [ ] | **We have, they don't** |
| Container environment variable editing | [ ] (view only) | [x] (via recreate) | Nice-to-have |
| Container labels management | [ ] (view only) | [x] (via recreate) | Nice-to-have |
| Container webhook (auto-redeploy trigger) | [ ] | [x] | Nice-to-have |
| Container metadata (app name, links, notes, custom fields) | [x] | [ ] | **We have, they don't** |
| Self-protection (prevent self-destruction) | [x] | [x] | - |
| Health check status + logs | [x] | [x] | - |

### Assessment — Container Management

**Essential gaps:**
- **Duplicate/Clone container** — Portainer's "Duplicate/Edit" is one of its most-used features. It inspects a container and pre-fills a creation form so users can clone it with modifications. We have the recreate logic but no "clone as new" flow.

**Already superior to Portainer:**
- Config export (compose YAML + docker run) is something Portainer lacks entirely
- Container metadata (app name, description, links, owner, custom fields) is unique to Docker Dash
- Vulnerability scanning (Trivy/Scout integration) is not available in Portainer CE

---

## 2. Image Management

| Feature | Docker Dash | Portainer CE | Priority |
|---------|:-----------:|:------------:|----------|
| List images with sizes | [x] | [x] | - |
| Inspect image (full manifest) | [x] | [x] | - |
| Image history (layers) | [x] | [x] | - |
| Pull image from registry | [x] | [x] | - |
| Remove image | [x] | [x] | - |
| Image build from Dockerfile (web editor) | [x] plan 14 | [x] | - |
| Image tagging | [ ] | [x] | **Essential** |
| Image import from tar (.tar/.tar.gz/.tar.bz2/.tar.xz) | [ ] | [x] | **Essential** |
| Image export to tar | [ ] | [x] | **Essential** |
| Image layer inspection (detailed sizes) | [x] via history | [x] | - |
| Image config extraction (ports, env, cmd, volumes) | [x] | [x] | - |
| Vulnerability scanning (Trivy / Docker Scout) | [x] | [ ] | **We have, they don't** |
| Scanner auto-detection | [x] | [ ] | **We have, they don't** |

### Assessment — Image Management

**Essential gaps:**
- **Image tagging** — ability to add/change tags on local images (Docker `tag` command via API)
- **Image import/export** — Portainer supports uploading .tar files and downloading images as .tar. This is important for air-gapped environments and image transfers.

**Already superior to Portainer:**
- Vulnerability scanning with Trivy/Docker Scout is a major differentiator

---

## 3. Volume Management

| Feature | Docker Dash | Portainer CE | Priority |
|---------|:-----------:|:------------:|----------|
| List volumes with sizes | [x] via docker.df() | [x] | - |
| Inspect volume | [x] | [x] | - |
| Remove volume | [x] | [x] | - |
| Create volume | [ ] | [x] | **Essential** |
| Create volume with driver options | [ ] | [x] | Essential |
| Volume browsing (file explorer) | [ ] | [x] (requires agent) | Nice-to-have |
| Upload files to volume | [ ] | [x] (requires agent) | Nice-to-have |
| Download files from volume | [ ] | [x] (requires agent) | Nice-to-have |

### Assessment — Volume Management

**Essential gaps:**
- **Create volume** — We can list, inspect, and remove but cannot create volumes. This is a basic CRUD gap.
- **Create with driver options** — NFS, CIFS, and other driver-specific options are important for production.

**Nice-to-have:**
- Volume browsing requires the Portainer Agent (a sidecar container). It is useful but not critical. Could be implemented by exec-ing into a temporary busybox container mounted to the volume.

---

## 4. Network Management

| Feature | Docker Dash | Portainer CE | Priority |
|---------|:-----------:|:------------:|----------|
| List networks with details | [x] | [x] | - |
| Inspect network (containers, IPAM) | [x] | [x] | - |
| Create network | [x] | [x] | - |
| Remove network | [x] | [x] | - |
| Network IPAM configuration (subnet/gateway) | [~] (passed through) | [x] (form-based) | Nice-to-have |
| Connect container to network | [ ] | [x] | **Essential** |
| Disconnect container from network | [ ] | [x] | **Essential** |
| Macvlan / IPvlan configuration | [ ] | [x] | Nice-to-have |
| Network topology visualization | [x] | [ ] | **We have, they don't** |

### Assessment — Network Management

**Essential gaps:**
- **Connect/disconnect containers** — This is a very common operation. Portainer has a UI for attaching/detaching containers from networks with optional IP address assignment. We need `POST /networks/:id/connect` and `POST /networks/:id/disconnect` endpoints.

**Already superior to Portainer:**
- Network topology visualization (nodes + links graph) is unique to Docker Dash

---

## 5. Stacks / Compose

| Feature | Docker Dash | Portainer CE | Priority |
|---------|:-----------:|:------------:|----------|
| List stacks (from container labels) | [x] | [x] | - |
| Stack detail view (containers + config) | [x] | [x] | - |
| Stack actions (up/down/restart/pull) | [x] | [x] | - |
| View/edit compose file | [x] | [x] | - |
| Deploy after edit | [x] | [x] | - |
| Create stack from web editor (from scratch) | [ ] | [x] | **Essential** |
| Create stack from Git repository | [ ] | [x] | Nice-to-have |
| Create stack from custom template | [ ] | [x] | Nice-to-have |
| Stack environment variables (.env) | [ ] | [x] | **Essential** |
| .env file upload for stack | [ ] | [x] | Nice-to-have |
| Stack auto-update from Git | [ ] | [x] (BE only) | N/A (paid) |
| Compose file backup on edit | [x] (.bak) | [ ] | **We have, they don't** |

### Assessment — Stacks / Compose

**Essential gaps:**
- **Create stack from scratch** — Users need to deploy a new compose stack from the UI using a web editor. Currently we can only manage *existing* stacks discovered from container labels.
- **Stack environment variables** — Portainer lets you define env vars that are substituted into the compose file at deploy time, and can load them from a .env file. This is critical for real-world compose deployments.

**Nice-to-have:**
- Git repository integration is powerful but complex. Good for Phase 2.
- Custom stack templates could reuse our existing app templates system.

---

## 6. System / Docker Engine

| Feature | Docker Dash | Portainer CE | Priority |
|---------|:-----------:|:------------:|----------|
| Docker info (version, OS, CPU, memory) | [x] | [x] | - |
| Disk usage (df) | [x] | [x] | - |
| Docker events stream | [x] (WS + DB) | [x] | - |
| System prune (containers/images/volumes/networks) | [x] | [x] | - |
| Engine detailed view (storage driver, plugins, etc.) | [~] basic | [x] detailed | Nice-to-have |
| Docker Swarm management (services) | [ ] | [x] | Not critical* |
| Swarm tasks/replicas | [ ] | [x] | Not critical* |
| Swarm secrets | [ ] | [x] | Not critical* |
| Swarm configs | [ ] | [x] | Not critical* |
| Swarm node management | [ ] | [x] | Not critical* |
| Update checks (Docker + OS + App) | [x] | [ ] | **We have, they don't** |
| Firewall management (UFW) | [x] | [ ] | **We have, they don't** |
| Container scheduling (cron) | [x] | [ ] | **We have, they don't** |
| Database management (cleanup/vacuum) | [x] | [ ] | **We have, they don't** |
| Backup/restore configuration | [x] | [ ] | **We have, they don't** |
| Health overview (all containers) | [x] | [~] basic | **We have, they don't** |

*Swarm note: Docker Swarm is declining in adoption vs Kubernetes. Unless your target users rely on Swarm, this is low priority. Portainer CE supports Swarm because it was their original focus.

### Assessment — System

Docker Dash has several unique system features that Portainer CE lacks entirely: update checks, firewall management, cron scheduling, database maintenance, and backup/restore. These are significant differentiators.

---

## 7. UI/UX Features

| Feature | Docker Dash | Portainer CE | Priority |
|---------|:-----------:|:------------:|----------|
| Dashboard with overview stats | [x] | [x] | - |
| Live dashboard graphs (CPU/mem) | [x] plan 07 | [x] | - |
| i18n (English + Romanian) | [x] | [x] (multi-lang) | - |
| Dark mode | ? | [ ] | **We have (if yes)** |
| Global search across resources | [ ] | [x] | Nice-to-have |
| Responsive mobile design | [x] (in plan) | [~] basic | - |
| Container templates (quick deploy) | [x] 12 templates | [x] 90+ templates | Expand |
| Custom user templates | [ ] | [x] | Nice-to-have |
| App template repository | [ ] | [x] (JSON URL) | Nice-to-have |
| Multi-host / multi-environment | [~] (code ready, flag off) | [x] full | Nice-to-have |
| Edge agent (remote management) | [ ] | [x] | Not critical |
| Audit log | [x] | [x] (BE only) | **We have, they don't (free)** |
| Webhook management | [x] | [x] (container-level) | - |
| Alert rules + notifications | [x] | [ ] | **We have, they don't** |
| Email notifications | [x] | [ ] (CE) | **We have, they don't** |
| Rate limiting + brute-force protection | [x] | [x] | - |

### Assessment — UI/UX

Docker Dash's audit log, alerting system, and webhook management are features that Portainer locks behind its Business Edition paywall. Having these in the free product is a significant advantage.

---

## 8. Access Control

| Feature | Docker Dash | Portainer CE | Priority |
|---------|:-----------:|:------------:|----------|
| User management (CRUD) | [x] | [x] | - |
| Roles (admin/operator/viewer) | [x] 3 roles | [x] 2 roles (admin/user) | **We have more** |
| Password reset (admin + email) | [x] | [x] | - |
| User invitation via email | [x] | [ ] (CE) | **We have, they don't** |
| Account lockout on failed attempts | [x] | [x] | - |
| Team management | [ ] | [x] basic | Nice-to-have |
| Resource ownership per user/team | [ ] | [x] basic | Nice-to-have |
| Per-resource access control | [ ] | [x] basic | Nice-to-have |
| Full RBAC | [ ] | [ ] (BE only) | N/A (paid) |
| Feature flags (enable/disable features) | [x] | [ ] | **We have, they don't** |
| Read-only mode | [x] | [ ] | **We have, they don't** |
| Session management (cookie + TTL) | [x] | [x] | - |
| LDAP/OAuth integration | [ ] | [ ] (BE only) | N/A (paid) |

### Assessment — Access Control

Docker Dash has a 3-role system (admin/operator/viewer) vs Portainer CE's 2-role system. We also have feature flags, read-only mode, and email invitations. Portainer CE has basic team management and per-resource ownership that we lack, but full RBAC is BE-only.

---

## 9. Registry Management

| Feature | Docker Dash | Portainer CE | Priority |
|---------|:-----------:|:------------:|----------|
| Add/edit/remove registries | [x] | [x] | - |
| Registry connection test | [x] | [x] | - |
| Browse registry catalog | [x] | [x] | - |
| Browse image tags | [x] | [x] | - |
| Encrypted credential storage | [x] | [x] | - |
| Pull from private registry | [~] | [x] | Essential |

---

## Summary: Priority Action Items

### A) Essential for Parity (should implement)

1. **Container Duplicate/Clone** — Pre-fill creation form from existing container config
2. **Image Tagging** — `docker.getImage(id).tag({repo, tag})`
3. **Image Import/Export** — Upload .tar, download .tar
4. **Volume Creation** — `docker.createVolume({Name, Driver, DriverOpts})`
5. **Network Connect/Disconnect** — `network.connect({Container})` / `network.disconnect({Container})`
6. **Stack Creation from Scratch** — Web editor to write a compose file and deploy to a new directory
7. **Stack Environment Variables** — .env variable management per stack

### B) Nice-to-Have (Phase 2)

1. Container attach (vs exec) — connect to foreground PID 1
2. Volume browsing / file explorer (via agent or temporary container)
3. Global search across all resources
4. Team management + resource ownership
5. Stack from Git repository
6. Custom user templates / template repository
7. Macvlan / IPvlan network configuration UI
8. More container templates (Portainer ships ~90+)
9. Container webhooks (auto-redeploy on push)
10. Multi-host management (code exists, needs UI)

### C) Things We Have That Portainer CE Does NOT

1. **Vulnerability scanning** (Trivy + Docker Scout integration)
2. **Container config export** (compose YAML + docker run command)
3. **Container metadata** (app name, description, links, owner, notes, custom fields)
4. **Alert rules + notifications** (threshold-based with email)
5. **Audit log** (free — Portainer charges for this in BE)
6. **Container scheduling** (cron-based start/stop/restart)
7. **Firewall management** (UFW integration)
8. **Update checks** (Docker engine + OS packages + app version)
9. **Database maintenance** (cleanup + vacuum)
10. **Backup/restore** (settings, alert rules, schedules)
11. **Network topology visualization**
12. **3-role access system** (admin/operator/viewer vs admin/user)
13. **Feature flags** (per-feature enable/disable)
14. **Read-only mode**
15. **Email invitations** for new users
16. **Health overview** (all containers health status + restart counts)

---

## Estimated Effort for Essential Items

| Feature | Backend | Frontend | Total |
|---------|---------|----------|-------|
| Container Duplicate/Clone | Small (reuse inspect) | Medium (pre-fill form) | 1 day |
| Image Tagging | Small (1 endpoint) | Small (dialog) | 0.5 day |
| Image Import/Export | Medium (stream handling) | Small (upload/download) | 1 day |
| Volume Creation | Small (1 endpoint) | Small (form) | 0.5 day |
| Network Connect/Disconnect | Small (2 endpoints) | Medium (UI in detail) | 1 day |
| Stack Creation from Scratch | Medium (dir management) | Medium (editor + form) | 2 days |
| Stack Environment Variables | Medium (env parsing) | Medium (.env editor) | 1 day |
| **Total** | | | **~7 days** |

---

## Sources

- [Portainer CE Features](https://www.portainer.io/features)
- [Portainer CE vs BE](https://www.portainer.io/blog/portainer-community-edition-ce-vs-portainer-business-edition-be-whats-the-difference)
- [Portainer Container Console](https://docs.portainer.io/user/docker/containers/console)
- [Portainer Duplicate/Edit Container](https://docs.portainer.io/user/docker/containers/edit)
- [Portainer Container Stats](https://docs.portainer.io/user/docker/containers/stats)
- [Portainer Image Import](https://docs.portainer.io/user/docker/images/import)
- [Portainer Image Export](https://docs.portainer.io/user/docker/images/export)
- [Portainer Volume Browse](https://docs.portainer.io/user/docker/volumes/browse)
- [Portainer Add Network](https://docs.portainer.io/user/docker/networks/add)
- [Portainer Add Stack](https://docs.portainer.io/user/docker/stacks/add)
- [Portainer Secrets](https://docs.portainer.io/user/docker/secrets)
- [Portainer Configs](https://docs.portainer.io/user/docker/configs)
- [Portainer Access Control](https://docs.portainer.io/advanced/access-control)
- [Portainer Roles](https://docs.portainer.io/admin/user/roles)
