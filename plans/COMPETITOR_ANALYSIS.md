# Docker Dash — Competitor Analysis (March 2026)

Comprehensive research on Docker management UI/dashboard alternatives.
Focus: features Docker Dash could adopt to differentiate itself.

---

## Docker Dash Current Feature Set (for reference)

- Container management (start/stop/restart/remove/inspect/rename)
- Image management (pull/remove/inspect)
- Volume management
- Network management + topology view
- Stats collection (SQLite)
- Alerts system
- Webhooks
- Auth (bcrypt, sessions)
- Rate limiting
- Audit logging
- Multi-host support (migration exists)
- Container metadata/notes
- Registry management
- Email notifications
- i18n (EN + RO)
- WebSocket real-time updates

**Planned (not yet built):** Live log streaming, xterm.js terminal, dashboard live graphs, stacks/compose editor, container creation wizard, image build from Dockerfile, quick container actions.

**Tech stack:** Node.js + Express + vanilla JS frontend + SQLite + dockerode + WebSocket.

---

## 1. Yacht

| Field | Details |
|-------|---------|
| **URL** | https://github.com/SelfhostedPro/Yacht |
| **License** | MIT (Open Source) |
| **Stars** | ~3K (original repo); rewrite at Yacht-sh/Yacht has 47 stars |
| **Tech Stack** | Vue.js + Python (FastAPI in the rewrite) |
| **Active?** | Stale. Original repo "not updated in a while." Rewrite in progress (Yacht-sh/yacht-nuxt using Nuxt + TypeScript) but incomplete. Last commit on original: Dec 2024. |

**Key Differentiating Features:**
- **App templates system** — 1-click deployments from template URLs, compatible with Portainer templates. Acts like a "decentralized app store."
- **Template importing** — Users can share template repositories.
- **Docker Compose support** under "Projects" tab.
- Container label management (useful for Traefik).
- Device passthrough configuration (for hardware transcoding).

**What Docker Dash could adopt:**
- **App template system / marketplace** — A curated list of 1-click deploy templates. This is a killer feature for homelab users.
- **Portainer template compatibility** — Parse and use Portainer template JSON format.
- **Device passthrough UI** — Expose `--device` flag in container creation.

---

## 2. Dockge

| Field | Details |
|-------|---------|
| **URL** | https://github.com/louislam/dockge |
| **License** | MIT (Open Source) |
| **Stars** | **22.6K** |
| **Tech Stack** | TypeScript (50.8%) + Vue (42.5%) |
| **Active?** | Very active. Last commit: March 23, 2026. By the creator of Uptime Kuma. |

**Key Differentiating Features:**
- **Compose-file-centric** — Does not kidnap your compose files; they stay on disk as normal YAML.
- **Real-time progress** for pull/up/down operations with live terminal output.
- **Interactive compose editor** in the UI.
- **Docker run to Compose converter** — Paste a `docker run` command and get a compose YAML.
- **Multi-agent support** (v1.4.0+) — Manage stacks on multiple Docker hosts from one UI.
- Extremely clean, reactive UI.

**What Docker Dash could adopt:**
- **`docker run` to Compose converter** — Very popular feature; paste a run command and convert it.
- **Real-time pull/up/down progress** with terminal-style output (Docker Dash could show this via WebSocket).
- **Native compose file management** that does not abstract away the YAML.
- **Reactive/instant UI updates** — Dockge's UI feels snappy because of its socket.io approach.

---

## 3. Lazydocker

| Field | Details |
|-------|---------|
| **URL** | https://github.com/jesseduffield/lazydocker |
| **License** | MIT (Open Source) |
| **Stars** | **50.3K** (most popular Docker TUI) |
| **Tech Stack** | Go + gocui library |
| **Active?** | Active. 883 commits. By the creator of lazygit. |

**Key Differentiating Features:**
- **Terminal UI (TUI)** — No browser needed, runs entirely in terminal.
- **ASCII metric graphs** inline in the terminal.
- **Customizable metric graphs** — Measure nearly any Docker metric.
- **Keyboard-driven** — Everything via keybindings.
- **Exec into containers** from TUI.
- **10 language support.**
- **Bulk container operations.**

**What Docker Dash could adopt:**
- **Customizable metric graphs** — Let users pick which metrics to show on the dashboard.
- **Keyboard shortcuts** — Power-user keybindings for common actions (start/stop/restart/logs).
- **Inline container exec** integration (Docker Dash already plans xterm.js terminal).

