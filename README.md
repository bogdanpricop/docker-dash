<p align="center">
  <h1 align="center">🐳 Docker Dash</h1>
  <p align="center">
    A full-featured Docker management dashboard that runs in two modes:<br>
    <strong>Standalone</strong> for homelab and small teams · <strong>HA</strong> for corporate always-on deploys.<br>
    Same codebase, same binary, zero vendor lock-in.
  </p>
  <p align="center">
    <a href="https://github.com/bogdanpricop/docker-dash/actions/workflows/ci.yml"><img src="https://github.com/bogdanpricop/docker-dash/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <a href="https://github.com/bogdanpricop/docker-dash/releases/latest"><img src="https://img.shields.io/github/v/release/bogdanpricop/docker-dash?color=blue" alt="Release"></a>
    <a href="LICENSE"><img src="https://img.shields.io/github/license/bogdanpricop/docker-dash" alt="License"></a>
    <a href="https://github.com/bogdanpricop/docker-dash/actions/workflows/ci.yml"><img src="https://img.shields.io/badge/tests-1398%20passing%20(100%25)-brightgreen" alt="Tests"></a>
    <img src="https://img.shields.io/badge/version-8.2.0-blue" alt="Version">
    <a href="SECURITY.md#security-audit-history"><img src="https://img.shields.io/badge/production%20readiness-9.9%2F10-brightgreen" alt="Production Readiness"></a>
    <a href="SECURITY.md"><img src="https://img.shields.io/badge/security-audited-brightgreen" alt="Security Audited"></a>
    <img src="https://img.shields.io/badge/Docker-~180MB-blue" alt="Image Size">
    <img src="https://img.shields.io/badge/RAM-~50MB-blue" alt="RAM Usage">
  </p>
  <p align="center">
    <a href="#deployment-modes"><strong>Deployment modes</strong></a> &bull;
    <a href="#target-audience">Target audience</a> &bull;
    <a href="#quick-start">Quick Start</a> &bull;
    <a href="#features">Features</a> &bull;
    <a href="#screenshots">Screenshots</a> &bull;
    <a href="#comparison">Comparison</a> &bull;
    <a href="#troubleshooting-install">Troubleshooting</a> &bull;
    <a href="#contributing">Contributing</a>
  </p>
  <p align="center">
    <a href="https://github.com/bogdanpricop/docker-dash/discussions">💬 Discussions</a> &bull;
    <a href="https://github.com/bogdanpricop/docker-dash/issues">🐞 Issues</a> &bull;
    <a href="https://github.com/bogdanpricop/docker-dash/releases">📦 Releases</a> &bull;
    <a href="docs/comparisons/">⚖️ Comparisons</a>
  </p>
</p>

## Deployment modes

Docker Dash runs in two modes from a single codebase. Pick based on your needs:

|  | **Standalone** (default) | **HA** (opt-in, v7.0.0+) · **Observability** (opt-in, v7.1.0+) |
|---|---|---|
| **Dependencies** | Just Docker | Docker + Redis + sticky-session load balancer |
| **Replicas** | 1 | 2–5 (production-validated) |
| **Failover** | Restart on crash (Docker restart policy) | Automatic — leader lock in Redis, ~30s worst case, milliseconds on graceful restart |
| **Cross-replica events** | N/A | Redis pub/sub (loop-safe, sub-ms delivery) |
| **Rate limiter** | In-process sliding window | Redis `INCR` fixed window, shared across replicas |
| **Sessions** | SQLite (works in both modes) | SQLite (single-writer on leader) |
| **Best for** | Homelab · dev/staging · SMB · single-office | Corporate dashboards · on-prem K8s · always-on infrastructure panels |
| **Complexity** | 1 container, zero config beyond `.env` | 3+ containers, LB config, failover runbook |
| **Operational overhead** | None | Prometheus monitoring recommended (cluster health alerts) |

**`DD_MODE` is the only switch.** Unset (default) = standalone, identical to every prior v6.x release. `DD_MODE=ha` + `REDIS_URL` = HA mode.

**Feature parity:** every feature works in both modes. HA doesn't unlock "enterprise" features — it just adds redundancy.

**Fully backwards-compatible.** An existing standalone deployment upgrades to HA without migration, and downgrades back without data loss. Your SQLite volume carries over.

Deep reading: [HA Mode reference](docs/features/ha-mode.md) · [Failover runbook](docs/features/ha-failover-runbook.md) · [LB configs (Caddy/Traefik/HAProxy/nginx)](docs/features/ha-lb-configs.md)

## Target audience

**Good fit for Docker Dash:**

