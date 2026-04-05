/* ═══════════════════════════════════════════════════
   pages/whatsnew.js — What's New / Changelog
   ═══════════════════════════════════════════════════ */
'use strict';

const WhatsNewPage = {

  // ─── Changelog Data ──────────────────────────────
  // Add new releases at the TOP of this array.
  // Types: feature, fix, improvement, security, breaking
  _releases: [
    {
      version: '5.5.0',
      date: '2026-04-05',
      title: 'Sandbox Mode — Ephemeral & Isolated Containers',
      changes: [
        { type: 'feature', text: 'Sandbox Mode — launch containers with resource limits, network isolation, and auto-cleanup; two modes: Ephemeral (auto-delete on stop + TTL) and Persistent Sandbox (isolated but survives restart)' },
        { type: 'feature', text: 'Sandbox launch modal — image selector, mode toggle, TTL (30m/1h/4h/off), RAM limit (256MB-2GB), CPU limit (0.25-2 cores), isolated network checkbox, auto-open terminal' },
        { type: 'feature', text: 'Run in Sandbox from Images page — per-image flask button to instantly launch a sandbox with that image pre-filled' },
        { type: 'feature', text: 'Sandbox badges in containers list — EPHEMERAL (red + countdown) or SANDBOX (yellow) badges with colored left border for visual distinction' },
        { type: 'feature', text: 'Sandbox info card in container detail — shows mode, remaining TTL, limits, user; Extend +1h and Stop & Remove buttons' },
        { type: 'feature', text: 'TTL auto-cleanup — background timer removes expired sandbox containers every 30 seconds with toast notification via WebSocket' },
        { type: 'security', text: 'Sandbox security defaults — no-new-privileges, restart:no, dedicated dd-sandbox internal bridge network, no Docker socket, no privileged mode' },
      ],
    },
    {
      version: '5.4.0',
      date: '2026-04-05',
      title: 'Lazydocker Inspiration Wave — 7 UX + AI Features',
      changes: [
        { type: 'feature', text: 'One-click port access — each exposed TCP port in the containers list gets a clickable external-link button that opens http(s)://host:port directly in a new tab' },
        { type: 'feature', text: 'Log time filter — "since" dropdown (All time / Last 1h / 6h / 24h / 7d) added to the container log viewer toolbar' },
        { type: 'feature', text: 'Keyboard navigation — Arrow Up/Down to move between container rows, Enter to open detail, r to restart, s to stop/start, l to jump to Logs tab' },
        { type: 'feature', text: 'Live CPU/RAM mini-bars — two 4px color bars per running container row, updated every 5 s from /stats/overview; green→yellow→red by usage' },
        { type: 'feature', text: 'Dual AI provider (OpenAI + Ollama) — Container Doctor "Copy AI Prompt" button replaced with a provider selector + "Ask AI" button that calls OpenAI or a local Ollama instance and shows the response inline in the modal' },
        { type: 'feature', text: 'Image layer visualization — new Layers button (<i class="fas fa-layer-group"></i>) in the images table opens a modal with all image layers, command, size, and relative-size bar per layer' },
        { type: 'feature', text: 'Generate docker-compose from GitHub — new "From GitHub" button in Containers; paste a public repo URL + AI provider config, Docker Dash fetches README/package.json/etc. and generates a production-ready docker-compose.yml' },
      ],
    },
    {
      version: '5.3.1',
      date: '2026-04-05',
      title: 'Security UX Polish + Actions Guides + Fix Round',
      changes: [
        { type: 'feature', text: 'Stack-level security buttons — Security Scan and CIS Benchmark directly from the stack header in Containers' },
        { type: 'feature', text: 'Security Scan detail overlay — View Details per image opens a full CVE breakdown over the scan modal without closing it' },
        { type: 'feature', text: 'CIS Benchmark card in Security overview — run benchmark and see stack score without leaving the Security page' },
        { type: 'feature', text: 'CIS Benchmark link in Security page header — one click to System > CIS Benchmark tab' },
        { type: 'feature', text: 'Actions Guide (i button) in Containers and Images — full overlay reference for every action, 2-column layout' },
        { type: 'feature', text: 'Generated docker-compose.yml from container metadata — View Composer shows best-effort YAML with "Generated" notice when no real file exists' },
        { type: 'feature', text: 'Comparison table sticky header + footer — column headers and legend always visible while scrolling; table scrolls in its own viewport' },
        { type: 'improvement', text: 'CIS Benchmark sub-tabs (Guide, Daemon, Containers, All) + per-container hardened compose generator' },
        { type: 'improvement', text: 'Template images now load — CDN (cdn.jsdelivr.net) added to Content Security Policy imgSrc' },
        { type: 'improvement', text: 'Version display fixed in System > Info and About — now reads from src/version.js (mounted volume) instead of baked package.json' },
        { type: 'improvement', text: 'Scan History eye button fixed — view-scan event listeners were dead code after a return statement' },
        { type: 'improvement', text: 'Image scan menu fixed — event.currentTarget pointed to table instead of button due to delegation; scan dropdown now positions correctly' },
        { type: 'improvement', text: 'Grype added to image scan menu (was missing alongside Trivy and Docker Scout)' },
        { type: 'fix', text: 'Actions Guide overlay background transparent on light theme — replaced missing --card-bg with --surface' },
        { type: 'fix', text: 'CIS Benchmark button in Security header used inline onclick (blocked by CSP scriptSrcAttr none) — replaced with event listener' },
        { type: 'fix', text: 'Grype install instructions appeared below the divider (looked like Docker Scout docs) — separator moved correctly' },
      ],
    },
    {
      version: '5.3.0',
      date: '2026-04-04',
      title: 'Docker Swarm + Extended Comparison (8 tools)',
      changes: [
        { type: 'feature', text: 'Docker Swarm mode — full UI for Nodes, Services, Tasks; init/leave swarm, scale services, join tokens, drain nodes' },
        { type: 'feature', text: 'Swarm beginner guide card — explains Nodes, Services, Tasks, Overlay Networks with CLI example' },
        { type: 'feature', text: 'Swarm official docs card — 5 direct links to Docker documentation' },
        { type: 'feature', text: 'Extended comparison matrix — 4 new tools: Coolify, Yacht, Rancher, Portainer Business (8 tools total, 60 features)' },
        { type: 'feature', text: 'Comparison table sticky first column — feature name stays visible while scrolling 8 columns' },
        { type: 'improvement', text: 'Nav "Swarm" translation added to all 11 locale files' },
        { type: 'fix', text: 'Latency middleware crash (ERR_HTTP_HEADERS_SENT) on streamed static file responses' },
      ],
    },
    {
      version: '5.2.0',
      date: '2026-04-03',
      title: 'SSL Zero-Config + LDAP/AD + App Logos + Swarm Backend',
      changes: [
        { type: 'feature', text: 'SSL zero-config — Caddy sidecar auto-reload via shared volume; enable HTTPS from UI with one click, no manual container restarts' },
        { type: 'feature', text: 'LDAP / Active Directory sync — bind, user search, group filter, attribute mapping; auto-provisions local accounts on first login' },
        { type: 'feature', text: 'App marketplace logos — walkxcode/dashboard-icons CDN integration with FontAwesome fallback' },
        { type: 'feature', text: 'CIS Docker Benchmark tab — 18 checks (6 daemon + 12 container), scored report with remediation hints' },
        { type: 'improvement', text: 'System page tabs wrap on small screens (phone/RDP) — flex-wrap on .tabs' },
        { type: 'fix', text: 'SQLite datetime("now") bug in registry.js and pipeline.js — double-quoted identifiers were interpreted as column names' },
      ],
    },
    {
      version: '5.1.0',
      date: '2026-04-02',
      title: 'Registry Edit + Pull Registry Dropdown + SSH Key Guide',
      changes: [
        { type: 'feature', text: 'Docker Registry edit — full edit modal pre-populated with existing data; was a stub before' },
        { type: 'feature', text: 'Registry test shows repo count — 0 repositories = red failure (not success)' },
        { type: 'feature', text: 'Pull Image registry dropdown — 7 presets (Docker Hub, GHCR, MCR, Quay, ECR Public, GCR, Custom) with prefix auto-fill' },
        { type: 'feature', text: 'SSH Key authentication guide on Hosts page — 3-step guide (keygen → ssh-copy-id → paste) per Linux distro' },
        { type: 'improvement', text: 'Comparison matrix updated with Rancher, Coolify, Yacht, Portainer Business parity data' },
      ],
    },
    {
      version: '5.0.5',
      date: '2026-03-31',
      title: 'Template Configurator + Euro-Office Templates',
      changes: [
        { type: 'feature', text: 'Dynamic Template Configurator — auto-detects configurable fields, smart forms (passwords, ports, toggles), live YAML preview' },
        { type: 'feature', text: 'Password generator with length slider (8-256 chars), strength indicator, weak default warnings' },
        { type: 'feature', text: '3 Euro-Office templates — Document Server, Euro-Office + Nextcloud, Dev Stack comparison' },
        { type: 'feature', text: 'Cost Optimizer — Recommendations and Cost Breakdown on separate tabs' },
        { type: 'feature', text: '3-button template UX: View (eye), Configure (sliders), Deploy (rocket)' },
        { type: 'feature', text: 'Podman compatibility — configurable socket path, documented setup' },
        { type: 'fix', text: 'Container filter no longer persists as ghost filter after navigation' },
        { type: 'fix', text: 'MFA login: session cookie no longer set before TOTP verification' },
        { type: 'fix', text: 'CSP: eliminated unsafe-inline from scriptSrc (67 inline handlers converted)' },
        { type: 'security', text: 'API key permissions enforced in auth middleware (read-only keys blocked from mutations)' },
        { type: 'security', text: 'Rate limiting on public password reset endpoints' },
        { type: 'improvement', text: '33 built-in templates, 384 tests, all audit findings resolved' },
      ],
    },
    {
      version: '5.0.0',
      date: '2026-03-29',
      title: 'Enterprise Security Hardening',
      changes: [
        { type: 'security', text: 'Enterprise Security Mode — SECURITY_MODE=strict flag toggles all hardening (cookie-only auth, forced HTTPS, 8h sessions, password expiry)' },
        { type: 'security', text: 'TOTP/MFA — two-factor authentication with zero dependencies (RFC 6238), encrypted secrets, 10 recovery codes' },
        { type: 'security', text: 'Immutable hash-chained audit log — SHA-256 chain, tamper detection, JSON/CSV/Syslog export' },
        { type: 'security', text: 'Security event alerting — 5 default rules (brute force, admin created, MFA disabled), threshold detection, 7 notification channels' },
        { type: 'feature', text: '14 developer tools — Password Generator, Hash Generator, IP Calculator, JSON Formatter, Regex Tester, Text Diff, and more' },
        { type: 'feature', text: 'HTML ↔ Markdown converter tools with live preview' },
        { type: 'feature', text: 'Klingon pIqaD font integration with full easter egg experience' },
        { type: 'fix', text: 'Dependency Map layout — containers no longer overlap (improved force simulation)' },
        { type: 'fix', text: 'Port Reference expanded to 57 ports (Docker, K8s, MQTT, RDP, etc.)' },
        { type: 'improvement', text: 'External audit findings addressed — 6 security tradeoffs fully documented, deployment recommendations table' },
        { type: 'improvement', text: '384 tests across 29 test files (100% passing)' },
      ],
    },
    {
      version: '4.2.0',
      date: '2026-03-28',
      title: '20 New Features — Full Platform Upgrade',
      changes: [
        { type: 'feature', text: 'Image pull progress — real-time streaming per-layer progress bars via SSE' },
        { type: 'feature', text: 'Resource limits editor — visual sliders with presets (256MB/512MB/1GB/2GB, 0.5/1/2/4 CPU)' },
        { type: 'feature', text: 'Bulk container actions — checkboxes + floating action bar for batch start/stop/restart/remove' },
        { type: 'feature', text: 'Theme & language sync per user — saved server-side, synced across devices' },
        { type: 'feature', text: 'Container file browser — navigate, view, download files inside running containers' },
        { type: 'feature', text: 'Docker Compose editor — edit, validate, save & deploy compose configs inline' },
        { type: 'feature', text: 'Scheduled actions — cron-based automation with presets, history, run-now, enable/disable' },
        { type: 'feature', text: 'Container diff — see filesystem changes vs base image with color-coded entries' },
        { type: 'feature', text: 'Container rollback — one-click revert to previous image, with version history' },
        { type: 'feature', text: 'Notifications center — dedicated page with filters, pagination, bulk actions' },
        { type: 'feature', text: 'Dashboard customizable — toggle widget visibility, order saved to server' },
        { type: 'feature', text: 'Stacks page — unified Compose + Git stacks management' },
        { type: 'feature', text: 'Container groups — user-defined grouping with colors, beyond compose projects' },
        { type: 'feature', text: 'API Playground — browse and test all API endpoints from the UI with response viewer' },
        { type: 'feature', text: 'AI Container Doctor — diagnostics + log pattern matching + AI prompt generator' },
        { type: 'feature', text: 'Cost Optimizer — per-container cost breakdown, idle detection, savings recommendations' },
        { type: 'feature', text: 'Dependency Map — interactive canvas graph showing container relationships' },
        { type: 'feature', text: 'Deployment Pipelines — staged pull → scan → swap → verify → notify with history' },
        { type: 'feature', text: 'Mobile responsive — full UI on phone/tablet with 360px-768px breakpoints' },
        { type: 'improvement', text: '5 new DB migrations (024-028), 6 new pages, 3 new backend services' },
      ],
    },
    {
      version: '4.1.0',
      date: '2026-03-28',
      title: 'Grype Scanner, Custom Templates, UX Polish',
      changes: [
        { type: 'feature', text: 'Grype vulnerability scanner — third scanner option alongside Trivy and Docker Scout (Anchore open-source)' },
        { type: 'feature', text: 'Custom templates — add, edit, delete your own app templates (System > Templates)' },
        { type: 'feature', text: 'Built-in template overrides — modify default templates with modification tracking (who, when)' },
        { type: 'feature', text: 'Template preview — view docker-compose.yml before deploying, with Copy and Deploy buttons' },
        { type: 'feature', text: 'Container health score dot — color-coded indicator in list view (green/yellow/orange/red)' },
        { type: 'feature', text: 'Container summary bar — total, running, stopped, needs attention counts with clickable filters' },
        { type: 'feature', text: 'Host info bar on dashboard — hostname, CPUs, RAM, Docker version, storage driver, uptime' },
        { type: 'feature', text: 'Container detail tabs: Labels (grouped), Mounts, Network with port bindings' },
        { type: 'security', text: 'Unified password policy — validatePassword() enforced on all 4 password flows' },
        { type: 'fix', text: 'Export Container Configuration dialog no longer closes immediately' },
        { type: 'fix', text: 'System > Templates tab now loads correctly (duplicate API method removed)' },
        { type: 'fix', text: 'Container list summary bar spans full width in 2-column layout' },
        { type: 'fix', text: 'Dockerfile healthcheck uses configurable APP_PORT' },
        { type: 'improvement', text: 'Caddyfile converted to generic template with setup instructions' },
        { type: 'improvement', text: 'About page with GitHub link and author info' },
        { type: 'improvement', text: 'README and docs consistency fixes (template count, retention days, badges)' },
      ],
    },
    {
      version: '4.0.0',
      date: '2026-03-28',
      title: 'Complete Docker Management Platform',
      changes: [
        { type: 'feature', text: 'Insights page — executive dashboard with health scores, recommendations, stale images, system footprint' },
        { type: 'feature', text: 'Compare page — interactive 60-feature matrix vs Portainer/Dockge/Dockhand with search' },
        { type: 'feature', text: 'Templates browser — 30 curated apps with search, filter, one-click deploy (System > Templates)' },
        { type: 'feature', text: 'Workflows manager — create/manage IF-THEN automation rules (Settings > Workflows)' },
        { type: 'feature', text: 'Password reset dialog — admin resets passwords directly, auto-logout on own password change' },
        { type: 'feature', text: 'Container rename, Safe Update (Trivy scan before swap), Diagnose (8-step wizard)' },
        { type: 'feature', text: 'Clickable dashboard charts — click bar → navigate to container detail' },
        { type: 'feature', text: 'Live container count badge in sidebar (running/total via WebSocket)' },
        { type: 'feature', text: 'Keyboard shortcuts — ? help, g+key vim-style navigation, Ctrl+K command palette' },
        { type: 'feature', text: 'Professional error boundary — catches all errors with crash recovery overlay' },
        { type: 'feature', text: 'System overview API (/api/overview), API docs (/api/docs), audit CSV export' },
        { type: 'feature', text: 'Daily auto-backup (cron 02:00, keeps 7 days), database backup button' },
        { type: 'feature', text: 'Dark mode toggle on login page, OS theme auto-detection' },
        { type: 'feature', text: 'Connection status indicator in sidebar footer' },
        { type: 'fix', text: 'Login error message now shows on wrong password (was silently failing)' },
        { type: 'fix', text: 'Password reset uses bcrypt hash (was saving unhashed)' },
        { type: 'fix', text: 'APP_SECRET validation false positive fixed' },
        { type: 'security', text: '104 tests (100% passing), production readiness 9.2/10' },
        { type: 'security', text: 'Strong APP_SECRET + ENCRYPTION_KEY enforced on production' },
        { type: 'improvement', text: 'SECURITY.md, CHANGELOG.md, CONTRIBUTING.md fully updated' },
        { type: 'improvement', text: 'GitHub release, discussions, issue templates, 12 topics' },
      ],
    },
    {
      version: '3.8.0',
      date: '2026-03-27',
      title: 'Tech Debt Payoff — Security Hardening & Code Quality',
      changes: [
        { type: 'security', text: 'Input validation middleware — validateId, validateBody, sanitizeBody with prototype pollution protection' },
        { type: 'security', text: 'Git deploy/push rate limiting — max 5 operations per minute per IP' },
        { type: 'security', text: 'Enhanced central error handler — sanitizes file paths and credentials from error messages' },
        { type: 'security', text: '5xx errors no longer leak internal details to clients' },
        { type: 'security', text: 'SSH key cleanup on startup — removes stale keys older than 24h' },
        { type: 'fix', text: 'Unguarded JSON.parse replaced with safe tryParseJson across all routes' },
        { type: 'fix', text: 'console.log in database migrations replaced with structured logger' },
        { type: 'improvement', text: 'New utility functions: sanitizeShellArg, safeParseInt, safeJsonParse' },
        { type: 'improvement', text: 'Dead code removed from migration service and container routes' },
      ],
    },
    {
      version: '3.7.0',
      date: '2026-03-27',
      title: 'Event Notifications, Global Search, Dependency Graph',
      changes: [
        { type: 'feature', text: 'Event-Driven Notifications — container crash, OOM kill, health check failure automatically sent to Discord/Slack/Telegram' },
        { type: 'feature', text: 'Smart event filtering — only important events (die, oom, kill, unhealthy) trigger notifications, with 1-min cooldown' },
        { type: 'feature', text: 'Event-specific messages — exit code 137 explains OOM, exit code 1 suggests checking logs' },
        { type: 'feature', text: 'Workflow evaluation on events — IF-THEN rules evaluated on container crash/unhealthy/restart' },
        { type: 'feature', text: 'Global Search API — search across containers, images, volumes, networks, Git stacks, audit log' },
        { type: 'feature', text: 'Search returns up to 30 results with type icons, links, and detail previews' },
        { type: 'feature', text: 'Container Dependency Graph — network-based relationship mapping between containers' },
        { type: 'feature', text: 'Dependency graph shows stack groupings, network edges, and per-container ports' },
        { type: 'improvement', text: 'Event notifier hooks into existing Docker event stream (zero overhead)' },
      ],
    },
    {
      version: '3.6.0',
      date: '2026-03-27',
      title: 'Stack Export/Import — Portable Infrastructure Bundles',
      changes: [
        { type: 'feature', text: 'Stack Export — export entire compose stack as a portable JSON bundle (config, env, volumes, ports, labels)' },
        { type: 'feature', text: 'Container Export — export single container config as a bundle' },
        { type: 'feature', text: 'Stack Import — upload a bundle and deploy on any host with one click' },
        { type: 'feature', text: 'Import Preview — validate bundle contents before importing (images, volumes, ports, env count)' },
        { type: 'feature', text: 'Generate Compose — auto-generate docker-compose.yml from any bundle' },
        { type: 'feature', text: 'Download bundle as .json file for sharing/backup' },
        { type: 'feature', text: 'Auto-pull images on import — no need to pre-pull' },
        { type: 'feature', text: 'Name conflict resolution — auto-renames on import if container exists' },
        { type: 'feature', text: 'Import labels — imported containers tagged with source info and timestamp' },
        { type: 'feature', text: 'Volume auto-creation on import' },
        { type: 'feature', text: 'Optional name prefix for imported containers' },
        { type: 'improvement', text: 'Compose internal labels stripped from export (clean bundles)' },
        { type: 'security', text: 'Admin-only import with full audit logging' },
      ],
    },
    {
      version: '3.5.0',
      date: '2026-03-27',
      title: 'Cross-Host Migration with Zero-Downtime',
      changes: [
        { type: 'feature', text: 'Cross-host container migration — move containers between Docker hosts with full config preservation' },
        { type: 'feature', text: 'Zero-downtime migration — destination starts before source stops, verified healthy before cutover' },
        { type: 'feature', text: 'Stack migration — migrate all containers in a compose stack at once' },
        { type: 'feature', text: 'Migration preview (dry run) — check for name conflicts, missing bind mounts, image availability before migrating' },
        { type: 'feature', text: 'Auto-pull images on destination — no need to pre-pull, migration handles it' },
        { type: 'feature', text: 'Name conflict resolution — auto-renames if container name exists on destination' },
        { type: 'feature', text: 'Migration labels — migrated containers tagged with source host, timestamp, original name' },
        { type: 'feature', text: 'Host bind mount warnings — flags paths that may not exist on destination' },
        { type: 'feature', text: 'Health check verification — waits up to 30s for healthy status on destination before stopping source' },
        { type: 'security', text: 'Admin-only operation with full audit logging' },
        { type: 'improvement', text: 'Step-by-step progress reporting (inspect → pull → create → start → verify → stop source)' },
      ],
    },
    {
      version: '3.4.0',
      date: '2026-03-27',
      title: 'Workflow Automation, Dashboard Prefs, Complete README',
      changes: [
        { type: 'feature', text: 'Workflow Automation — IF-THEN rules: CPU high → restart, container crash → notify, unhealthy → alert, crash loop → stop' },
        { type: 'feature', text: '5 workflow templates: auto-restart on crash, notify on high CPU/memory, stop on crash loop, alert on unhealthy' },
        { type: 'feature', text: 'Workflow actions: notify (all channels), restart, stop, webhook call' },
        { type: 'feature', text: 'Cooldown system — prevents rule from triggering repeatedly' },
        { type: 'feature', text: 'Dashboard preferences — save widget order and hidden widgets per user' },
        { type: 'improvement', text: 'README completely rewritten with all v2-v3 features (60+ features documented)' },
        { type: 'improvement', text: 'New sections: Git Integration, Developer Tools, Monitoring & Intelligence' },
      ],
    },
    {
      version: '3.3.0',
      date: '2026-03-27',
      title: 'Mobile UI, Resource Recommendations, Competitive Positioning',
      changes: [
        { type: 'feature', text: 'Mobile-Responsive UI — hamburger menu, touch-friendly buttons (40px min), scrollable tables, overlay sidebar' },
        { type: 'feature', text: 'iOS zoom prevention — form inputs set to 16px on mobile' },
        { type: 'feature', text: 'Resource Recommendations — smart analysis of 24h stats with actionable advice' },
        { type: 'feature', text: 'Detects: over-provisioned memory, memory pressure, no memory limit, high CPU, idle containers' },
        { type: 'feature', text: 'Comparison API — /api/compare returns feature matrix vs Portainer, Dockge, Dockhand (29 features)' },
        { type: 'feature', text: 'Exclusive feature count — shows how many features only Docker Dash has' },
        { type: 'improvement', text: 'Small phone (480px) optimizations: compact headers, stacked card layouts' },
        { type: 'improvement', text: 'Sidebar auto-closes on navigation (mobile)' },
      ],
    },
    {
      version: '3.2.0',
      date: '2026-03-27',
      title: 'Community & Growth — Templates, Log Search, Watchtower Migration',
      changes: [
        { type: 'feature', text: 'Enhanced Log Search — regex pattern matching, log level filtering (ERROR/WARN/INFO/DEBUG)' },
        { type: 'feature', text: 'Log statistics — error/warning count summary in log response' },
        { type: 'feature', text: 'App Template Marketplace — 20 curated one-click templates (Nginx, PostgreSQL, Redis, Grafana, Traefik, Nextcloud, Gitea, n8n, Vaultwarden, Pi-hole, and more)' },
        { type: 'feature', text: 'Template categories: Web Server, Database, Monitoring, Reverse Proxy, Cloud Storage, Development, Automation, Security, IoT, CMS' },
        { type: 'feature', text: 'Template search and category filter' },
        { type: 'feature', text: 'Watchtower Detection — auto-detect running Watchtower containers' },
        { type: 'feature', text: 'Watchtower migration advisory — step-by-step guide to switch to Docker Dash native safe-pull updates' },
        { type: 'improvement', text: 'Log download preserves search/filter results' },
      ],
    },
    {
      version: '3.1.0',
      date: '2026-03-27',
      title: 'Automation & Status — Maintenance Windows, Smart Restart, Status Page',
      changes: [
        { type: 'feature', text: 'Scheduled Maintenance Windows — define cron schedule, target containers/stacks, actions (pull/scan/update)' },
        { type: 'feature', text: 'Maintenance CRUD API — create, update, enable/disable, delete maintenance windows' },
        { type: 'feature', text: 'Smart Restart with Backoff — exponential backoff (5s→15s→45s→120s) based on restart frequency' },
        { type: 'feature', text: 'Crash-loop detection — if >10 restarts in 1 hour, suggests rollback instead of restart' },
        { type: 'feature', text: 'Public Status Page — unauthenticated /api/status-page/public endpoint' },
        { type: 'feature', text: 'Status page shows selected containers as services with operational/degraded/down/maintenance status' },
        { type: 'feature', text: 'Overall system status: operational / degraded / major_outage' },
        { type: 'feature', text: 'Status page admin — enable/disable, custom title, add/remove containers' },
        { type: 'security', text: 'Status page disabled by default — must be explicitly enabled by admin' },
        { type: 'improvement', text: 'Block-on-critical option for maintenance windows (skip update if vulns found)' },
      ],
    },
    {
      version: '3.0.0',
      date: '2026-03-27',
      title: 'Safe Operations — Deploy Previews, Safe-Pull, Troubleshooting',
      changes: [
        { type: 'feature', text: 'Deploy Preview — check if a container image has updates available without pulling (digest comparison)' },
        { type: 'feature', text: 'Preview shows current image digest, creation date, size, port bindings, env count, restart policy' },
        { type: 'feature', text: 'Safe-Pull Container Update — pull new image, scan with Trivy for critical vulnerabilities, only swap if scan passes' },
        { type: 'feature', text: 'Update blocked notification — if critical vulns found, update is blocked with detailed scan summary' },
        { type: 'feature', text: 'Guided Troubleshooting Wizard — 8-step diagnostic for any container' },
        { type: 'feature', text: 'Diagnose checks: state, health check, logs, ports, volumes, resources, restart policy, image age' },
        { type: 'feature', text: 'Overall health assessment: critical/warning/healthy with actionable suggestions per step' },
        { type: 'feature', text: 'Error pattern detection in logs (error, exception, fatal, panic, traceback)' },
        { type: 'feature', text: 'Missing bind mount detection — flags paths that don\'t exist on the host' },
        { type: 'security', text: 'Safe-pull prevents deploying images with critical vulnerabilities' },
        { type: 'improvement', text: 'Three new API endpoints: deploy-preview, safe-update, diagnose' },
      ],
    },
    {
      version: '2.10.0',
      date: '2026-03-27',
      title: 'Image Intelligence & Audit Analytics',
      changes: [
        { type: 'feature', text: 'Image Freshness Dashboard — freshness score (0-100) based on age + vulnerability count' },
        { type: 'feature', text: 'Images sorted by freshness (stalest first) with age in days, size, and last scan results' },
        { type: 'feature', text: 'Audit Log Analytics — top users, top actions, most actioned targets, activity heatmap' },
        { type: 'feature', text: 'Daily and hourly activity charts for audit trail visualization' },
        { type: 'improvement', text: 'New API endpoints: /images/freshness, /audit/analytics' },
      ],
    },
    {
      version: '2.9.0',
      date: '2026-03-27',
      title: 'Smart Monitoring — Uptime Reports, Trends, Cost Estimation',
      changes: [
        { type: 'feature', text: 'Container Uptime Report — uptime %, restart count, hours tracked, first/last seen for every container' },
        { type: 'feature', text: 'Resource Usage Trends — 7-day hourly averages with linear regression trend analysis' },
        { type: 'feature', text: 'CPU/Memory Forecasting — 24h projection, trend direction (increasing/stable/decreasing)' },
        { type: 'feature', text: 'Memory exhaustion prediction — "will exceed limit in N hours" warning based on growth rate' },
        { type: 'feature', text: 'Per-Container Cost Estimation — input your VPS monthly cost, see breakdown by container (CPU + memory weighted)' },
        { type: 'improvement', text: 'Three new API endpoints: /stats/uptime, /stats/trends/:id, /stats/cost' },
      ],
    },
    {
      version: '2.8.0',
      date: '2026-03-27',
      title: 'Developer Tools — Run Converter, AI Diagnostics, Proxy Labels',
      changes: [
        { type: 'feature', text: 'docker run → Compose converter — paste any docker run command, get docker-compose YAML' },
        { type: 'feature', text: 'Supports: ports, volumes, env vars, labels, restart policy, network, hostname, entrypoint, command' },
        { type: 'feature', text: 'AI-Powered Log Analysis — generate diagnostic prompts from container logs + config for ChatGPT/Claude' },
        { type: 'feature', text: 'Includes container state, exit code meaning, restart policy, resource limits, and last N log lines' },
        { type: 'feature', text: 'Traefik v2 label generator — input domain + port, get ready-to-use router/service labels with TLS' },
        { type: 'feature', text: 'Caddy label generator — caddy-docker-proxy compatible labels' },
        { type: 'improvement', text: 'New "Tools" tab in System page — all developer utilities in one place' },
        { type: 'improvement', text: 'Copy-to-clipboard for all generated outputs' },
      ],
    },
    {
      version: '2.7.0',
      date: '2026-03-27',
      title: 'Notification Channels & SSO Authentication',
      changes: [
        { type: 'feature', text: 'Notification channels — Discord, Slack, Telegram, Ntfy, Gotify, Email (SMTP), Custom Webhook' },
        { type: 'feature', text: 'Channel management UI in Settings — add, test, delete notification channels' },
        { type: 'feature', text: 'Per-channel test notification — verify configuration with one click' },
        { type: 'feature', text: 'SSO header authentication — Authelia, Authentik, Caddy forward_auth, Traefik support' },
        { type: 'feature', text: 'Auto-create SSO users from X-Forwarded-User/X-Forwarded-Groups headers' },
        { type: 'feature', text: 'SSO group-to-role mapping — admin, operator, viewer roles from SSO groups' },
        { type: 'security', text: 'Channel credentials encrypted at rest (AES-256-GCM)' },
        { type: 'security', text: 'SSO disabled by default — requires ENABLE_SSO_HEADERS=true environment variable' },
        { type: 'improvement', text: 'Notification providers API — dynamic form fields for each provider type' },
      ],
    },
    {
      version: '2.6.0',
      date: '2026-03-27',
      title: 'Intelligence Foundations — Health Score, Status Insights, Footprint',
      changes: [
        { type: 'feature', text: 'Plain-English container status — exit codes (137=OOM, 143=SIGTERM, etc.) mapped to human-readable messages' },
        { type: 'feature', text: 'Container Health Score (0-100) — composite score from state, health checks, restarts, CPU/memory, image age, vulnerabilities' },
        { type: 'feature', text: 'Health score color coding and labels (Excellent/Good/Fair/Poor/Critical)' },
        { type: 'feature', text: 'Container status context — explains why a container is in its current state with actionable info' },
        { type: 'feature', text: 'Self-reporting resource footprint — /api/footprint shows Docker Dash memory, uptime, DB size, Node.js version' },
        { type: 'improvement', text: 'Utility functions for exit code interpretation reusable across all container views' },
      ],
    },
    {
      version: '2.5.0',
      date: '2026-03-27',
      title: 'Push to Git & Custom TLS Certificates (Phase 4)',
      changes: [
        { type: 'feature', text: 'Push changes back to Git — edit compose files in Docker Dash, commit and push to the source repository' },
        { type: 'feature', text: 'Remote status check — see if remote has newer commits before pushing (conflict detection)' },
        { type: 'feature', text: 'Force push with lease — safely overwrite remote when conflicts are detected' },
        { type: 'feature', text: 'Compose editor dialog — edit compose YAML with commit message input, accessible from stack detail' },
        { type: 'feature', text: 'Custom CA certificate support — provide PEM certificates for self-hosted Git servers (alternative to skip TLS)' },
        { type: 'security', text: 'CA cert temp files cleaned up on stack deletion' },
        { type: 'improvement', text: 'Git push audit logging — every push recorded in audit trail with commit hash' },
      ],
    },
    {
      version: '2.4.0',
      date: '2026-03-27',
      title: 'Multi-File Compose & Env Var Management (Phase 4)',
      changes: [
        { type: 'feature', text: 'Multi-file compose support — specify multiple YAML files (docker compose -f file1.yml -f file2.yml)' },
        { type: 'feature', text: 'Environment variable override management — per-stack overrides with sensitive value encryption' },
        { type: 'feature', text: 'Import .env file — paste .env content and mark sensitive keys, auto-parsed and stored' },
        { type: 'feature', text: 'Sensitive env vars — AES-256-GCM encrypted at rest, masked in API responses' },
        { type: 'improvement', text: 'Compose files validated at deploy time — all files must exist in the repo' },
        { type: 'improvement', text: 'Env var precedence: DB overrides > repo .env > compose environment section' },
      ],
    },
    {
      version: '2.3.0',
      date: '2026-03-27',
      title: 'Git Auto-Deploy, Diff View & Rollback (Phase 2+3)',
      changes: [
        { type: 'feature', text: 'Webhook receiver — GitHub, GitLab, Gitea, Bitbucket push events trigger automatic deploys' },
        { type: 'feature', text: 'Webhook signature validation — HMAC-SHA256 for GitHub/Gitea/Bitbucket, token header for GitLab' },
        { type: 'feature', text: 'Polling auto-update — configurable interval checks for new commits and auto-deploys' },
        { type: 'feature', text: 'Deployment history — full audit trail of every deployment with commit, trigger, status, duration' },
        { type: 'feature', text: 'Diff view — see exactly what changed between deployed and latest commit before redeploying' },
        { type: 'feature', text: 'Rollback — one-click revert to any previous successful deployment' },
        { type: 'feature', text: 'Auto-deploy configuration UI — webhook URL generation, provider selection, polling config' },
        { type: 'feature', text: 'Deploy-on-push toggle — optionally detect changes but only notify (no auto-deploy)' },
        { type: 'improvement', text: 'Enhanced stack detail view — dual-card layout with auto-deploy status, deployment history table' },
        { type: 'improvement', text: 'Deployment count and duration tracking on each stack' },
        { type: 'improvement', text: 'WebSocket real-time events for deploy start/success/failure' },
        { type: 'security', text: 'Timing-safe signature comparison to prevent timing attacks on webhook validation' },
        { type: 'security', text: 'Separate rate limiter for webhook endpoint (30 req/min per IP)' },
      ],
    },
    {
      version: '2.2.0',
      date: '2026-03-27',
      title: 'Git Repository Integration (Phase 1)',
      changes: [
        { type: 'feature', text: 'Deploy Docker Compose stacks directly from Git repositories — clone, deploy, and manage from the UI' },
        { type: 'feature', text: 'Git Credentials Manager — save and reuse tokens, passwords, and SSH keys (AES-256-GCM encrypted at rest)' },
        { type: 'feature', text: 'Test Connection — validate Git repo access and auto-populate branches before deploying' },
        { type: 'feature', text: 'Pull & Redeploy — one-click sync from Git remote with force reset option' },
        { type: 'feature', text: 'Check for Updates — compare local HEAD vs remote without deploying, see new commits' },
        { type: 'feature', text: 'Git Stack detail view — current commit, deploy status, error messages, repo info' },
        { type: 'feature', text: 'New sidebar navigation — dedicated Git Stacks page' },
        { type: 'feature', text: 'Git Credentials tab in Settings — create, edit, delete credentials with usage tracking' },
        { type: 'feature', text: 'Branch selection and compose file path configuration per stack' },
        { type: 'feature', text: 'Environment variable overrides — inject env vars without editing the repo' },
        { type: 'security', text: 'Git URL validation — prevents command injection via shell metacharacters' },
        { type: 'security', text: 'Compose path validation — prevents path traversal attacks' },
        { type: 'security', text: 'Error message sanitization — removes credentials from Git error output' },
        { type: 'security', text: 'SSH key handling — temp files with 0600 permissions, auto-cleanup on stack delete' },
        { type: 'improvement', text: 'Dockerfile updated — git + openssh-client added to Alpine image (~20MB)' },
        { type: 'improvement', text: 'Audit logging for all Git operations (credential CRUD, stack CRUD, deploy, check)' },
        { type: 'improvement', text: 'WebSocket broadcast for deploy status changes (real-time UI updates)' },
        { type: 'improvement', text: 'i18n — Git Stacks translations added for English, Romanian, German' },
      ],
    },
    {
      version: '2.1.0',
      date: '2026-03-26',
      title: 'i18n Modular System & Security Hardening',
      changes: [
        { type: 'feature', text: 'Modular i18n system — translations split into separate files per language (i18n/en.js, i18n/ro.js)' },
        { type: 'feature', text: 'Language plugin system — add a new language by dropping a single .js file + one script tag' },
        { type: 'feature', text: 'Translation template — TEMPLATE.js with all ~900 keys ready to translate' },
        { type: 'feature', text: 'Dynamic language selector — cycles through all registered languages (not hardcoded EN/RO)' },
        { type: 'feature', text: 'Initial Security Setup wizard — forces password change on first login with default admin' },
        { type: 'feature', text: 'Password policy — minimum 8 characters, at least 1 number, blocks common passwords' },
        { type: 'feature', text: 'Security banner — warns if default admin account is still active' },
        { type: 'feature', text: 'Optional personal admin creation during setup wizard' },
        { type: 'security', text: 'Bearer token fallback — authentication works when browser blocks cookies (Edge Tracking Prevention, HTTP on public IPs)' },
        { type: 'security', text: 'Cookie sameSite changed from strict to lax for HTTP compatibility' },
        { type: 'security', text: 'Session token returned in login response body (not just cookie) for non-cookie auth' },
        { type: 'fix', text: 'Setup wizard shows current username and asks for current password when session is restored' },
        { type: 'fix', text: 'Setup complete flag saved before password change (which invalidates session)' },
        { type: 'improvement', text: 'WebSocket auth fallback via query parameter token' },
        { type: 'improvement', text: 'i18n README with full instructions for contributors' },
      ],
    },
    {
      version: '2.0.1',
      date: '2026-03-26',
      title: 'Open Source Ready & Polish',
      changes: [
        { type: 'feature', text: 'About page — view and edit open-source files (README, LICENSE, CONTRIBUTING, .env.example, .gitignore) directly from the UI' },
        { type: 'feature', text: "What's New page — changelog with version history (this page)" },
        { type: 'fix', text: 'Security page now respects selected host — scan history filtered by host_id' },
        { type: 'fix', text: 'Edit Host dialog now loads full SSH config (host, port, username, docker socket) from server' },
        { type: 'fix', text: 'Edit Host dialog now includes Test Connection button (was missing)' },
        { type: 'fix', text: 'SSH tunnel "socket hang up" — added socat/nc/streamlocal fallback chain' },
        { type: 'improvement', text: 'TCP+TLS guide — full step-by-step TLS certificate generation instructions' },
        { type: 'improvement', text: 'SSH Tunnel guide — socat install commands for 7 Linux distributions' },
        { type: 'improvement', text: 'Connection type cards reorganized in 2x2 grid layout' },
        { type: 'improvement', text: 'Dockerfile updated to include open-source files in production image' },
        { type: 'improvement', text: '.dockerignore fixed to allow README.md, LICENSE, CONTRIBUTING.md, .gitignore' },
      ],
    },
    {
      version: '2.0.0',
      date: '2026-03-26',
      title: 'Multi-Host Docker Management',
      changes: [
        { type: 'feature', text: 'Multi-host support — manage multiple Docker hosts from a single instance' },
        { type: 'feature', text: 'TCP + TLS connections — connect to remote Docker hosts over the network with mutual TLS' },
        { type: 'feature', text: 'SSH Tunnel connections — secure tunnel via ssh2 library with auto-reconnect' },
        { type: 'feature', text: 'Docker Desktop support — connect via TCP port 2375' },
        { type: 'feature', text: 'Host management page — add, edit, delete, test connection, view Docker info' },
        { type: 'feature', text: 'Host selector dropdown in sidebar — switch between hosts instantly' },
        { type: 'feature', text: 'Per-host stats collection — independent collectors with failure isolation' },
        { type: 'feature', text: 'Per-host event streams — Docker events monitored per host' },
        { type: 'feature', text: 'Host health checks — periodic connectivity monitoring (60s interval)' },
        { type: 'feature', text: 'Connection guide — detailed setup instructions for each connection type' },
        { type: 'improvement', text: 'All API endpoints now accept hostId parameter for multi-host context' },
        { type: 'improvement', text: 'WebSocket exec and log streams support hostId' },
        { type: 'improvement', text: 'Stats error logging rate-limited to 1 per 5 minutes per host' },
        { type: 'improvement', text: 'Event stream reconnect with exponential backoff' },
      ],
    },
    {
      version: '1.6.0',
      date: '2026-03-24',
      title: 'Security & Vulnerability Scanning',
      changes: [
        { type: 'feature', text: 'Security page — dedicated vulnerability management dashboard' },
        { type: 'feature', text: 'Trivy scanner integration — automatic vulnerability detection' },
        { type: 'feature', text: 'Docker Scout integration — SARIF format parsing with Docker Hub auth' },
        { type: 'feature', text: 'Scan history — persistent storage with search, grouping, and bulk delete' },
        { type: 'feature', text: 'AI-assisted remediation — generated prompts for fixing vulnerabilities' },
        { type: 'feature', text: 'Smart vulnerability classification — npm vs OS vs third-party binary' },
        { type: 'security', text: 'npm overrides for 7 CVEs: cross-spawn, glob, minimatch, tar, brace-expansion, diff' },
        { type: 'security', text: 'Alpine package upgrades in Dockerfile for OS-level CVEs' },
        { type: 'fix', text: 'Docker Scout --format json replaced with --format sarif (json was invalid)' },
        { type: 'fix', text: 'Scout authentication persisted to /data/.docker/ (survives container restart)' },
        { type: 'fix', text: 'Clipboard API fallback for HTTP contexts using document.execCommand' },
        { type: 'fix', text: 'CSP scriptSrcAttr added for inline event handlers' },
      ],
    },
    {
      version: '1.5.0',
      date: '2026-03-22',
      title: 'Feature Parity with Portainer',
      changes: [
        { type: 'feature', text: 'Network topology — interactive canvas with drag, zoom, pan, hover highlighting' },
        { type: 'feature', text: 'Container terminal — xterm.js with shell selection and resize' },
        { type: 'feature', text: 'Live log streaming — WebSocket-based real-time container log follow' },
        { type: 'feature', text: 'Dashboard live graphs — CPU/memory time-series charts (rolling 60 points)' },
        { type: 'feature', text: 'Compose/Stacks — list, view YAML, edit, deploy with environment variables' },
        { type: 'feature', text: 'Container creation wizard — from image config with port/volume/env mapping' },
        { type: 'feature', text: 'Registry management — Docker Hub and generic v2 registry support' },
        { type: 'feature', text: 'Image build — stream build output via SSE' },
        { type: 'feature', text: 'Container clone/duplicate and update/recreate' },
        { type: 'feature', text: 'Container export (docker-compose.yml, docker run, JSON)' },
        { type: 'feature', text: 'Quick container actions menu' },
        { type: 'feature', text: 'WebSocket hardening — heartbeat, rate limiting, cleanup' },
        { type: 'improvement', text: 'Container size displayed in detail header' },
        { type: 'improvement', text: 'Image/volume footers with count and total size' },
      ],
    },
    {
      version: '1.1.0',
      date: '2026-03-20',
      title: 'Performance & Stability',
      changes: [
        { type: 'fix', text: 'Stats pipeline O(n²) query — changed to INSERT OR IGNORE with UNIQUE indexes' },
        { type: 'fix', text: 'docker_events table bloat (7GB) — added cleanup + VACUUM, reduced to 307MB' },
        { type: 'fix', text: 'CPU usage dropped from 59% to <2%, health check from 28s to 3ms' },
        { type: 'feature', text: 'Automatic log cleanup — data older than 7 days purged hourly' },
        { type: 'feature', text: 'Database tab in System page — DB info, table sizes, manual cleanup/vacuum' },
        { type: 'improvement', text: 'Stats aggregation: raw → 1min → 1hour with configurable retention' },
      ],
    },
    {
      version: '1.0.0',
      date: '2026-03-18',
      title: 'Initial Release',
      changes: [
        { type: 'feature', text: 'Container management — list, start, stop, restart, remove with bulk actions' },
        { type: 'feature', text: 'Image management — list, pull, remove with size display' },
        { type: 'feature', text: 'Volume and network management' },
        { type: 'feature', text: 'Real-time stats collection (10s interval) with SQLite storage' },
        { type: 'feature', text: 'Alert system — CPU/memory threshold rules with email/webhook notifications' },
        { type: 'feature', text: 'User management — admin, operator, viewer roles' },
        { type: 'feature', text: 'Audit log — all actions tracked' },
        { type: 'feature', text: 'Dark/light theme with system detection' },
        { type: 'feature', text: 'i18n — English and Romanian' },
        { type: 'feature', text: 'Firewall management (UFW)' },
        { type: 'feature', text: 'Command palette (Ctrl+K)' },
      ],
    },
  ],

  // ─── Render ──────────────────────────────────────

  async render(container) {
    const current = this._releases[0]?.version || '?';

    container.innerHTML = `
      <div class="page-header">
        <h2><i class="fas fa-bullhorn"></i> What's New</h2>
        <div class="page-actions">
          <span class="badge badge-info" style="font-size:12px">v${Utils.escapeHtml(current)}</span>
          <a href="https://github.com/bogdanpricop/docker-dash" target="_blank" rel="noopener" class="btn btn-sm btn-secondary" style="display:inline-flex;align-items:center;gap:6px;text-decoration:none">
            <i class="fab fa-github"></i> GitHub
          </a>
        </div>
      </div>
      <div id="whatsnew-content">${this._renderReleases()}</div>
    `;
  },

  _renderReleases() {
    const typeIcons = {
      feature: { icon: 'fa-star', color: 'var(--accent)', label: 'New' },
      fix: { icon: 'fa-bug', color: 'var(--red)', label: 'Fix' },
      improvement: { icon: 'fa-arrow-up', color: 'var(--green)', label: 'Improved' },
      security: { icon: 'fa-shield-alt', color: 'var(--yellow)', label: 'Security' },
      breaking: { icon: 'fa-exclamation-triangle', color: 'var(--red)', label: 'Breaking' },
    };

    return this._releases.map((release, idx) => {
      const isLatest = idx === 0;
      const changesByType = {};
      for (const c of release.changes) {
        if (!changesByType[c.type]) changesByType[c.type] = [];
        changesByType[c.type].push(c.text);
      }

      // Order: breaking, security, feature, improvement, fix
      const typeOrder = ['breaking', 'security', 'feature', 'improvement', 'fix'];
      const sections = typeOrder
        .filter(t => changesByType[t]?.length)
        .map(t => {
          const info = typeIcons[t] || typeIcons.feature;
          return `
            <div style="margin-bottom:12px">
              <div style="font-size:12px;font-weight:600;margin-bottom:6px;color:${info.color}">
                <i class="fas ${info.icon}" style="width:16px"></i> ${info.label}
              </div>
              <ul style="margin:0;padding-left:24px;line-height:1.8">
                ${changesByType[t].map(text => `<li class="text-sm">${Utils.escapeHtml(text)}</li>`).join('')}
              </ul>
            </div>
          `;
        }).join('');

      return `
        <div class="card" style="margin-bottom:16px${isLatest ? ';border-color:var(--accent)' : ''}">
          <div class="card-header" style="display:flex;align-items:center;gap:10px">
            <h3 style="margin:0;display:flex;align-items:center;gap:8px">
              <span style="background:${isLatest ? 'var(--accent)' : 'var(--surface2)'};color:${isLatest ? '#fff' : 'var(--text)'};padding:2px 10px;border-radius:var(--radius-sm);font-family:var(--mono);font-size:14px">v${Utils.escapeHtml(release.version)}</span>
              ${Utils.escapeHtml(release.title)}
            </h3>
            <span class="text-sm text-muted" style="margin-left:auto">${Utils.escapeHtml(release.date)}</span>
            ${isLatest ? '<span class="badge" style="background:var(--green);color:#fff;font-size:10px">Latest</span>' : ''}
          </div>
          <div class="card-body">${sections}</div>
        </div>
      `;
    }).join('');
  },

  destroy() {},
};

window.WhatsNewPage = WhatsNewPage;