---

## 4. DockStation

| Field | Details |
|-------|---------|
| **URL** | https://github.com/DockStation/dockstation |
| **License** | Free for personal use (not fully open source) |
| **Stars** | 2.2K |
| **Tech Stack** | Electron (desktop app) |
| **Active?** | **DEAD.** Archived Sep 30, 2025. Last release: v1.5.1 (April 2019). |

**Key Differentiating Features:**
- **Desktop GUI** (not web-based).
- **Project-based organization** — Group containers by project.
- **Local host binding** to projects.
- **Visual port mapping** and environment variable editor.
- **Generated clean docker-compose.yml** files usable outside the app.

**What Docker Dash could adopt:**
- **Project/group organization** — Let users group containers into logical projects.
- **Visual environment variable editor** with validation.
- **Export clean compose files** from container configurations.

---

## 5. Rancher

| Field | Details |
|-------|---------|
| **URL** | https://github.com/rancher/rancher |
| **License** | Apache 2.0 (Open Source) |
| **Stars** | **25.4K** |
| **Tech Stack** | Go (87.4%) |
| **Active?** | Very active. Latest release v2.13.3 (Feb 2026). Enterprise-backed by SUSE. |

**Key Differentiating Features:**
- **Multi-cluster Kubernetes management** — Way beyond Docker scope.
- **RBAC** — Role-based access control at scale.
- **Catalog/App marketplace.**
- **Hybrid/multi-cloud** support.
- **Rancher Desktop** — Local dev alternative with GUI, supports containerd or Moby.
- **Audit logging and encryption.**

**What Docker Dash could adopt:**
- **RBAC model** — Docker Dash has auth but could add roles (admin, operator, viewer).
- **Catalog/App marketplace** concept (simpler version, like Yacht templates).
- Not directly comparable (Rancher is Kubernetes-focused), but the RBAC and audit concepts are valuable.

---

## 6. Docker Desktop Dashboard

| Field | Details |
|-------|---------|
| **URL** | https://www.docker.com/products/docker-desktop/ |
| **License** | Free for personal/small business; paid for enterprise |
| **Stars** | N/A (proprietary) |
| **Tech Stack** | Electron + Go backend |
| **Active?** | Very active. Continuous releases. |

**Key Differentiating Features:**
- **Docker Scout** — Image vulnerability scanning built into the dashboard (CVE counts by severity).
- **Quick Search** across containers and compose apps.
- **Container inspect** in full JSON format.
- **Volume management** with orphan detection ("In use: No").
- **Model Runner** — Run AI models locally (2025 feature).
- **MCP Toolkit** — Secure agent integration.
- **Docker Offload** — Push builds to cloud GPUs.
- **Debug mode** — Enhanced container troubleshooting.
- **Agentic Compose** — AI-generated infrastructure.

**What Docker Dash could adopt:**
- **Vulnerability scanning display** — Integrate with Trivy/Grype to show CVE counts per image.
- **Quick Search / Command palette** — Global search across all resources (containers, images, volumes, networks).
- **Orphan volume detection** — Flag volumes not attached to any container.
- **JSON inspect view** — Full raw JSON inspect for any resource.

---

## 7. Cockpit (with Docker plugin)

| Field | Details |
|-------|---------|
| **URL** | https://github.com/chabad360/cockpit-docker |
| **License** | LGPL 2.1 (Cockpit itself) |
| **Stars** | ~105 (docker plugin) |
| **Tech Stack** | JavaScript (Cockpit plugin system) |
| **Active?** | Moderate. Updates through 2025-2026. Note: Cockpit officially favors Podman. |

**Key Differentiating Features:**
- **Part of a full server management suite** — Not Docker-only; includes system, storage, networking, users, services, terminal.
- **Modal interface for logs/details/terminal.**
- **System-level integration** — Manage Docker alongside OS services.

**What Docker Dash could adopt:**
- **Host system info** — Docker Dash shows some system info but could show more (disk usage, memory pressure, network interfaces, systemd services).
- **Integration mindset** — Position Docker Dash as part of a broader server management picture.

---

## 8. Nginx Proxy Manager

| Field | Details |
|-------|---------|
| **URL** | https://github.com/NginxProxyManager/nginx-proxy-manager |
| **License** | MIT (Open Source) |
| **Stars** | **32.2K** |
| **Tech Stack** | TypeScript (49.1%) + JavaScript (46.3%) |
| **Active?** | Active. v2.14.0 released Feb 17, 2026. |