| You are… | Use mode | Why |
|---|---|---|
| Homelab enthusiast · self-hosting Plex/*arr/Nextcloud | Standalone | Single-host, simple, no build step, no database to babysit |
| Small team running a shared dev environment | Standalone (+ `--profile tls` Caddy) | HTTPS + SSO without fighting certificates manually |
| SMB with 1–3 Docker hosts, shared ops role | Standalone + multi-host SSH tunnel | Manage multiple hosts from one UI, no agent to deploy |
| NAS user (Synology · Unraid · TrueNAS · QNAP · OMV) | Standalone | Platform auto-detection, tailored How-To guides, works with Container Manager |
| VPS user (Hetzner · DO · EC2 · GCE · Azure · Linode · Vultr) | Standalone + DMI cloud detection | Cloud vendor badges, generic VPS How-To guide |
| Corporate team with 99.9% uptime SLA | **HA mode** (2–3 replicas) | Leader election + failover + shared rate limiter + cross-replica WS |
| On-prem Kubernetes with Docker Dash as internal tool | **HA mode** (StatefulSet, sticky session Ingress) | Survives pod restarts, rolling deploys with no dashboard downtime |

**Not a good fit:**

- **Kubernetes-native production workloads** — use [Rancher](https://rancher.com/) or [Portainer BE](https://www.portainer.io/business) instead. Docker Dash targets the Docker daemon directly; it doesn't manage K8s objects.
- **Geographic distribution across regions** — SQLite single-writer limits you to same-AZ HA. If you need multi-region active-active, you need a different tool (or wait for a hypothetical Docker Dash Postgres backend, which is not on the roadmap).
- **Multi-tenant SaaS** — Docker Dash assumes one organization per instance. RBAC works within that instance but there's no tenant isolation layer.
- **CI/CD pipeline orchestration** — Docker Dash manages running containers, not build pipelines. Use GitHub Actions, GitLab CI, Jenkins, etc. for that. Docker Dash's GitOps feature is for *deploying* from Git, not building.
- **Image registry** — Docker Dash *uses* registries (Docker Hub, GHCR, GitLab) but is not a registry itself. For self-hosted registry, use [Harbor](https://goharbor.io/) or [distribution/distribution](https://distribution.github.io/distribution/).

## Screenshots

<table>
  <tr>
    <td align="center"><strong>Dashboard (Dark)</strong><br><img src="docs/screenshots/dashboard.png" alt="Dashboard" width="400"></td>
    <td align="center"><strong>Dashboard (Light)</strong><br><img src="docs/screenshots/dashboard-light.png" alt="Dashboard Light" width="400"></td>
  </tr>
  <tr>
    <td align="center"><strong>Containers</strong><br><img src="docs/screenshots/containers.png" alt="Containers" width="400"></td>
    <td align="center"><strong>Container Detail</strong><br><img src="docs/screenshots/container-detail.png" alt="Container Detail" width="400"></td>
  </tr>
  <tr>
    <td align="center"><strong>Terminal (xterm.js)</strong><br><img src="docs/screenshots/terminal.png" alt="Terminal" width="400"></td>
    <td align="center"><strong>Images</strong><br><img src="docs/screenshots/images.png" alt="Images" width="400"></td>
  </tr>
  <tr>
    <td align="center"><strong>Volumes</strong><br><img src="docs/screenshots/volumes.png" alt="Volumes" width="400"></td>
    <td align="center"><strong>Networks</strong><br><img src="docs/screenshots/networks.png" alt="Networks" width="400"></td>
  </tr>
  <tr>
    <td align="center"><strong>Multi-Host Overview</strong><br><img src="docs/screenshots/multi-host.png" alt="Multi-Host" width="400"></td>
    <td align="center"><strong>Stacks</strong><br><img src="docs/screenshots/stacks.png" alt="Stacks" width="400"></td>
  </tr>
  <tr>
    <td align="center"><strong>Security Scanning</strong><br><img src="docs/screenshots/security.png" alt="Security" width="400"></td>
    <td align="center"><strong>Log Explorer</strong><br><img src="docs/screenshots/log-explorer.png" alt="Log Explorer" width="400"></td>
  </tr>
  <tr>
    <td align="center"><strong>Event Timeline</strong><br><img src="docs/screenshots/timeline.png" alt="Timeline" width="400"></td>
    <td align="center"><strong>Network Topology</strong><br><img src="docs/screenshots/topology.png" alt="Network Topology" width="400"></td>
  </tr>
  <tr>
    <td align="center"><strong>Dependency Map</strong><br><img src="docs/screenshots/dependency-map.png" alt="Dependency Map" width="400"></td>
    <td align="center"><strong>Cost Optimizer</strong><br><img src="docs/screenshots/cost-optimizer.png" alt="Cost Optimizer" width="400"></td>
  </tr>
  <tr>
    <td align="center"><strong>Insights</strong><br><img src="docs/screenshots/insights.png" alt="Insights" width="400"></td>
    <td align="center"><strong>Alerts</strong><br><img src="docs/screenshots/alerts.png" alt="Alerts" width="400"></td>
  </tr>
  <tr>
    <td align="center"><strong>System Tools</strong><br><img src="docs/screenshots/system-tools.png" alt="System Tools" width="400"></td>
    <td align="center"><strong>How-To Guides</strong><br><img src="docs/screenshots/howto.png" alt="How-To" width="400"></td>
  </tr>
  <tr>
    <td align="center"><strong>Feature Comparison</strong><br><img src="docs/screenshots/compare.png" alt="Compare" width="400"></td>
    <td align="center"><strong>Enterprise Mode</strong><br><img src="docs/screenshots/enterprise.png" alt="Enterprise" width="400"></td>
  </tr>
  <tr>
    <td align="center"><strong>API Playground</strong><br><img src="docs/screenshots/api-playground.png" alt="API Playground" width="400"></td>
    <td align="center"><strong>What's New</strong><br><img src="docs/screenshots/whatsnew.png" alt="What's New" width="400"></td>
  </tr>
  <tr>
    <td align="center"><strong>Registry Browser (v7.5.0–v8.1.0)</strong><br><img src="docs/screenshots/registry-browse.png" alt="Registry Browser" width="400"></td>
    <td align="center"><strong>Observability Wizard (v7.2.0)</strong><br><img src="docs/screenshots/observability-wizard.png" alt="Observability Wizard" width="400"></td>
  </tr>
  <tr>
    <td align="center"><strong>AI Audit NL Search (v8.0.0)</strong><br><img src="docs/screenshots/ai-audit-search.png" alt="AI Audit NL Search" width="400"></td>
    <td align="center"><strong>pCloud Backup (v8.2.0)</strong><br><img src="docs/screenshots/pcloud-backup.png" alt="pCloud Backup" width="400"></td>
  </tr>
</table>

## Features

### Core
- **Container Management** — Start, stop, restart, pause, kill, remove, clone, rename, update/recreate
- **Image Management** — Pull with streaming progress, remove, tag, import/export, build from Dockerfile
- **Volume Management** — Create, remove, inspect with real disk usage sizes
- **Network Management** — Create, remove, connect/disconnect containers, inspect IPAM config
- **Bulk Actions** — Checkbox selection + floating bar for batch start/stop/restart/remove
- **One-click Port Access** — Each exposed TCP port shows a clickable link to open `http://host:port` directly
- **Keyboard Navigation** — Arrow keys to navigate container rows, `r` to restart, `s` to stop/start, `Enter` to open detail, `l` for logs
- **Live CPU/RAM Mini-bars** — Two 4px color-coded progress bars per running container, updated every 5 seconds
- **Container File Browser** — Navigate, view, upload, and download files inside running containers
- **Container Diff** — See filesystem changes vs base image with color-coded entries
- **Image Picker** — Browse 20 popular images (nginx, postgres, redis, etc.) when creating containers
- **CIS Hardened Creation** — One-click CIS benchmark hardening: cap_drop ALL, read-only rootfs, no-new-privileges, resource limits
- **Log Time Filter** — Filter container logs by time range: last 1h, 6h, 24h, 7 days

### Monitoring & Intelligence
- **Real-time Dashboard** — Customizable live CPU/memory charts (WebSocket, 10s interval, toggle widgets)
- **Container Health Score** — Composite 0-100 score with color dots in list view + summary bar
- **Resource Trends & Forecasting** — 7-day linear regression with 24h CPU/memory projection
- **Memory Exhaustion Prediction** — "will exceed limit in N hours" warning
- **Plain-English Status** — Exit codes mapped to messages (137=OOM, 143=SIGTERM, etc.)
- **Network Topology** — Interactive canvas map with drag, zoom, pan, hover highlighting
- **Dependency Map** — Interactive graph showing container relationships (env vars, networks, links)
- **Uptime Reports** — Per-container uptime %, restart count, first/last seen
- **Cost Optimizer** — Per-container cost breakdown, idle detection, savings recommendations
- **Image Freshness Dashboard** — Freshness score based on age + vulnerability count
- **Audit Log Analytics** — Top users, top actions, activity heatmap by hour/day
- **Notifications Center** — Dedicated page with filters, pagination, bulk mark-read/delete

### Security
- **Vulnerability Scanning** — Trivy + Grype + Docker Scout with automatic detection and fallback
- **Safe-Pull Updates** — Pull new image → scan for vulns → only swap if clean (blocks critical CVEs)
- **Deployment Pipelines** — Staged pull → scan → swap → verify → notify with full history
- **Security Dashboard** — Scan history, per-image status, AI-assisted remediation prompts
- **AI Container Doctor** — Diagnostics + 30 log pattern matchers + Ask AI (OpenAI/Ollama) directly from modal
- **Guided Troubleshooting** — 8-step diagnostic wizard (state, health, logs, ports, volumes, resources)
- **Container Rollback** — One-click revert to previous image with version history
- **First-login Setup Wizard** — Forces password change, recommends disabling default admin
- **Outbound Network Filter** (v6.7) — Per-container egress policy sidecar with TLS-SNI + HTTP-Host peek. Allowlist-based, blocks IMDS by default, logs denied connections. No TLS decryption
- **Per-container Security tab** (v6.10) — 2×2 grid combining Secrets score, Egress reachability + filter state, CIS findings, and Image Vulnerabilities on every container's detail page
- **Stack-level Security Audits** (v6.9.3) — One-click Secrets Audit + Egress Audit buttons on every stack, matching Security Scan + CIS Benchmark. Drill down to Fix via Remediation Wizard
- **Remediation Wizard drill-down** (v6.9.4) — Image-centric security findings now link to running containers using that image, then open Fix scoped to the container
- **Error-response sanitization** (v6.14.1) — Central error middleware scrubs `/home/` and `/data/` paths, redacts URL credentials, replaces raw error messages with `"Internal server error"` on 5xx. Closes an accidental info-leak from the pre-Express-5 try/catch pattern

### Git Integration (GitOps)
- **Deploy from Git** — Clone repos, select branch, compose file path, deploy with one click
- **Auto-Deploy** — Webhook receiver (GitHub, GitLab, Gitea, Bitbucket) + polling-based updates
- **Deployment History** — Full audit trail with commit hash, trigger type, duration, rollback
- **Diff View** — See exactly what changed before redeploying
- **Push to Git** — Edit compose in UI, commit and push back to repository
- **Git Credentials** — Token, basic auth, SSH key (AES-256-GCM encrypted)
- **Multi-file Compose** — Multiple YAML override files per stack
- **Environment Overrides** — Per-stack env vars with sensitive value encryption

### Multi-Host
- **TCP + TLS** — Connect remote Docker hosts over the network with mutual TLS
- **SSH Tunnel** — Secure tunnel via SSH (no need to expose Docker API). v6.8 adds a full exec / fileExists / readFile / writeFile channel so the Remediation Wizard Apply mode works end-to-end on remote hosts
- **Docker Desktop** — Connect to Windows/Mac Docker Desktop instances
- **Podman Compatible** — Works with Podman via Docker-compatible API socket
- **Host Selector** — Switch between hosts from the sidebar dropdown
- **NAS support** (v6.12) — Auto-detects Synology DSM, Unraid, TrueNAS SCALE, QNAP QTS/QuTS hero, OpenMediaVault from `docker info`. No SSH probes, no SDKs. Dedicated per-platform How-To guides cover the platform-specific quirks (Container Manager socket, User Home Service, ix-* managed containers, variable QTS socket path, omv-extras Docker plugin, etc.)
- **Cloud vendor badges** (v6.12.1) — Optional DMI probe (`/sys/class/dmi/id/sys_vendor` + `product_name`) identifies AWS EC2, Google Cloud, Azure VM, DigitalOcean, Hetzner, Linode, Vultr, Oracle Cloud, Scaleway, OVHcloud, plus on-prem hypervisors (VMware, VirtualBox, KVM/QEMU, Xen, Parallels). Renders as a second colored pill on the Multi-Host card

### Operations
- **Stacks Page** — Unified Compose + Git stacks management with actions (up/down/restart/pull)
- **Docker Swarm Mode** — Full UI for Nodes, Services, Tasks; init/leave swarm, scale services, drain nodes, join tokens
- **Docker Compose Editor** — Edit, validate, save & deploy compose configs inline
- **Terminal** — Full xterm.js terminal with shell selection (`sh`, `bash`, `zsh`, `ash`)
- **Alerts** — CPU/memory threshold rules with 7 notification channels
- **Notifications** — Discord, Slack, Telegram, Ntfy, Gotify, Email (SMTP), Custom Webhook
- **Workflow Automation** — IF-THEN rules (CPU high → restart, container crash → notify, etc.)
- **Scheduled Actions** — Cron-based container actions with presets, history, run-now, enable/disable
- **Maintenance Windows** — Scheduled pull/scan/update with block-on-critical
- **Firewall** — View and manage UFW rules (Linux)
- **Container Groups** — User-defined grouping with colors, beyond Docker Compose projects

### Sandbox Mode
- **Ephemeral Sandbox** — Launch a container with auto-delete on stop + optional TTL (30m / 1h / 4h); perfect for testing images risk-free
- **Persistent Sandbox** — Isolated container with resource limits that survives stop/restart
- **Project Source (GitHub)** — Paste a GitHub repo URL; Docker Dash downloads the tarball, auto-detects the tech stack (Node/Python/Go/Ruby/static), installs dependencies, and starts the app
- **Project Source (Upload)** — Upload a .tar/.tar.gz archive; same auto-detect + auto-run flow
- **Auto-detect Stack** — Recognizes package.json, requirements.txt, go.mod, Gemfile, index.html and selects the right base image (node:20-alpine, python:3.12-alpine, etc.)
- **Security Defaults** — Sandbox containers run with `no-new-privileges`, dedicated internal `dd-sandbox` network, resource limits, restart: no
- **TTL Auto-cleanup** — Background timer removes expired sandboxes every 30 seconds with WebSocket notification
- **Visual Badges** — `EPHEMERAL` (red + countdown) or `SANDBOX` (yellow) badges in containers list, detail card with Extend +1h / Remove buttons

### Developer Tools
- **API Playground** — Browse and test 450+ API endpoints from the UI with response viewer
- **docker run → Compose** — Paste any docker run command, get docker-compose YAML
- **Dual AI Provider** — Container Doctor supports OpenAI API and local Ollama; provider/model/key selector + inline response
- **AI Log Analysis** — Generate diagnostic prompts for ChatGPT/Claude from container logs
- **Generate Compose from GitHub** — Paste a public repo URL, AI (OpenAI or Ollama) generates a production-ready docker-compose.yml
- **Traefik/Caddy Labels** — Generate reverse proxy labels from domain + port
- **App Templates** — 47 built-in + custom templates with CRUD, preview, Template Configurator and modification tracking. **AI Workload Pack** (v8.0.1): 12 curated AI/ML templates — Ollama, Open WebUI, RAG stack (Ollama+Qdrant+Open WebUI), vLLM, Stable Diffusion WebUI, ComfyUI, Whisper, Langflow, AnythingLLM, n8n, LiteLLM Proxy, Flowise (GPU passthrough block ready, commented for CPU compat)
- **Image Layer Visualization** — View all layers of any image with command, size, and relative-size bar per layer
- **Deploy Preview** — Check for image updates via digest comparison before pulling
- **Resource Limits Editor** — Visual sliders with presets for CPU and memory
- **Resource Recommendations** — Smart advice: over-provisioned, memory pressure, idle containers

### Security & Compliance
- **Enterprise Security Mode** — `SECURITY_MODE=strict`: cookie-only auth, 8h sessions, password expiry, WS query-string auth disabled
- **TOTP / MFA** — Two-factor auth with RFC 6238 TOTP, encrypted secrets, 10 recovery codes
- **LDAP / Active Directory** — Two-bind authentication, group filter, attribute mapping, auto-provision local accounts
- **CIS Docker Benchmark** — 18 automated checks (daemon + container), scored report with remediation guidance
- **Immutable Audit Log** — SHA-256 hash-chained, tamper detection, JSON/CSV/Syslog export
- **Security Alerts** — 5 default rules (brute force, admin created, MFA disabled), threshold detection

### Knowledge Base
- **How-To Guides** — 84 built-in bilingual guides (EN + RO) covering Docker basics, Linux, networking, security, Compose, Swarm, troubleshooting, backup, performance — plus dedicated platform setups for Synology DSM, Unraid, TrueNAS SCALE, QNAP, OpenMediaVault, Generic VPS (Hetzner/DO/EC2/GCE/Azure/Linode/Vultr), an SSH key auth guide with per-platform public-key placement instructions, and an **AI category** (v8.0.1) covering Ollama on CPU/GPU, NVIDIA GPU passthrough to Docker, and a self-hosted RAG stack walkthrough
- **Guide Editor** — Admins can create, edit, and delete custom guides with HTML content in both languages
- **Search & Categories** — Filter by 9 categories, difficulty level, and free-text search across all guides

### Platform
- **Multi-user** — Admin, operator, viewer roles with session management
- **SSO Authentication** — Authelia, Authentik, Caddy forward_auth, Traefik (header-based)
- **SSL Zero-Config** — Caddy sidecar auto-reload via shared volume; enable HTTPS from UI with one click
- **Audit Log** — Every action logged with user, timestamp, IP address
- **Public Status Page** — Unauthenticated status page for selected services
- **Container Metadata** — Custom labels, descriptions, links, categories, owner, notes
- **Dark/Light Theme** — Per-user sync across devices, system-aware toggle, mobile responsive
- **i18n** — 11 languages: English (complete), Romanian (~77%), German / Italian / French / Spanish / Portuguese / Chinese / Japanese / Korean / Klingon (~66% each — fall back to English for missing keys). [Add yours](public/js/i18n/README.md). The Translations tab below closes the gap without code changes.
- **Translations tab** (v6.11) — Built-in Google Translate + DeepL integration for the missing keys in non-EN locales. Per-provider monthly quota tracking (500k chars each free tier), auto-accept toggle, chunked batch with progress bar + cancel, runtime DB overrides applied on login (no file download / git commit / container rebuild). AES-GCM encrypted API keys, hash-chained audit trail
- **Klingon Easter Egg** — Full activation animation with sound, dagger cursor, red theme
- **Command Palette** — Ctrl+K quick navigation with keyboard shortcuts
- **Watchtower Detection** — Auto-detect and migrate from Watchtower to native safe-pull
- **Prometheus Metrics** — `/api/metrics` endpoint for Grafana integration
- **Self-Reporting Footprint** — Docker Dash memory, uptime, DB size at `/api/footprint`
- **Let's Encrypt Wizard** — 3-step UI for issuing certs via DNS-01 (Cloudflare, Route53, DigitalOcean, Hetzner, Linode) or HTTP-01. Encrypted credential vault, auto-renewal via Caddy, hash-chained audit trail. Open source — no other Docker UI ships this
- **Container Remediation Wizard** — 3-step UI that turns Secrets Audit + CIS Benchmark findings into actionable fixes. 20-entry catalog, 4 live-updatable (zero downtime), 16 with compose-recreate + auto-rollback. Git-PR mode for git-backed stacks. No other OSS Docker UI ships this
- **1398 Tests** — 83 test suites covering 10 critical-path services with ≥15 dedicated cases each (auth, audit, docker, registry, ssl, ldap, ssh-tunnel, stackBundle, securityAlerts, webhooks) + 3 v8.2.x scaffold modules (telemetry, howto-loader, template-verification with migration 065), plus RBAC, security, ACME + remediation orchestrators, platform detection, DMI cloud detection, translations, Prometheus metrics, settings CRUD, security alert rule evaluation + cooldown, event notifier dispatch, cluster abstraction (HA mode), rate-limiter memory + Redis paths, registry retention + provenance pure-evaluators, AI redactor + service abstraction, pCloud client + backup orchestration + audit dump (hash-chain integrity verified). 100% passing.

### AI (v8.0.0+) — opt-in, BYOK, off by default

The first feature category that introduces optional outbound traffic to non-user-controlled hosts. Designed strategy-first ([deep-spec](plans/deep-spec-ai-features.md), [spikes](plans/spikes-ai-features.md)). One sentence to defend: **AI in Docker Dash exists to translate noisy data into ranked, explainable decisions — never to take actions on the user's behalf.** Read-only or read-then-suggest. No always-on chat sidebar. No auto-remediation agent.

- **Provider abstraction** — Anthropic Claude, OpenAI, Ollama. **BYOK** — Docker Dash ships zero API keys. Off by default until operator configures + enables in Settings → AI tab.
- **Privacy-first redactor** — strips secrets/PII before any payload leaves the host. Built-in patterns cover Bearer auth, env-style assignments (incl. `STRIPE_SECRET_KEY`-style prefixes), connection-string credentials (13 schemes), high-entropy tokens, IPs, emails. Validated 100/100 on a 27-case corpus. Bad custom regex aborts the call (privacy beats utility).
- **Compliance-grade audit** — every AI call logged with provider, model, token counts, redaction counts, SHA-256 payload hash. Operators can prove "did this exact text get sent?" without storing the prompt.
- **Audit log NL search (v8.0.0)** — System → Audit page → magic-wand search box. Type *"who deleted containers in the last 7 days"* → translates to a structured filter via the AI provider, runs through existing audit query path. Never NL→SQL — only structured fields conforming to a JSON schema with a 174-entry action enum.
- **Ollama is first-class** for sovereignty-critical deployments — zero outbound traffic. Recommended local model: `qwen2.5-coder:7b` (≈6 GB RAM, $0/month).
- **Cost example** for cloud providers: 100 NL searches/day ≈ **$1.50/month** on Claude Haiku 4.5, **$0.30/month** on GPT-4o-mini.
- **Roadmap**: AI vulnerability triage (rank scan results by real exploitability via EPSS + LLM reasoning) and AI incident triage (container restart-loop diagnosis from inspect + logs + stats) remain gated on production signal from v8.0.0 audit search — need ≥2 weeks of uptime, ≥1 real redactor catch, zero compliance issues. Until then, v8.x has prioritized adjacent value: registry hygiene (v8.1.0) and off-site backup (v8.2.0).

See [`docs/features/ai.md`](docs/features/ai.md) for the full setup walkthrough, provider tradeoffs, redactor reference, and programmatic API.

### Feature Reference

Dedicated reference docs for the deeper features, in [docs/features/](docs/features/):

- **[Prometheus Metrics](docs/features/prometheus-metrics.md)** — `/api/metrics` endpoint reference, metric names + types + labels, sample Grafana queries, cardinality notes
- **[Platform Detection](docs/features/platform-detection.md)** — NAS + cloud + hypervisor detection logic; complete signature list; how to extend
- **[Translations Tooling](docs/features/translations-tooling.md)** — Google Translate + DeepL integration, quota tracking, review workflow, runtime DB overrides
- **[HA Mode](docs/features/ha-mode.md)** — optional Redis-backed redundancy (production-ready in v7.0.0); architecture, trade-offs, when NOT to use it
- **[HA Failover Runbook](docs/features/ha-failover-runbook.md)** — operator procedures: leader death, rolling restart, Redis failure, split-brain detection, recovery checklist
- **[HA Load Balancer Configs](docs/features/ha-lb-configs.md)** — copy-paste examples for Caddy + Traefik + HAProxy + nginx with sticky-session + WS upgrade + health checks
- **[Observability Stack (v7.1.0)](docs/features/observability.md)** — opt-in Prometheus + Grafana via `docker compose --profile observability up -d`, 8-panel dashboard auto-provisioned, recommended alerts, integration with existing Prometheus/Grafana
- **[Observability Wizard (v7.2.0)](docs/features/observability.md#1a-in-app-wizard-v720)** — admin UI at **System → Observability**. Detects existing Prometheus/Grafana on the host and offers 3 UX branches: integrate (both found → copy scrape snippet + one-click dashboard import via Grafana API), partial deploy, or full deploy with copy-paste instructions. Admin-only, audit-logged, token never persisted
- **[Image Registry (v7.5.0–v8.1.0)](docs/features/registry.md)** — Distribution one-click template + push from Images page (SSE progress stream) + Browse page (catalog + tags + manifest inspect) + delete-by-digest with two-step confirmation gate + **Registry Hygiene Pack (v8.1.0)**: build provenance panel surfacing OCI annotations + cosign presence, retention policies with dry-run + 5-layer safety (default-disabled, min-3-tags floor, default protected patterns latest/v\*/main/master/prod-\*/stable, server cap 200/run, audit per delete), and JFrog-style local/remote/virtual repo taxonomy via Distribution proxy config (Docker Hub rate-limit relief + offline operation)
- **[AI Features (v8.0.0)](docs/features/ai.md)** — opt-in, BYOK, off by default. Provider abstraction across Anthropic / OpenAI / Ollama. Privacy-first redactor (validated 100/100 on a hand-built corpus). SHA-256 payload hash in audit log for compliance evidence. Audit NL search (System → Audit) ships first; AI vulnerability triage + incident triage gated on production signal from v8.0.0
- **[pCloud Backup (v8.2.0)](docs/features/pcloud-backup.md)** — third backup target alongside local + S3. Pushes the daily DB, weekly stack bundles, and monthly hash-chain-preserving audit log dumps to a pCloud free-tier account (10 GB, EU Switzerland default). Direct token auth (no OAuth dance), AES-256-GCM token storage, quota-aware uploads (95% threshold + 50 MB safety margin), per-artifact retention. Anti-features deliberately NOT shipped: pCloud Crypto, Drive mount, public sharing, restore-from-pCloud UI, the abandoned pcloud-sdk-js

