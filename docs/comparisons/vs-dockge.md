# Docker Dash vs Dockge — honest comparison

## TL;DR

- Dockge wins on minimalism: a focused, single-purpose Compose stack manager with a clean Svelte UI from the author of Uptime Kuma.
- Docker Dash wins on breadth: it covers the full Docker host — containers, images, volumes, networks, security scanning, audit, multi-host, HA, backup.
- They are not the same kind of tool. Dockge is "Compose, done well." Docker Dash is "the whole Docker dashboard."

## What Dockge does better

- **Focused scope.** Dockge is unambiguous about what it is — a Compose stack manager. No registry browser, no CIS benchmark, no Prometheus wizard. If your mental model is "I edit `docker-compose.yml` and bring stacks up and down," Dockge maps to that exactly.
- **UX simplicity.** Fewer pages, fewer settings, less to learn. Stacks list, editor, terminal, done. Onboarding is essentially zero.
- **Smaller install.** Dockge's image is significantly smaller than Docker Dash's, because it bundles less (no scanners, no SQLite reporting layer, no metrics).
- **Integrated with the louislam ecosystem.** If you already run Uptime Kuma, Dockge feels like a sibling — same author, similar UX language, similar self-hosted ethos.
- **Reactive UI.** Svelte gives a snappy, modern feel; the initial load is faster than Docker Dash's SPA on cold starts.

## What Docker Dash does that Dockge doesn't try to do

Docker Dash is a different shape of tool. It deliberately covers ground Dockge intentionally leaves out:

- Multi-host management (TCP+TLS, SSH tunnel, Docker Desktop, NAS auto-detection for Synology/Unraid/TrueNAS/QNAP/OMV).
- Vulnerability scanning with Trivy + Grype, Safe-Pull pipelines, deployment history. [Docker Scout is temporarily excluded for security reasons](../audits/2026-09-20-scout-exclusion.md).
- Container Remediation Wizard turning audit findings into compose patches with auto-rollback.
- CIS Docker Benchmark with 18 automated checks and remediation guidance.
- Hash-chained immutable audit log with CSV/JSON/Syslog export, plus AI natural-language audit search (BYOK, opt-in).
- Optional HA mode (`DD_MODE=ha`) with Redis leader election, sticky-session LB configs, Prometheus cluster metrics.
- Bundled Prometheus + Grafana observability wizard with auto-provisioned dashboards.
- Let's Encrypt wizard (DNS-01 + HTTP-01) with encrypted credential vault.
- Registry workflow: push from Images page, browse, manifest inspect, delete-by-digest, plus the Hygiene Pack (provenance, retention with dry-run, remote/virtual repos).
- Outbound Network Filter sidecar with allowlist egress policy.
- LDAP/AD, SSO (Authelia/Authentik/Caddy/Traefik), TOTP/MFA, RBAC.
- Workflow Automation, Scheduled Actions, Maintenance Windows, Alerts across 7 channels.
- Cost Optimizer, Resource Forecasting, Health Score, Dependency Map, Network Topology.
- pCloud + S3 + local backup targets with quota-aware uploads and monthly hash-chain audit dumps.
- 84+ bilingual How-To Guides, 47 app templates including a 12-template AI workload pack.

Dockge does none of these — and that is a feature, not a bug. It chose scope and stuck to it.

## License

Docker Dash is MIT. Dockge is Apache 2.0. Both are permissive, both allow commercial use, neither imposes copyleft. License is not a meaningful differentiator here.

## Performance and footprint

| | Docker Dash | Dockge |
|---|---|---|
| Image size | Varies by build/platform; includes Trivy + Grype | ~30–50 MB |
| RAM idle | ~50 MB | ~30–50 MB |
| Default port | 8101 | 5001 |
| Build step | None (vanilla JS, served as-is) | Vite + Svelte build |
| Backend | Node 20 + Express 5 + better-sqlite3 | Node + Socket.IO |
| Storage | SQLite (WAL) | Filesystem (compose files on disk) |

## Pick Dockge if...

- You only want Compose stack management. Editor, up/down, logs, terminal — and nothing else cluttering the sidebar.
- You don't have multiple Docker hosts and don't plan to. A single-host Compose-first workflow is your whole world.
- You value UX minimalism over breadth, and you'd rather glue together small tools (Uptime Kuma + Dockge + your own scripts) than run one larger dashboard.

## Pick Docker Dash if...

- You need security scanning, audit log, and remediation as part of the same dashboard — not as separate tools you have to wire together.
- You run multiple Docker hosts, or you need optional HA with leader election and a sticky-session LB for an always-on internal panel.
- You want a single dashboard that covers everything Docker on the host: containers, images, volumes, networks, swarm, registry, backup, monitoring, alerts.

## Migration notes

Both tools talk to the same Docker socket, and both work with standard `docker-compose.yml` files. Switching is config-only — no container rebuilds, no image migration, no data lock-in. Compose files Dockge wrote are valid input for Docker Dash's Stacks page, and vice versa. You can run both side by side on the same host while you decide.

Or run both — Dockge for Compose-first ops, Docker Dash for the rest.