**Key Differentiating Features:**
- **Reverse proxy management** with GUI — No Nginx config editing needed.
- **Automatic Let's Encrypt SSL** certificates.
- **Proxy host, redirection, stream, and 404 host management.**
- **Access lists and user management.**
- **Multi-user with view/manage permissions.**

**What Docker Dash could adopt:**
- **Built-in reverse proxy awareness** — Show which containers are behind a proxy, detect exposed ports that should be proxied.
- **SSL certificate status** display for containers that expose web services.
- **Port conflict detection** — Flag containers trying to bind the same port.

---

## 9. Watchtower

| Field | Details |
|-------|---------|
| **URL** | https://github.com/containrrr/watchtower |
| **License** | Apache 2.0 |
| **Stars** | **24.6K** |
| **Tech Stack** | Go |
| **Active?** | **DEAD.** Archived Dec 17, 2025. No longer maintained. |

**Key Differentiating Features:**
- **Automatic container image updates** — Polls registries, pulls new images, gracefully restarts containers with same options.
- **Notification system** — Email, Slack, MS Teams, Discord, etc.
- **Private registry support.**
- **Scheduling** — Cron-based update checks.
- **Label-based opt-in/opt-out** per container.

**What Docker Dash could adopt:**
- **AUTO-UPDATE FEATURE** — This is a huge gap. Docker Dash should have built-in auto-update checking. Since Watchtower is now dead, this is an opportunity.
- **Update notification** — Check if newer image tags exist and notify users.
- **Scheduled update checks** with cron.
- **Per-container update policy** — Auto-update, notify-only, or ignore.
- **Graceful restart with same options** on update.

---

## 10. Diun (Docker Image Update Notifier)

| Field | Details |
|-------|---------|
| **URL** | https://github.com/crazy-max/diun |
| **License** | MIT (Open Source) |
| **Stars** | **4.5K** |
| **Tech Stack** | Go (95.4%) |
| **Active?** | Active. 1,699 commits. Last update ~Oct 2025. |

**Key Differentiating Features:**
- **Image update notifications only** — Does not auto-update; just notifies.
- **Multi-provider** — Docker, Swarm, Static, Kubernetes.
- **Tag filtering** with regex — Include/exclude specific tags.
- **13+ notification channels** — Discord, Gotify, Mail, Matrix, MQTT, Pushover, Rocket.Chat, Script, Slack, Teams, Telegram, Webhook, Amqp.
- **Multi-platform** (Linux, macOS, Windows, ARM, PowerPC).

**What Docker Dash could adopt:**
- **Image update checking** — Periodically check if newer versions of images exist.
- **Tag regex filtering** — Let users specify which tags to watch (e.g., only stable releases, not RC/beta).
- **Multiple notification channels** — Docker Dash has email and webhooks; could add Slack, Discord, Telegram, Gotify.

---

## 11. Homepage

| Field | Details |
|-------|---------|
| **URL** | https://github.com/gethomepage/homepage |
| **License** | GPL-3.0 |
| **Stars** | **28.7K** |
| **Tech Stack** | Next.js / React |
| **Active?** | Very active through 2026. |

**Key Differentiating Features:**
- **Service dashboard** with 100+ integrations (Sonarr, Radarr, Plex, etc.).
- **Docker integration** via labels — Auto-discover services.
- **Widget system** — Weather, search, bookmarks, service-specific widgets.
- **Container status/stats** display.
- **Highly customizable** layout.
- **Automatic service discovery** via Docker labels.