## Where to start

Three short reads, each tailored to a different background. Pick the one that matches you.

<table>
  <tr>
    <td width="33%" valign="top">
      <h3>🚀 New to Docker?</h3>
      <p>The recipe-and-kitchen metaphor, why containers fix <em>"works on my machine"</em>, what you see in the first 30 seconds of opening Docker Dash, and what you can do in your first hour. No jargon.</p>
      <p><strong><a href="docs/guides/why-docker-dash-beginners.md">Read: Beginner's Guide →</a></strong></p>
    </td>
    <td width="33%" valign="top">
      <h3>⎇ Developer using Git?</h3>
      <p>The git → Docker mental bridge (<code>commit</code> = image, <code>package.json</code> = compose), the 5 places dev-with-git gets stuck, and how Docker Dash compares against Portainer / Dockge / bash scripts. With a GitOps workflow.</p>
      <p><strong><a href="docs/guides/why-docker-dash-developers.md">Read: Developers Using Git →</a></strong></p>
    </td>
    <td width="34%" valign="top">
      <h3>🛠 Ops / SRE evaluating HA?</h3>
      <p>When to flip <code>DD_MODE=ha</code>, when to stay standalone, failover mechanics (Redis <code>SET NX PX</code>, leader lock TTL, Lua <code>DEL-if-owned</code> graceful handover), operational runbook covering 6 failure scenarios, and copy-paste LB configs for Caddy/Traefik/HAProxy/nginx.</p>
      <p><strong><a href="docs/features/ha-mode.md">Read: HA Mode →</a></strong></p>
      <p>↳ <a href="docs/features/ha-failover-runbook.md">Failover Runbook</a> · <a href="docs/features/ha-lb-configs.md">LB Configs</a></p>
    </td>
  </tr>
</table>

> The first two guides are also available inside the app under <strong>How-To Guides</strong> with bilingual EN/RO content and surfaced as buttons in the page header. HA docs are operator-facing and live in the repo / docs only.

## Quick Start

### One-Line Install (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/bogdanpricop/docker-dash/main/install.sh | bash
```

This will detect your OS, check Docker, generate secure secrets, and start Docker Dash. Works on Ubuntu, Debian, CentOS, Fedora, and macOS (amd64/arm64).

Set a custom install directory: `DOCKER_DASH_DIR=/opt/docker-dash curl -fsSL ... | bash`

For an unattended-secure install with a random admin password (instead of `admin/admin`-then-change): `FORCE_RANDOM_ADMIN_PASSWORD=1 curl -fsSL ... | bash` — the generated password is printed once at the end.

> **Install didn't work?** Jump to [Troubleshooting Install](#troubleshooting-install) — covers restart loops, build failures, port conflicts, permission issues, and the diagnostic one-liner that surfaces 95% of failure modes.

> **Specific setup?** See [`examples/deployments/`](examples/deployments/README.md) — ready-to-customize compose files for Caddy auto-HTTPS, Traefik v3, Nginx Proxy Manager, Docker Swarm, HA mode (2 replicas + Redis), and Synology DSM. Or open **System → Tools → Deployment Configurator** in the running app for a live wizard that emits the YAML for your environment.

### Manual Install

```bash
# Clone the repository
git clone https://github.com/bogdanpricop/docker-dash.git
cd docker-dash

# Copy and configure environment
cp .env.example .env
# Edit .env — at minimum change APP_SECRET and ADMIN_PASSWORD

# Start with Docker Compose
docker compose up -d

# Open in browser
open http://localhost:8101
```

Default credentials: `admin` / `admin` — on first login, a **security setup wizard** will require you to change the password.

### Enabling HA mode

Once standalone works, switching to HA is a flag flip:

```bash
# .env
DD_MODE=ha
REDIS_URL=redis://redis:6379