**What Docker Dash could adopt:**
- **Widget/dashboard system** — Customizable dashboard with drag-and-drop widgets.
- **Service discovery via Docker labels** — Automatically detect what services containers are running.
- **Bookmarks/quick links** per container (link to the container's web UI).

---

## 12. Homarr

| Field | Details |
|-------|---------|
| **URL** | https://github.com/homarr-labs/homarr |
| **License** | MIT |
| **Stars** | ~3.2K (homarr-labs); original ajnart/homarr had more |
| **Tech Stack** | Next.js + TypeScript + tRPC |
| **Active?** | Active. V1.0 overhaul in progress (2025-2026). |

**Key Differentiating Features:**
- **Drag-and-drop dashboard** — No YAML configuration needed.
- **40+ integrations** built in.
- **10K+ icons** library built in.
- **Authentication out of the box.**
- **Docker container control** — Start, stop, restart, remove from dashboard.
- **Add apps from containers** — Select containers and add them as dashboard apps.
- **Search across containers.**

**What Docker Dash could adopt:**
- **Drag-and-drop dashboard customization.**
- **Built-in icon library** for services — Auto-detect service type and show appropriate icon.
- **"Add to dashboard" from container** — Pin important containers to a home view.

---

## 13. CasaOS

| Field | Details |
|-------|---------|
| **URL** | https://github.com/IceWhaleTech/CasaOS |
| **License** | Apache 2.0 |
| **Stars** | **33.5K** |
| **Tech Stack** | Go (90.3%) |
| **Active?** | Slowing down. Last commit: Dec 2024 (v0.4.15). |

**Key Differentiating Features:**
- **Full personal cloud OS** — Not just Docker management.
- **App Store** with 1-click install — 100,000+ Docker apps.
- **Beautiful widget-based dashboard** showing resource usage at a glance.
- **No code / no forms** design philosophy — Extremely intuitive.
- **File manager, media server integration.**
- **Hardware support** — ZimaBoard, NUC, RPi, old PCs.

**What Docker Dash could adopt:**
- **App store / marketplace** — Curated list of popular self-hosted apps with 1-click deploy.
- **Widget-based dashboard** with resource usage at a glance.
- **"No code" container deployment** — Simplified forms that hide Docker complexity.

---

## 14. Cosmos Cloud

| Field | Details |
|-------|---------|
| **URL** | https://github.com/azukaar/Cosmos-Server |
| **License** | Apache 2.0 with Commons Clause (no commercial resale) |
| **Stars** | **5.8K** |
| **Tech Stack** | JavaScript (57.1%) + Go (39.2%) |
| **Active?** | Active. v0.20.2 as of Feb 2026. |

**Key Differentiating Features:**
- **Built-in reverse proxy** — No separate Nginx/Traefik needed.
- **SmartShield** — Automatic security hardening (anti-DDoS, anti-bot).
- **VPN built in** — Access apps remotely without opening router ports.
- **Identity provider** — User management, invite friends/family.
- **Incremental encrypted backups** (Restic under the hood).
- **App marketplace** with auto-updates.
- **Real-time monitoring** with customizable alerts.
- **Storage manager** — Disk management, parity, MergerFS.
- **Docker Compose support.**
- **Security auditing** of containers.

**What Docker Dash could adopt:**
- **Container security auditing** — Check containers for security issues (privileged mode, host network, no resource limits, etc.).
- **Backup integration** — Backup container volumes.
- **Smart security defaults** — Warn when creating containers with risky configurations.
- **Built-in reverse proxy** or at least proxy-aware features.

---

## 15. Dozzle

| Field | Details |
|-------|---------|
| **URL** | https://github.com/amir20/dozzle |
| **License** | MIT (Open Source) |
| **Stars** | **12.1K** |
| **Tech Stack** | Go (56.6%) + Vue (29.3%) + TypeScript (12.9%) |
| **Active?** | Very active. v10.1.2 released March 17, 2026. 98 contributors. |

**Key Differentiating Features:**
- **Real-time log viewer** — Lightweight, 7 MB container.
- **SQL queries on logs** — Uses WebAssembly + DuckDB to query logs in-browser.
- **Multi-host support** — Connect to multiple Docker hosts.
- **Customizable alerts** — Monitor logs with expressions, notify via Slack, Discord, ntfy, webhooks.
- **Shell access** from browser — Attach or exec into containers.
- **Docker Swarm + K8s support.**
- **Permanent links to specific log timestamps.**
- **Log search and filtering.**

**What Docker Dash could adopt:**
- **SQL-based log querying** — This is a killer feature. Let users query logs with SQL syntax.
- **Log-based alerts** — Trigger alerts when specific patterns appear in logs.
- **Permanent log links** — Share a link to a specific log entry/timestamp.
- **Log search/filtering** UI with regex support.

---

## 16. ctop

| Field | Details |
|-------|---------|
| **URL** | https://github.com/bcicen/ctop |
| **License** | MIT |
| **Stars** | **17.7K** |
| **Tech Stack** | Go (97.1%) |
| **Active?** | **Stale.** Last commit: March 2022 (v0.7.7). |

**Key Differentiating Features:**
- **`top`-like interface** for containers — Familiar UX for Linux admins.
- **Real-time CPU, memory, network, I/O** per container.
- **Sortable columns** — Sort by any metric.
- **Single-container detailed view.**
- **Support for Docker and runC.**

**What Docker Dash could adopt:**
- **Sortable real-time metrics table** — CPU%, MEM%, NET I/O, DISK I/O per container, sortable.
- **Top-N resource consumers** highlight on dashboard.

---

## Summary: Top Features Docker Dash Should Adopt

### HIGH PRIORITY (Unique, high-demand, fills real gaps)

| Feature | Inspired By | Effort | Impact |
|---------|------------|--------|--------|
| **Auto-update checking + notifications** | Watchtower (dead) / Diun | Medium | Very High |
| **App template marketplace** (1-click deploy) | Yacht / CasaOS / Cosmos | Large | Very High |
| **`docker run` to Compose converter** | Dockge | Small | High |
| **SQL-based log querying** | Dozzle | Large | High |
| **Image vulnerability scanning display** | Docker Desktop (Trivy/Grype) | Medium | High |
| **Global search / command palette** | Docker Desktop / Homarr | Small | High |

### MEDIUM PRIORITY (Competitive differentiators)

| Feature | Inspired By | Effort | Impact |
|---------|------------|--------|--------|
| **Container security audit** (privileged, no limits, etc.) | Cosmos Cloud | Medium | Medium |
| **Log-based alerts** (pattern matching) | Dozzle | Medium | Medium |
| **RBAC** (admin/operator/viewer roles) | Rancher / Portainer | Medium | Medium |
| **Orphan volume detection** | Docker Desktop | Small | Medium |
| **Keyboard shortcuts** | Lazydocker | Small | Medium |
| **Per-container update policy** (auto/notify/ignore) | Watchtower / Diun | Medium | Medium |
| **Additional notification channels** (Slack, Discord, Telegram) | Diun / Dozzle | Medium | Medium |
| **Project/group organization** for containers | DockStation | Medium | Medium |

### LOWER PRIORITY (Nice-to-have polish)

| Feature | Inspired By | Effort | Impact |
|---------|------------|--------|--------|
| **Drag-and-drop widget dashboard** | Homarr / Homepage | Large | Medium |
| **Service icon auto-detection** | Homarr / Homepage | Small | Low |
| **Container bookmark/quick links** to web UIs | Homepage | Small | Low |
| **Docker label editor** | Yacht | Small | Low |
| **Device passthrough UI** | Yacht | Small | Low |
| **Port conflict detection** | NPM awareness | Small | Low |
| **Volume backup integration** | Cosmos Cloud | Large | Medium |
| **Built-in reverse proxy awareness** | Cosmos / NPM | Large | Low |

---

## Competitive Positioning

Docker Dash's **unique advantages** vs. the competition:
1. **Lightweight** — Single Node.js process + SQLite. No Java, no heavy Go binary, no Electron.
2. **Vanilla JS frontend** — No build step, fast to hack on, small bundle.
3. **Multi-host** support (planned).
4. **Email alerts + webhooks** already built in.
5. **Audit logging** already built in.
6. **i18n** already built in.

Docker Dash's **biggest gaps** vs. the competition:
1. No auto-update checking (Watchtower is dead — opportunity!)
2. No app templates / marketplace
3. No compose file management (Dockge dominates here)
4. No log querying (Dozzle dominates here)
5. No vulnerability scanning
6. No global search / command palette
7. Single user role (no RBAC)

---

## Sources

- [Yacht GitHub](https://github.com/SelfhostedPro/Yacht)
- [Dockge GitHub](https://github.com/louislam/dockge)
- [Lazydocker GitHub](https://github.com/jesseduffield/lazydocker)
- [DockStation GitHub](https://github.com/DockStation/dockstation)
- [Rancher GitHub](https://github.com/rancher/rancher)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- [Cockpit Docker Plugin](https://github.com/chabad360/cockpit-docker)
- [Nginx Proxy Manager GitHub](https://github.com/NginxProxyManager/nginx-proxy-manager)
- [Watchtower GitHub](https://github.com/containrrr/watchtower)
- [Diun GitHub](https://github.com/crazy-max/diun)
- [Homepage GitHub](https://github.com/gethomepage/homepage)
- [Homarr GitHub](https://github.com/homarr-labs/homarr)
- [CasaOS GitHub](https://github.com/IceWhaleTech/CasaOS)
- [Cosmos Cloud GitHub](https://github.com/azukaar/Cosmos-Server)
- [Dozzle GitHub](https://github.com/amir20/dozzle)
- [ctop GitHub](https://github.com/bcicen/ctop)