# Bring up Redis alongside Docker Dash
docker compose --profile ha up -d

# Then scale to multiple replicas behind a sticky-session LB (see LB configs doc)
```

See the [HA Mode reference](docs/features/ha-mode.md) for the full enablement procedure, [Failover runbook](docs/features/ha-failover-runbook.md) for operational scenarios, and [LB configs](docs/features/ha-lb-configs.md) for production-ready Caddy/Traefik/HAProxy/nginx configurations.

## Requirements

### Standalone

- Docker Engine 20.10+ (or Docker Desktop 4.x+)
- Docker Compose v2
- ~50MB RAM, minimal CPU, ~180MB disk for the image (includes Trivy + Grype + Docker Scout binaries for built-in vulnerability scanning)

### HA mode (additional)

- Redis 7+ (ships as `redis:7-alpine` in the `--profile ha` compose profile; ~30MB image, ~5-15MB RAM)
- Sticky-session-capable load balancer for 2+ replica deploys (Caddy, Traefik, HAProxy, nginx — [configs provided](docs/features/ha-lb-configs.md))
- Shared volume for SQLite (Docker named volume works on same host; K8s `ReadWriteMany` PVC for multi-node)
- Operator familiarity with Redis basics (single instance is fine — Sentinel only needed for Redis HA separately)

## Troubleshooting Install

If `curl ... | bash` finishes but the container won't stay up, the Docker container exits immediately, or you see `restarting` in `docker ps` over and over — work through this section in order. It covers the bugs we've actually seen reported, with the diagnostic commands to confirm each and the exact fix for each.

### Step 1 — Triage in one command

Run this from inside the install directory (default `~/docker-dash`):

```bash
cd ~/docker-dash 2>/dev/null || cd /opt/docker-dash 2>/dev/null
echo "=== container state ==="
docker inspect docker-dash --format 'exitCode={{.State.ExitCode}} error={{.State.Error}} restartCount={{.RestartCount}} status={{.State.Status}}'
echo "=== last 50 log lines ==="
docker logs docker-dash --tail 50 2>&1
echo "=== env (no secrets) ==="
grep -E '^(APP_ENV|APP_PORT|ADMIN_PASSWORD|ALLOW_DEFAULT_ADMIN|DD_MODE|DOCKER_SOCKET)' .env 2>/dev/null
echo "=== image in use ==="
docker inspect docker-dash --format '{{.Config.Image}} (created {{.Created}})'
echo "=== compose file ==="
head -25 docker-compose.yml
echo "=== disk space ==="
df -h / /var/lib/docker 2>/dev/null | head -3
```

The output is enough to identify 95% of install failures. Map the symptom to the section below.

### Step 2 — Match the symptom

#### A. Logs end with `FATAL: ADMIN_PASSWORD is "admin" in production`

Your `.env` has `ADMIN_PASSWORD=admin` but no `ALLOW_DEFAULT_ADMIN=true`. Server refuses to boot in production mode with the default password unless you opt in. Two fixes:

```bash
# Option 1 — keep admin/admin (forced password change on first login)
echo 'ALLOW_DEFAULT_ADMIN=true' >> .env
docker compose up -d

# Option 2 — set a random strong admin password
NEW_PW=$(openssl rand -base64 24 | tr -d '/+=' | head -c 20)
sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$NEW_PW|" .env
docker compose up -d
echo "Your new admin password: $NEW_PW"
```

Re-run from a fresh installer (recommended path — picks up all the install.sh fixes shipped after this bug was first reported):

```bash
docker compose down
mv .env .env.backup
curl -fsSL https://raw.githubusercontent.com/bogdanpricop/docker-dash/main/install.sh | bash
```

#### B. Logs end with `FATAL: APP_SECRET is weak or default` or `ENCRYPTION_KEY is weak or default`

`.env` has placeholder values for one of those. Generate strong replacements:

```bash
APP_SECRET=$(openssl rand -hex 48)
ENCRYPTION_KEY=$(openssl rand -hex 32)
sed -i "s|^APP_SECRET=.*|APP_SECRET=$APP_SECRET|" .env
sed -i "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$ENCRYPTION_KEY|" .env
docker compose up -d
```

#### C. `failed to compute cache key` or `COPY ... not found` during build

The local-build fallback got a sparse build context (some required files weren't cloned). The fix: use the pre-built image instead.

```bash
docker compose down
docker pull ghcr.io/bogdanpricop/docker-dash:latest
# Edit docker-compose.yml: replace the entire `build:` block with:
#   image: ghcr.io/bogdanpricop/docker-dash:latest
# Then:
docker compose up -d
```

Or run the latest installer, which now uses the GHCR image first by default:

```bash
mv ~/docker-dash ~/docker-dash.broken
curl -fsSL https://raw.githubusercontent.com/bogdanpricop/docker-dash/main/install.sh | bash
```

#### D. Logs show `EACCES`, `permission denied`, or SQLite write errors on `/data`

Volume mount can't be written by the container's UID. Most common on bind-mounted host directories with stale ownership.

```bash
# If using the default named volume (recommended) — recreate it:
docker compose down
docker volume rm docker-dash-data
docker compose up -d

# If you bind-mounted a host path, fix ownership:
sudo chown -R 1000:1000 /path/to/your/data/dir
docker compose up -d
```

#### E. Logs show `EADDRINUSE` or container exits with `port is already allocated`

Port 8101 (or whichever you set) is taken by another process. Either change the port or stop the conflicting process.

```bash
# Find what's on 8101
sudo ss -tlnp | grep ':8101'

# Either kill it, or edit .env to use a different port:
sed -i 's|^APP_PORT=.*|APP_PORT=8201|' .env
docker compose up -d
```

#### F. `docker info` fails / `Cannot connect to the Docker daemon`

Docker daemon isn't running, or your user isn't in the `docker` group.

```bash
# Start the daemon:
sudo systemctl start docker
sudo systemctl enable docker

# Add yourself to the docker group (then log out and back in):
sudo usermod -aG docker $USER
# Confirm with:
docker info
```

#### G. `Cannot connect to /var/run/docker.sock` from inside the container

Container needs read-only socket access. The default compose file mounts it. If you have AppArmor or SELinux enforcing strict policies (Ubuntu 24.04+, RHEL 9+), the mount might be blocked.

```bash
# Confirm the mount is there:
docker inspect docker-dash --format '{{range .Mounts}}{{.Source}} -> {{.Destination}} ({{.Mode}}){{"\n"}}{{end}}'

# On SELinux, add the :z label:
# In docker-compose.yml change:
#   - /var/run/docker.sock:/var/run/docker.sock:ro
# to:
#   - /var/run/docker.sock:/var/run/docker.sock:ro,z
```

#### H. `no space left on device`

Disk is full — most often the Docker storage on `/var/lib/docker`.

```bash
# Reclaim space:
docker system prune -a --volumes  # destructive — review what gets removed first
df -h /var/lib/docker
```

#### I. Pull from GHCR fails with 404 or auth error

Most common reason: the package was made private or temporarily unavailable. Use the local-build path:

```bash
cd ~/docker-dash
git clone --depth 1 https://github.com/bogdanpricop/docker-dash.git .src
cp -r .src/Dockerfile .src/src .src/public .src/scripts .src/entrypoint.sh \
      .src/package.json .src/package-lock.json .src/README.md .src/LICENSE \
      .src/CONTRIBUTING.md .src/.gitignore .src/.dockerignore .
rm -rf .src
docker compose build app
docker compose up -d
```

#### J. Container says `(healthy)` but the UI returns 502 / connection refused

The reverse-proxy in front (Caddy, Nginx, Traefik) isn't routing to the container's port. Test the container directly first:

```bash
curl http://localhost:8101/api/health
# Should return: {"status":"ok","version":"8.2.x",...}

# If that works, the issue is upstream — check your proxy config.
# If it doesn't work, see Steps A-F above.
```

### Step 3 — Clean reinstall (last resort)

If you've debugged enough and just want a known-good state — and you're OK losing local Docker Dash data (audit log, custom templates, registries you added):

```bash
cd ~/docker-dash
docker compose down -v  # -v also removes the data volume
cd ..
rm -rf ~/docker-dash
curl -fsSL https://raw.githubusercontent.com/bogdanpricop/docker-dash/main/install.sh | bash
```

To preserve data, replace `down -v` with `down`, and don't delete the directory — the named volume `docker-dash-data` persists.

### Step 4 — Still stuck?

Open a [Discussion](https://github.com/bogdanpricop/docker-dash/discussions) with the **full Step 1 triage output**. Include:

- OS + version (`uname -a` and `lsb_release -a` on Ubuntu)
- Docker version (`docker --version`)
- Docker Compose version (`docker compose version`)
- Whether you used the `curl | bash` installer or `git clone + docker compose up`
- The triage output from Step 1 (redact secrets — APP_SECRET / ENCRYPTION_KEY / passwords)

For confirmed bugs, [open an Issue](https://github.com/bogdanpricop/docker-dash/issues/new) with the same info plus reproduction steps.

### What changed in v8.2.x to make installs more reliable

The install path was hardened in v8.2.x after a user reported a restart-loop on Ubuntu 25.10:

- **GHCR `:latest` tag now exists** — `install.sh` pulls a known-good pre-built image instead of falling back to git-clone+local-build.
- **`install.sh` adds `ALLOW_DEFAULT_ADMIN=true` to `.env` by default** — admin/admin works for first login (forced password change after); `FORCE_RANDOM_ADMIN_PASSWORD=1` opt-in generates a random password and prints it once.
- **`install.sh` git-clone fallback now copies all 12 files** the production Dockerfile stage requires, plus drops placeholders for any missing optional files.
- **`install.sh` patches `docker-compose.yml` with `target: production`** when the local-build fallback runs, so BuildKit doesn't waste time on the dev stage in parallel.

If you installed before these fixes landed and you're still seeing trouble, the cleanest path is **Step 3 — clean reinstall** above. The new installer picks up all the fixes.

## Architecture

### Standalone mode (default)

```
┌─────────────────┐     ┌───────────────────┐
│   Browser SPA   │────▸│  Node.js/Express  │
│  (vanilla JS)   │◂────│   REST + WebSocket│
└─────────────────┘     └────────┬──────────┘
                                 │
                    ┌────────────┼────────────┐
                    │            │            │
              ┌─────┴──────┐ ┌───┴────┐ ┌─────┴─────┐
              │  SQLite    │ │ Docker │ │  Docker   │
              │ (embedded) │ │ Local  │ │  Remote   │
              │ WAL mode   │ │ Socket │ │ TCP/SSH   │
              └────────────┘ └────────┘ └───────────┘
```

### HA mode (opt-in)

```
                  ┌─────────────────────────────────┐
                  │  Sticky-session Load Balancer   │
                  │  (Caddy / Traefik / HAProxy /   │
                  │   nginx — configs provided)     │
                  └─────────────────┬───────────────┘
                                    │
                  ┌─────────────────┼─────────────────┐
                  │                 │                 │
            ┌─────▼─────┐     ┌─────▼─────┐     ┌─────▼─────┐
            │ replica A │     │ replica B │     │ replica C │
            │  LEADER   │     │  reader   │     │  reader   │
            │ cron+WS   │     │ HTTP only │     │ HTTP only │
            │ event-    │     │           │     │           │
            │ stream    │     │           │     │           │
            └─────┬─────┘     └─────┬─────┘     └─────┬─────┘
                  │                 │                 │
                  │    ┌────────────┴────────────┐    │
                  │    │                         │    │
                  └────┤   shared SQLite volume  ├────┘
                       │  (single-writer: leader)│
                       └─────────────────────────┘
                  ┌────────────────────────────────────┐
                  │           Redis 7-alpine           │
                  │  ┌───────────┐  ┌──────────────┐  │
                  │  │ leader    │  │ rate-limit   │  │
                  │  │ lock +    │  │ INCR + PX    │  │
                  │  │ heartbeat │  │              │  │
                  │  └───────────┘  └──────────────┘  │
                  │  ┌────────────────────────────┐   │
                  │  │ ddash:pubsub (WS events)   │   │
                  │  └────────────────────────────┘   │
                  └────────────────────────────────────┘
```

One replica holds the Redis `leader` lock (30s TTL + 10s heartbeat). Leader runs cron jobs, Docker event stream, git polling. Readers serve HTTP + deliver WS events from pub/sub. Graceful handover on `docker stop` via Lua `DEL-if-owned` — failover in milliseconds. Ungraceful leader death — next heartbeat reader wins (≤30s worst case).

SSH tunnels run per-replica (readers need them to serve HTTP reads). No active-active write scale-out — SQLite stays single-writer.

| Layer | Technology |
|-------|-----------|
| Backend | Node.js 20, Express 5, dockerode, better-sqlite3, ws, ssh2, ldapts |
| Frontend | Vanilla JavaScript SPA, Chart.js, xterm.js, Font Awesome (CDN) |
| Database | SQLite with WAL mode, auto-aggregation, configurable retention |
| Security | bcrypt, Helmet CSP, rate limiting, session-based auth, Bearer token fallback |
| Scanning | Trivy (OSS), Grype (Anchore), Docker Scout (SARIF format) |

**Zero build step** — no webpack, no bundler, no transpiler. Frontend files are served as-is.

## Multi-Host

Docker Dash can manage multiple Docker hosts from a single instance:

| Method | Use Case | Requirements |
|--------|----------|-------------|
| **TCP + TLS** | Remote Linux servers | Docker API exposed on port 2376 + TLS certificates |
| **Docker Desktop** | Windows / Mac | "Expose daemon on TCP" enabled in DD Settings |
| **SSH Tunnel** | Secure remote (no API exposure) | SSH access + `socat` installed + user in `docker` group |
| **SSH to NAS** | Synology / Unraid / TrueNAS SCALE / QNAP / OMV | SSH access + admin in `docker` group. Platform auto-detected from `docker info` — dedicated How-To guide per platform |
| **Unix Socket** | Local (default) | Docker socket mounted (automatic) |

The app includes a **built-in setup guide** (Hosts page) with step-by-step instructions for each method, including TLS certificate generation, per-OS `socat` installation commands, SSH key authentication setup, and a 9-item Synology DSM 7.x security hardening checklist (added in v6.14.3).

## Podman Support

Docker Dash works with **Podman** via its Docker-compatible API. No code changes needed.

```bash
# 1. Enable the Podman socket
systemctl --user enable --now podman.socket    # rootless
# or
sudo systemctl enable --now podman.socket      # rootful

# 2. Set the socket path in .env
echo 'DOCKER_SOCKET=/run/podman/podman.sock' >> .env   # rootful
# or
echo 'DOCKER_SOCKET=/run/user/1000/podman/podman.sock' >> .env  # rootless

# 3. Start Docker Dash
docker compose up -d   # or podman-compose up -d
```

**Known differences:** Podman lacks Docker Compose labels (`com.docker.compose.project`), so containers won't auto-group into stacks. Use Docker Dash's Container Groups feature instead.

## Configuration

All config via environment variables. See [`.env.example`](.env.example) for the full list.

| Variable | Default | Description |
|----------|---------|-------------|
| `APP_PORT` | `8101` | HTTP port |
| `APP_SECRET` | — | **Required.** Session signing key |
| `ADMIN_PASSWORD` | `admin` | Initial admin password (first launch only) |
| `ENCRYPTION_KEY` | — | Encrypt registry credentials at rest |
| `STATS_INTERVAL_MS` | `10000` | Stats collection interval (ms) |
| `STATS_RAW_RETENTION_HOURS` | `24` | Keep raw stats for N hours |
| `EVENT_RETENTION_DAYS` | `7` | Keep Docker events for N days |
| `ENABLE_EXEC` | `true` | Allow terminal exec into containers |
| `DD_TERMINAL_ACCESS_OVERRIDE` | `managed` | Out-of-band terminal policy: `managed`, force `deny`, or recovery `allow` |
| `READ_ONLY_MODE` | `false` | Disable all write operations |
| `DD_PROVIDER_SDK_V2` | `true` | Expose the versioned, read-only provider capability contract and Storage Posture assessment; it never enables storage mutation, QoS enforcement or path probes |
| `DD_PROVIDER_VM_DISK_LIFECYCLE` | `false` | Opt in to reviewed VM-disk create, detach, grow and storage-move operations |
| `DD_PROVIDER_VM_DISK_DELETE` | `false` | Separately opt in to permanent deletion of a verified Docker Dash-managed detached volume |
| `DD_MODE` | *(unset — standalone)* | Set to `ha` to enable HA mode. Requires `REDIS_URL`. |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL. Only consulted when `DD_MODE=ha`. |
| `TRUST_PROXY` | `loopback` (prod) / `true` (dev) | Trusted proxy range for `X-Forwarded-*` headers. Set to your load balancer's IP/CIDR in HA. |
| `COOKIE_SECURE` | `false` | Set `true` when behind HTTPS. Required for sticky-session cookies over TLS-terminating LBs. |

## Development

```bash
# Install dependencies
npm install

# Start in development mode (auto-reload on file changes)
npm run dev

# Open http://localhost:8101
```

No build step needed. Edit any `.js` or `.css` file and refresh the browser.

## Adding a Language

Docker Dash uses a modular i18n system. To add a new language:

1. Copy `public/js/i18n/TEMPLATE.js` to `public/js/i18n/{code}.js`
2. Translate the values (keys stay in English)
3. Add one `<script>` tag in `index.html`

That's it — the language appears automatically in the selector. See [`public/js/i18n/README.md`](public/js/i18n/README.md) for full instructions.

Currently supported: **English**, **Romanian**, **German**, **Italian**, **French**, **Spanish**, **Portuguese**, **Chinese**, **Japanese**, **Korean**, **Klingon** (11 languages).

## Project Structure

```
docker-dash/
├── src/
│   ├── config/          # Environment-based configuration
│   ├── db/              # SQLite setup + 64 auto-migrations
│   ├── middleware/       # Auth, rate limiting, hostId extraction
│   ├── routes/          # REST API (containers, images, volumes, networks, swarm, hosts, ...)
│   ├── services/        # Business logic (docker, stats, alerts, ssh-tunnel, registry, ldap, cis-benchmark, ssl)
│   ├── ws/              # WebSocket server (exec, live logs, live stats)
│   └── utils/           # Logger, helpers
├── public/
│   ├── js/
│   │   ├── i18n/        # Language files (11 languages + TEMPLATE.js)
│   │   ├── pages/       # SPA pages (dashboard, containers, images, security, swarm, hosts, ...)
│   │   ├── components/  # Reusable UI (modal, toast, data table)
│   │   ├── api.js       # HTTP client with auto host-context
│   │   ├── ws.js        # WebSocket client with reconnect
│   │   └── app.js       # Router, auth, sidebar, command palette
│   └── css/app.css      # Single stylesheet, CSS variables, dark/light themes
├── docs/
│   └── screenshots/     # UI screenshots for README
├── Dockerfile           # Multi-stage: base → deps → production
├── docker-compose.yml   # Production-ready with health check
└── .env.example         # All variables documented
```

## Comparison

**60 features compared across 8 tools.** See the interactive comparison at `#/compare` in the app, or via `GET /api/compare`.

| Feature | **Docker Dash** | Portainer CE | Portainer BE | Coolify | Yacht | Rancher | Dockge | Dockhand |
|---------|:-----------:|:------------:|:------------:|:-------:|:-----:|:-------:|:------:|:--------:|
| Container CRUD | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Compose only | ✅ |
| Image / Volume / Network | ✅ | ✅ | ✅ | ✅ | partial | ✅ | No | ✅ |
| **Network Topology** | ✅ | — | — | — | — | — | — | — |
| **Dependency Map** | ✅ | — | — | — | — | — | — | — |
| Real-time Stats | ✅ | ✅ | ✅ | ✅ | basic | ✅ | basic | ✅ |
| Terminal (xterm.js) | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ |
| Vulnerability Scanning | Trivy + Grype + Scout | — | — | — | — | NeuVector | — | Grype + Trivy |
| **Safe-Pull + Pipeline** | **5-stage** | — | — | — | — | — | — | basic |
| **Container Rollback** | ✅ | — | — | ✅ | — | ✅ | — | — |
| Multi-Host (agentless) | ✅ | agent req. | agent req. | agent | — | ✅ | agent | ✅ |
| **Optional HA mode (no vendor lock-in)** | **✅ v7.0.0** | — | commercial tier | — | — | K8s-based | — | — |
| **Bundled Prometheus + Grafana + wizard** | **✅ v7.2.0** | — | — | — | — | — | — | — |
| Git Integration | ✅ | BE only | ✅ | ✅ | — | Fleet | — | — |
| Webhooks + Polling | ✅ | BE only | ✅ | ✅ | — | ✅ | — | — |
| **Docker Swarm Mode** | ✅ | ✅ | ✅ | — | — | K8s focus | — | — |
| Audit Log | ✅ | BE only | ✅ | basic | — | ✅ | — | — |
| **Alerts (7 channels)** | ✅ | BE only | ✅ | ✅ | — | ✅ | — | — |
| SSO / LDAP / OAuth | ✅ | BE only | ✅ | ✅ | — | ✅ | — | — |
| **CIS Docker Benchmark** | ✅ | — | — | — | — | partial | — | — |
| **Health Score (0-100)** | ✅ | — | — | — | — | — | — | — |
| **AI Container Doctor** | ✅ | — | — | — | — | — | — | — |
| **Resource Forecasting** | ✅ | — | — | — | — | basic | — | — |
| **Cost Optimizer** | ✅ | — | — | — | — | basic | — | — |
| **Insights Dashboard** | ✅ | — | — | — | — | basic | — | — |
| **Workflow Automation** | ✅ | — | — | — | — | — | — | — |
| **Scheduled Actions** | ✅ | — | — | — | — | — | — | — |
| **Cross-Host Migration** | zero-downtime | — | — | — | — | ✅ | — | — |
| **Public Status Page** | ✅ | — | — | ✅ | — | — | — | — |
| **Maintenance Windows** | ✅ | — | — | — | — | — | — | — |
| **API Playground** | ✅ | Swagger ($) | ✅ | ✅ | — | ✅ | — | — |
| App Templates | 33 + custom | 500+ community | 500+ | many | basic | Helm | — | — |
| i18n | **11 languages** | partial | partial | partial | — | ✅ | — | — |
| Command Palette | ✅ | — | — | — | — | — | — | — |
| Mobile Responsive | ✅ | ✅ | ✅ | ✅ | ✅ | partial | ✅ | ✅ |
| Build Step | **None** | Angular | Angular | required | none | none | required | required |
| Container Size | **~180MB** (incl. Trivy + Grype + Scout) | ~250MB | ~250MB | ~200MB | ~100MB | ~500MB+ | ~100MB | ~80MB |
| RAM Usage | **~50MB** | ~200MB | ~200MB | ~150MB | ~50MB | ~500MB+ | ~50MB | ~60MB |
| License | **MIT** | Zlib | commercial | Apache 2.0 | MIT | Apache 2.0 | MIT | BSL 1.1 |

> The comparison table flags **20+ rows** where Docker Dash ships a feature no compared free tool has — Container Doctor, Container Cloning, AI workload templates, Let's Encrypt wizard, CIS benchmark UI, registry hygiene pack with provenance + retention dry-run, hash-chained off-site audit dumps, etc. Coverage gaps cut both ways: Portainer wins on Kubernetes ergonomics, Komodo wins on multi-server orchestration UX. Pick the tool that fits *your* workflow.
>
> Features Portainer Business locks behind paid license are **free** in Docker Dash.
> Rancher / K3s targets Kubernetes clusters; Docker Dash targets single-host and small multi-host Docker deployments.

### Targeted comparisons

For a deeper one-on-one breakdown of "Pick X if Y, pick Docker Dash if Z":

- **[Docker Dash vs Portainer](docs/comparisons/vs-portainer.md)** — the dominant Docker UI; free CE (BSL 1.1) vs paid Business
- **[Docker Dash vs Dockge](docs/comparisons/vs-dockge.md)** — minimal Compose-focused alternative
- **[Docker Dash vs Komodo](docs/comparisons/vs-komodo.md)** — fleet GitOps multi-server vs single-host depth

Index: [`docs/comparisons/`](docs/comparisons/).

## License

[MIT](LICENSE) — free for personal and commercial use.

## Security

Docker Dash takes security seriously. See [SECURITY.md](SECURITY.md) for our full security policy.

### Docker Socket Access

Docker Dash requires access to the Docker socket (`/var/run/docker.sock`). This is **equivalent to root access** on the host. This is the same requirement as Portainer, Dockge, and all other Docker management UIs.

**Mitigations in place:**
- Socket mounted **read-only** (`:ro`) in production docker-compose
- `no-new-privileges` security option enabled
- Role-based access control (admin/operator/viewer)
- Feature flags to disable dangerous operations (`ENABLE_EXEC=false`, `READ_ONLY_MODE=true`)
- Audit log for every action with user, timestamp, and IP
- Rate limiting on all API endpoints
- Session-based auth with bcrypt + SHA-256 hashed tokens

**Recommendations for production:**
- Deploy behind HTTPS reverse proxy (Caddy config included)
- Set strong `APP_SECRET` and `ENCRYPTION_KEY` (app refuses to start without them)
- Set `COOKIE_SECURE=true` when behind HTTPS
- Disable exec terminal if not needed (`ENABLE_EXEC=false`)
- Use read-only mode for monitoring-only deployments (`READ_ONLY_MODE=true`)
- Restrict network access to trusted IPs
- Consider [docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) to limit API access (allow only read operations)
- Review [SECURITY.md](SECURITY.md) for responsible disclosure process

### Security Audit Results

| Audit | Date | Score | Critical Issues |
|-------|------|-------|----------------|
| Tech Debt Scan | 2026-03-27 | 33 items found | All 4 CRITICAL fixed |
| Production Readiness v5 | 2026-03-28 | 8.05/10 weighted (claimed 9.2) | All P0+P1 resolved |
| Shell Injection | 2026-03-28 | 0 vectors | All execSync eliminated |
| Production Readiness v6.15.1 | 2026-04-22 | 9.1/10 (defensible weighted) | v5 gaps closed: error-response sanitization on all 500s (v6.14.1), expanded Prometheus metrics with job counters populated (v6.15.0–v6.15.1), setInterval leak fixed, CI test count dynamic, X-Frame-Options: DENY + Permissions-Policy, 0 lint warnings |
| Production Readiness v6.16.0 | 2026-04-22 | 9.5/10 | Phase 2 shipped: `containers.js` (5774 lines, largest JS file) split into list-eager (3226 lines) + detail-lazy (2595 lines loaded on first `/containers/:id` navigation via script injection). Performance category 7 → 9, initial JS payload −45% for users not visiting a container detail page. 757 tests unchanged |
| Production Readiness v6.16.1 | 2026-04-22 | **9.7/10** | Testing 8.5 → 9.5 (+86 tests across 4 previously-untested services: permissions RBAC, settings CRUD, security-alerts rule evaluation, event-notifier dispatch). Documentation 9 → 9.5 (3 new feature reference docs under `docs/features/`: Prometheus metrics, platform detection, translations tooling). Residual: Docker-in-Docker integration tests (v7), Redis HA mode (v7), external 3rd-party audit (v7) — 10/10 requires all three |
| Production Readiness v7.0.0 | 2026-04-22 | **9.8/10** | HA mode production-ready: opt-in `DD_MODE=ha` + Redis. 4-phase rollout (v6.17.0 rate limiter, v6.17.1 WS pub/sub, v6.17.2 leader election, v7.0.0 observability + operator runbook + LB configs). Standalone default unchanged. Staging soak verified: 3-replica deploy with lock acquire, graceful leader handover, Redis restart recovery. `/api/cluster/status` + 4 Prometheus gauges. BACKLOG F30 closed. Residual gap to 10: external 3rd-party security audit (budget + vendor coordination) |
| v7.1.0–v7.2.0 | 2026-04-22 | **9.8/10** | Observability bundle shipped: opt-in Prometheus + Grafana compose profile with 8-panel auto-provisioned dashboard (v7.1.0), then in-app wizard at **System → Observability** that detects existing monitoring stacks and offers integrate/deploy/hybrid paths with one-click dashboard import via Grafana API (v7.2.0). Admin-only, 10s outbound timeout, tokens never persisted. 28 new tests. No production-readiness score change — UX layer on top of v7.0.0's foundation |
| v7.3.0–v7.7.0 | 2026-04-25 | **9.8/10** | UX + workflow shipped: in-app update notifications via GitHub releases polling (v7.3.0), session-expiry recovery (v7.3.1), Express 5 + path-to-regexp v8 migration (v7.3.x), sample plugin + CONTRIBUTING.md (v7.4.0), image registry workflow — push/browse/template (v7.5.0), registry delete-by-digest with two-step confirmation (v7.6.0), CI lint enforcement (v7.7.0). All admin-gated, all audited |
| v8.0.0 — AI features (BYOK) | 2026-04-27 | **9.8/10** | First feature category with optional outbound traffic to non-user-controlled hosts. Strategy-first deep-spec + 5 spikes ran before code; redactor S4 validated 100/100 on 27-case corpus before integration. Provider abstraction (Anthropic / OpenAI / Ollama), BYOK only, off by default. Audit log NL search ships first; vulnerability + incident triage gated on production signal. Every AI call writes audit entry with provider, model, token counts, redaction counts per pattern, SHA-256 payload hash. 63 new tests |
| v8.1.0 — Registry Hygiene Pack | 2026-04-29 | **9.8/10** | Build provenance panel surfacing OCI annotations + cosign signature presence (read-only, zero new state). Retention policies with five safety layers: default-disabled (dry-run only), min-3-tags hard floor, default protected patterns latest/v\*/main/master/prod-\*/stable, server cap 200 deletions/run, audit per delete. Remote/virtual repos via Distribution proxy (Docker Hub rate-limit relief + offline operation). 58 new tests, all 5 safety layers regression-tested |
| v8.2.0 — pCloud backup + off-site archives | 2026-05-05 | **9.8/10** | Third backup target alongside local + S3. AES-256-GCM encrypted token storage. Quota-aware uploads (95% pre-flight check + 50 MB safety margin). Hash-chained audit log monthly dumps preserve `entry_hash`/`prev_hash` row-for-row across months — consecutive dumps form a continuous off-site witness if the live DB is later tampered. Streaming export via `stmt.iterate()` handles 50k+ row months without buffer growth. 40 new tests including end-to-end gzip → upload → download → gunzip → chain-walk verification |
| v8.2.x — Post-release brutal audit + full remediation | 2026-05-05 | **9.9/10** | Honest re-audit of production-readiness after v8.2.0 ship. 22 issues identified, ALL CLOSED in 8 waves. Highlights: 14 services now with ≥15 dedicated tests each (1122 → 1356 = +234 tests, 70 → 80 suites); 84 built-in How-To guides extracted from SQL migrations to 132 markdown files via auto-extraction script; **dockerode 4 → 5 migration** (zero-vulnerability install — was tracked as deferred CVE in audit §7); **all third-party CDN dependencies eliminated** — Chart.js + xterm.js + xterm-addon-fit + FontAwesome (CSS + 8 webfont files) all served from `/lib/` and `/webfonts/`, CSP tightened to strict `'self'` (no third-party origins allowed); ESLint rule banning inline `onclick=` enforced (9 historical violations refactored to delegated handlers); `system.js` 6011 → 5594 LOC (Egress section extracted to `system-egress.js` 462 LOC, merged via `Object.assign`); **a11y at component level** — Modal (role=dialog + aria-modal + aria-labelledby + focus restore on close + Escape key) + Toast (role=alert/status with aria-live=assertive/polite per severity + aria-atomic) — every modal and toast in the app benefits at once; CLAUDE.md at repo root; 3 targeted vs-product comparison pages (Portainer/Dockge/Komodo); template `verified_at` + `deprecated_in_favor_of` trust signals; telemetry scaffold (off by default); Grafana + Prometheus observability profile live on the public VPS at `:3015` (eat own dog food). |

### Known Security Tradeoffs

These are conscious design decisions documented in [SECURITY.md](SECURITY.md):

1. **CSP allows `unsafe-eval`** (but NOT `unsafe-inline`) — `unsafe-eval` required by Chart.js. All 67 inline handlers were converted to addEventListener in v5.0. XSS mitigated by output escaping on all user content (400+ `escapeHtml()` calls).
2. **WebSocket accepts token via query string** — fallback for browsers that block cookies (Edge Tracking Prevention). Cookie-based auth is always preferred. Usage is logged.
3. **Mixed auth model (cookie + Bearer + API key)** — cookies for browser UI, Bearer for API/CLI, API keys for integrations. All validate against the same session store.

### Test Coverage

- **1398 tests** across **83 test suites** (100% passing — 4 skipped are live-CF ACME integration tests gated on a CI secret)
- Unit tests: crypto, helpers, validation, git patterns, platform detection, DMI cloud detection, translations, filter escape, metrics rendering, AI redactor (33 cases), audit-actions enum extraction, retention pure-evaluator (27 cases), provenance parser (15 cases), pCloud HTTP client (16 cases)
- Integration tests: auth flow, API endpoints, RBAC, security, ACME + remediation orchestrators, registry push + browse + delete + retention apply, AI provider abstraction with MockAiProvider, pCloud backup orchestration (14 cases), audit-log monthly dump with hash-chain integrity round-trip (gzip → upload → download → gunzip → chain-walk)
- Service tests: permissions RBAC filtering, settings key-value CRUD, security alert rule evaluation (threshold + windowed), event notifier dispatch + cooldown, cluster abstraction (HA mode), rate-limiter memory + Redis paths, registry repos CRUD
- CI runs on every push via GitHub Actions (pinned to Node 24 actions as of v6.13.1; test count reported dynamically in the CI summary as of v6.15.0; lint enforcement added in v7.7.0 — fails on any warning or error)

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for:
- Development setup
- Architecture principles (no build step, no framework)
- How to add pages, API endpoints, database migrations
- How to add a language translation
- Pull request checklist

## Acknowledgments

Built with:
- [dockerode](https://github.com/apocas/dockerode) — Docker API client
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — SQLite driver
- [xterm.js](https://xtermjs.org/) — Terminal emulator
- [Chart.js](https://www.chartjs.org/) — Charts
- [Trivy](https://trivy.dev/) — Vulnerability scanner
- [Grype](https://github.com/anchore/grype) — Vulnerability scanner by Anchore
- [ssh2](https://github.com/mscdex/ssh2) — SSH client
- [Font Awesome](https://fontawesome.com/) — Icons
