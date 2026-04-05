# Changelog

All notable changes to Docker Dash are documented here.

## [5.4.0] - 2026-04-05

### Added
- **One-click port access** — each exposed TCP port in the Containers list gets a clickable external-link button; opens `http(s)://host:port` in a new tab; icon appears on row hover
- **Log time filter** — "since" dropdown (All time / Last 1h / 6h / 24h / 7d) added to the container log viewer toolbar alongside tail count
- **Keyboard navigation in Containers list** — Arrow Up/Down to move between rows, Enter to open detail view, `r` to restart, `s` to stop/start, `l` to jump to Logs tab; focused row highlighted in blue
- **Live CPU/RAM mini-bars** — two 4px color-coded progress bars per running container row, updated every 5 s via `/stats/overview`; color shifts green→yellow→red by utilization
- **Dual AI provider (OpenAI + Ollama)** — Container Doctor "Ask AI" button with provider/model/key inputs; calls OpenAI API or local Ollama and streams the response directly into the modal; config persisted in localStorage
- **Image layer visualization** — new Layers button in the Images table; opens a modal showing all image layers with command, size, and a relative-size bar per layer (color-coded by size)
- **Generate docker-compose from GitHub** — new "From GitHub" button in Containers; fetches README/package.json/go.mod/requirements.txt from any public GitHub repo, sends to AI (OpenAI or Ollama), returns a production-ready docker-compose.yml with health checks, volumes, networks, and resource limits

### Backend
- `POST /api/ai/chat` — generic AI chat endpoint supporting OpenAI and Ollama providers
- `POST /api/ai/github-compose` — fetches GitHub repo context (5 files max) and generates docker-compose via AI
- `GET /images/:id/history` already existed; wired to new frontend Layers modal
- `GET /containers/:id/logs` already accepted `since` param; now passed from frontend log-time selector

## [5.3.1] - 2026-04-05

### Added
- **Stack-level security buttons** — Security Scan (🟡) and CIS Benchmark (🟢) directly in the stack header in Containers page
- **Scan Detail overlay** — "View Details" per image after a Security Scan opens full CVE breakdown *over* the scan modal without closing it; includes Critical/High/Medium/Low grid, recommendations, full CVE table with fix versions, and AI prompt copy
- **CIS Benchmark card in Security overview** — run benchmark and see score + issue counts without leaving Security page; result cached in sessionStorage
- **CIS Benchmark header button** in Security page — one-click navigation to System > CIS tab
- **Actions Guide (i button)** in Containers and Images — full 2-column overlay reference documenting every stack action, container action, and status indicator
- **Generated docker-compose.yml** — View Composer reconstructs YAML from container inspect metadata with a "Generated" notice when no real file is found on disk
- **Comparison table sticky header + footer** — column headers and legend always visible; table scrolls internally with `max-height: calc(100vh - 280px)`

### Improved
- CIS Benchmark reorganized into sub-tabs: Guide, Daemon, Containers, All results; per-container hardened compose generator
- Template images loading — `cdn.jsdelivr.net` added to Content Security Policy `imgSrc`
- Version in System > Info and About now reads from `src/version.js` (mounted volume) — no longer shows stale baked image version
- Grype added to image scan dropdown menu (was missing)
- Comparison table first-column sticky cells use `--surface2` with `box-shadow` to eliminate transparency bleed-through at scroll

### Fixed
- Scan History "View Details" eye button did nothing — event listeners were placed after a `return` statement (dead code)
- Image scan dropdown positioned off-screen — `event.currentTarget` resolved to the delegated table element instead of the actual button
- Actions Guide overlay background transparent on light theme — `--card-bg` variable undefined; replaced with `--surface`
- CIS Benchmark header button non-functional — inline `onclick` blocked by CSP `scriptSrcAttr: none`; replaced with addEventListener
- Grype install instructions appeared visually grouped with Docker Scout — separator div moved to correct position

## [5.3.0] - 2026-04-04

### Added
- **Docker Swarm mode** — full UI: Nodes table (availability/role management, drain, remove), Services (create, scale, remove, tasks drill-down), Tasks (sorted by state, error display), Overview (init form, stat cards, join tokens, leave)
- **Swarm beginner guide card** — explains Nodes (manager vs worker), Services (replicated vs global), Tasks, Overlay Networks + Ingress, CLI quickstart example
- **Swarm official docs card** — 5 direct links: overview, tutorial, deploy services, overlay networking, secrets
- **Extended comparison matrix** — 4 new tools added: Coolify, Yacht, Rancher, Portainer Business (8 tools total, 60 features)
- **Sticky first column** in comparison table — feature name stays visible while scrolling 8 columns horizontally

### Improved
- Nav "Swarm" translation added to all 11 locale files (Klingon: `ramDaq veQ`)
- Comparison matrix stat cards: "Dockge Missing" → "Coolify Missing" for more relevant callout
- What's New page: added 5.1.0, 5.2.0 and 5.3.0 release entries (were missing)

### Fixed
- Latency tracking middleware crash (`ERR_HTTP_HEADERS_SENT`) — `res.setHeader` called after headers already sent by `sendFile()` for static streams; guarded with `!res.headersSent`

## [5.2.0] - 2026-04-03

### Added
- **SSL zero-config** — Caddy sidecar reads shared `caddy-certs` volume; app writes Caddyfile + reloads via `docker exec`; enable HTTPS from System > SSL tab, no manual container restarts
- **LDAP / Active Directory sync** — two-bind auth (service account bind → user search → user bind to verify password), group filter, attribute mapping, user preview list; auto-provisions local accounts on first LDAP login with unusable password hash
- **CIS Docker Benchmark tab** — 18 checks (6 daemon: logging, experimental, live-restore, userland-proxy, seccomp, AppArmor; 12 container: privileged, cap-add, no-new-privileges, namespace sharing, read-only rootfs, memory/CPU limits, sensitive mounts, privileged ports, running as root), scored report with severity + remediation
- **App marketplace logos** — walkxcode/dashboard-icons CDN integration with FontAwesome icon fallback on error
- **LDAP config API** — `GET/PUT/DELETE /api/auth/ldap`, `POST /api/auth/ldap/test`, `GET /api/auth/ldap/users`
- DB migration 037: `ALTER TABLE users ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'local'`

### Improved
- System page tabs wrap on small screens (phone / RDP window) — added `flex-wrap: wrap` to `.tabs` CSS class
- Caddy status shown in SSL card with badge + conditional "Enable HTTPS" button vs terminal command display

### Fixed
- SQLite `datetime("now")` bug in `registry.js` and `pipeline.js` — double-quoted identifiers treated as column names by SQLite; changed to single-quoted string literals `datetime('now')`

## [5.1.0] - 2026-04-02

### Added
- **Docker Registry edit** — full edit modal pre-populated with current registry data, calls `PUT /api/registries/:id`; was a "coming soon" stub
- **Registry test shows repo count** — inline table feedback with repository count; 0 repositories now correctly returns red failure with message (not success)
- **Pull Image registry dropdown** — 7 presets (Docker Hub, GHCR, MCR, Quay, ECR Public, GCR, Custom) with auto-filled prefix and dynamic placeholder
- **SSH Key authentication guide** on Hosts page — 3-step card (keygen → ssh-copy-id → paste) matching the SSH Tunnel Linux distros

## [5.0.5] - 2026-03-31

### Added
- **Template Configurator** — dynamic visual editor for template deployment: auto-detects configurable fields (passwords, ports, URLs, booleans), generates smart forms, live YAML preview with change highlighting
- **Password generator** in configurator — slider (8-256 chars), Generate button, strength indicator, weak default warnings
- **3 Euro-Office templates** — Document Server standalone, Euro-Office + Nextcloud combo, Dev Stack (Euro-Office vs OnlyOffice)
- **Cost Optimizer tabs** — Recommendations and Cost Breakdown on separate tabs under savings banner
- **3-button template UX** — Eye (view YAML), Sliders (configure & deploy), Rocket (deploy with defaults)

### Fixed
- Container filter reset on page navigation (ghost filter no longer persists)
- Template configurator: Generate button now correctly updates both input field and YAML preview
- Template configurator: password field layout — input full width, controls on separate row
- Template configurator: strength bar updates correctly after generating (was stuck on "weak")

## [5.0.4] - 2026-03-30

### Verified
- All findings from external audit re-verified on live GitHub repo
- API key permission enforcement confirmed live (enforceApiKeyPermissions in auth middleware)
- Rate limiting confirmed on /validate-reset-token and /reset-password-token
- Version consistency confirmed: 5.0.4 across package.json, docker-compose.yml, index.html
- Zero stale references (4.2.0, 335 tests, 52 features, 20 templates, ENABLE_TLS) — all clean
- 384 tests, 29 suites, 100% passing

## [5.0.3] - 2026-03-30

### Security
- **API key permission enforcement** — read-only API keys now blocked from POST/PUT/DELETE (was decorative, now enforced in auth middleware)
- **Rate limiting** on public reset-password endpoints (`/validate-reset-token`, `/reset-password-token`)

### Fixed
- `/api/docs` feature count: 52 → 75+
- `/api/compare` App Templates: "20 built-in" → "30 + custom"
- docker-compose.yml TLS comment: "ENABLE_TLS=true" → "docker compose --profile tls up -d"
- .env.example strict mode description: clarified Bearer/API key still work (by design)
- SECURITY.md: removed "login" from validatePassword flows (login only compares hashes)
- changePassword() comment: "except current" → "all sessions" (matches actual behavior)

## [5.0.2] - 2026-03-30

### Fixed
- CRITICAL: MFA login flow — session cookie was set before MFA verification, creating invalid cookie when TOTP required. Cookie now only set after complete authentication.
- README CSP tradeoff description aligned with actual code (unsafe-eval only, NOT unsafe-inline)
- dotenv added as explicit dependency for local development reliability
- .env.example expanded with missing config vars (SECURITY_MODE, PASSWORD_MAX_AGE_DAYS, APP_NAME, etc.)
- SECURITY.md auth model description clarified (API keys use separate table)
- CI syntax check error fixed (single quotes → backtick template literals in MFA flow)

## [5.0.1] - 2026-03-30

### Fixed — Documentation & Release Hygiene
- All documentation files updated to reflect actual project stats (384 tests, 29 test files, 32 migrations, 11 languages)
- Stale test counts fixed across README.md, SECURITY.md, CONTRIBUTING.md, CI workflow, PR template, comparison table
- Cache busters updated in index.html (all `?v=` references now `5.0.1`)
- i18n language count fixed in comparison API (`EN/RO/DE` → `11 languages`)
- Project structure in README corrected (13 migrations → 32 migrations)
- README language list expanded from "English, Romanian, German" to all 11 languages
- whatsnew.js v5.0.0 test count corrected (359/24 → 384/29)
- PR template test threshold updated (335+ → 384+)
- CI summary test count updated (335 → 384)

### Changed
- Version bumped from 5.0.0 to 5.0.1 across package.json, docker-compose.yml, index.html

## [5.0.0] - 2026-03-29

### Added — Enterprise Security Hardening
- **Enterprise Security Mode** — `SECURITY_MODE=strict` flag toggles all hardening (cookie-only auth, forced HTTPS, 8h sessions, password expiry)
- **TOTP/MFA** — two-factor authentication with zero dependencies (RFC 6238), encrypted secrets, 10 recovery codes
- **Immutable hash-chained audit log** — SHA-256 chain, tamper detection, JSON/CSV/Syslog export
- **Security event alerting** — 5 default rules (brute force, admin created, MFA disabled), threshold detection, 7 notification channels
- **14 developer tools** — Password Generator, Hash Generator, IP Calculator, JSON Formatter, Regex Tester, Text Diff, and more
- **HTML/Markdown converter** tools with live preview
- **Klingon pIqaD font** integration with full easter egg experience

### Fixed
- Dependency Map layout — containers no longer overlap (improved force simulation)
- Port Reference expanded to 57 ports (Docker, K8s, MQTT, RDP, etc.)

### Improved
- External audit findings addressed — 6 security tradeoffs fully documented, deployment recommendations table
- 384 tests across 29 test files (100% passing)

### Security
- All inline event handlers eliminated (67 `onclick=`/`onchange=` converted to `addEventListener`)
- CSP `scriptSrc` no longer includes `unsafe-inline`; `scriptSrcAttr` set to `none`

### Technical
- 4 new DB migrations (029-032): enterprise security, MFA, audit integrity, security alerts
- 5 new test files: TOTP, audit integrity, health endpoint, webhooks, stacks, images scan, alerts

## [4.2.0] - 2026-03-28

### Added — 20 New Features
- **Image pull progress** — real-time streaming per-layer progress bars via SSE
- **Resource limits editor** — visual sliders with presets (256MB-2GB memory, 0.5-4 CPU cores)
- **Bulk container actions** — checkboxes + floating action bar for batch start/stop/restart/remove
- **Theme & language sync** — user preferences saved server-side, synced across devices
- **Container file browser** — navigate, view, download files inside running containers
- **Docker Compose editor** — edit, validate, save & deploy compose configs inline
- **Scheduled actions** — cron-based automation with presets, execution history, run-now
- **Container diff** — filesystem changes vs base image with color-coded entries
- **Container rollback** — one-click revert to previous image with version history
- **Notifications center** — dedicated page with filters, pagination, bulk mark-read/delete
- **Dashboard customizable** — toggle widget visibility, order saved to server per user
- **Stacks page** — unified Compose + Git stacks management with actions
- **Container groups** — user-defined grouping with colors, beyond compose projects
- **API Playground** — browse and test all API endpoints from the UI with response viewer
- **AI Container Doctor** — diagnostics + 30 log patterns + AI prompt generator for ChatGPT/Claude
- **Cost Optimizer page** — per-container cost breakdown, idle detection, savings recommendations
- **Dependency Map** — interactive canvas graph showing container relationships
- **Deployment Pipelines** — staged pull → scan → swap → verify → notify with history
- **Mobile responsive** — full UI on phone/tablet with 360px-768px breakpoints
- **Container health dots** — color-coded indicator in list view with summary bar

### Security
- Eliminated all remaining `execSync` with user input (firewall, compose, Docker login)
- Groups routes: `requireRole('admin','operator')` on all write endpoints
- Global prototype pollution protection middleware
- Unified password policy enforced on all 4 auth flows

### Testing
- **231 new tests** across 14 test files (104 → 335 total)
- CRITICAL: RBAC enforcement, SQL injection, path traversal, prototype pollution, password policy
- HIGH: log patterns, groups service, preferences, notifications, pipeline service
- MEDIUM: templates CRUD, schedules, cost analysis, validation, health endpoint

### Technical
- 5 new DB migrations (024-028)
- 6 new frontend pages
- 3 new backend services (groups, pipeline, log-patterns)
- 34 files changed, 5,492 insertions

## [4.1.0] - 2026-03-28

### Added
- **Grype vulnerability scanner** — third scanning option alongside Trivy and Docker Scout (auto-fallback: Trivy → Grype → Scout)
- **Custom templates** — add, edit, delete your own app templates (System > Templates) with full CRUD
- **Built-in template overrides** — modify default templates, tracked with who/when modification badges
- **Template preview** — view docker-compose.yml before deploying with Copy button
- **Template deploy endpoint** — `POST /templates/:id/deploy` writes temp compose and runs `docker compose up -d`
- **Container health score dot** — color-coded indicator in list view (green/yellow/orange/red)
- **Container summary bar** — total, running, stopped, needs attention counts with clickable state filters
- **Host info bar** on dashboard — hostname, CPUs, RAM, Docker version, storage driver, OS, uptime
- **Container detail tabs** — Labels (grouped by type), Mounts, Network with port bindings
- **About page** — GitHub repository link, author info

### Fixed
- **Export Container Configuration** dialog no longer closes immediately (Modal.close 200ms timer race condition)
- **System > Templates** tab now loads correctly (duplicate `getTemplates()` API method removed)
- **Container summary bar** spans full width in 2-column layout
- **Dockerfile healthcheck** uses configurable `APP_PORT` via shell expansion

### Security
- **Unified password policy** — `validatePassword()` enforced on all 4 password flows (change-password, reset-password, create-user, token-reset)

### Improved
- **Caddyfile** converted to generic template with `YOUR_HOST` placeholder
- **EVENT_RETENTION_DAYS** aligned to 7 across `.env.example`, config, README
- **README badges** linked to verifiable artifacts (CI pipeline, SECURITY.md audit history)
- **Template count** fixed: 30 everywhere (was inconsistent 20 vs 30)

## [4.0.0] - 2026-03-28

### Added
- **Insights page** — executive dashboard aggregating health scores, recommendations, stale images, footprint
- **Compare page** — interactive 52-feature matrix vs Portainer/Dockge/Dockhand with search
- **Templates browser** — 30 curated app templates (System > Templates) with search, filter, one-click deploy
- **Workflows manager** — create/manage IF-THEN automation rules (Settings > Workflows)
- **Reset password dialog** — admin resets passwords directly from Settings > Users (no email required)
- **Container rename** button in container detail view
- **Safe Update** button — Trivy scan before container swap, blocks critical CVEs
- **Diagnose** button — 8-step troubleshooting wizard in modal
- **Dashboard clickable charts** — click CPU/memory bar → navigate to container
- **Live container count** badge in sidebar (running/total via WebSocket)
- **Dashboard "last updated"** timestamp in header
- **Audit CSV export** — download audit log as CSV file
- **Audit analytics** modal — top users, top actions
- **Database backup** button (System > Database > Create Backup Now)
- **Keyboard shortcuts** — `?` help modal, `g+key` vim-style navigation (g+d dashboard, g+c containers, etc.)
- **Professional error boundary** — catches all uncaught errors with EMS PRO-style overlay
- **Welcome onboarding** modal for first-time users
- **Dark mode toggle** on login page
- **System overview API** — `GET /api/overview` complete infrastructure snapshot
- **API documentation** endpoint — `GET /api/docs` (70+ endpoints documented)
- **Daily auto-backup** — cron at 02:00, keeps 7 daily backups
- **Connection status** indicator in sidebar footer
- **OS theme auto-detection** — follows system preference changes
- **Forgot password** hint on login page
- **Version display** on login page footer
- 10 new app templates (Elasticsearch, RabbitMQ, MailHog, Plausible, File Browser, Watchtower, Drone CI, Ghost, WireGuard, Portainer CE)
- 20 new tests (104 total across 8 files)
- Open Graph meta tags for social link previews
- GitHub v4.0 milestone with 6 roadmap issues
- GitHub Discussions enabled

### Fixed
- **Login error message** not showing on wrong password (handleUnauthorized was recreating the form)
- **Password reset** not working (was calling updateUser which ignores password field — now calls /reset-password with bcrypt)
- **Auto-logout** after resetting own password
- **APP_SECRET validation** false positive (empty string in weak list matched everything)
- **Cache busting** — JS file versions updated to force browser reload
- **i18n nav labels** — Insights, Git Stacks, Compare, section labels translated (EN/RO/DE)
- **Chart.js light theme** colors adapted to theme

### Security
- Strong APP_SECRET enforced on production server
- SECURITY.md updated with full architecture documentation
- 4 vulnerability fixes documented (DD-001 through DD-004)

### Changed
- Version bumped from 3.10.2 to 4.0.0
- README badges updated (104 tests, security audited)
- CONTRIBUTING.md updated with "Good First Issues" section
- Docker socket security documented in README

## [3.10.2] - 2026-03-28

### Added
- Interactive **Comparison page** — 52 features vs Portainer/Dockge/Dockhand with search/filter
- **17 API integration tests** with supertest (84 total tests)
- **GitHub issue/PR templates** for community contributions
- **README badges** — CI, version, license, tests, production readiness

### Changed
- GitHub repo description and 12 topics for discoverability
- .env.example updated with all v3 environment variables

## [3.10.1] - 2026-03-27

### Added
- **Welcome onboarding modal** for first-time users (Ctrl+K, theme, language tips)
- **ARIA labels** auto-applied to all icon-only action buttons
- **Toast `role="alert"`** for screen reader accessibility
- **Tab ARIA roles** (`role="tablist"`, `role="tab"`) on all tab components
- **Auto-refresh** on Volumes and Networks pages (30s interval)
- **Chart.js theme-aware colors** (light/dark auto-detection)

## [3.10.0] - 2026-03-27

### Fixed
- Dashboard **error state** — shows retry banner on API failure (was silent)
- **WCAG contrast** — text-dim darkened to pass 4.5:1 ratio
- **Focus-visible** keyboard navigation outlines on all interactive elements
- **Password policy** unified to 8 chars minimum everywhere
- **Sidebar icons** deduplicated (Firewall=fire, Hosts=sitemap)

### Added
- **Sidebar section labels** — Resources, Operations, Admin

## [3.9.0] - 2026-03-27

### Security
- **scrypt KDF** for encryption key derivation (replaces improvised padding)
- **Startup validation** — warns on weak APP_SECRET/ENCRYPTION_KEY in production
- **Trust proxy** restricted to loopback in production mode
- **JSON body limit** reduced from 10MB to 2MB

### Added
- **Database backup API** — POST /api/backup/database
- **GitHub Actions CI** — tests + syntax + i18n on every push
- **ESLint** — 0 errors, basic security rules

## [3.8.0] - 2026-03-27

### Security
- **Input validation middleware** — validateId, validateBody, sanitizeBody
- **Prototype pollution protection** on all request bodies
- **Git deploy/push rate limited** to 5/min/IP
- **Enhanced error handler** — 5xx no longer leaks internal details
- **SSH key cleanup** on startup (removes stale keys >24h)

### Fixed
- All `JSON.parse` calls wrapped with safe tryParseJson
- `console.log` in DB migrations replaced with structured logger

## [3.7.1] - 2026-03-27

### Security (CRITICAL)
- **Command injection** via Docker labels fixed — execFileSync replaces execSync
- **ReDoS** via user regex fixed — length limit + timeout test
- **Smart-restart DoS** fixed — returns backoff delay instead of blocking

## [3.7.0] - 2026-03-27

### Added
- **Event-driven notifications** — container crash/OOM/unhealthy auto-sent to all channels
- **Global search** — search containers, images, volumes, networks, Git stacks, audit log
- **Container dependency graph** — network-based relationship mapping

## [3.6.0] - 2026-03-27

### Added
- **Stack export** — download compose stack as portable JSON bundle
- **Stack import** — upload bundle and deploy on any host
- **Import preview** — validate before deploying
- **Generate compose** from any bundle

## [3.5.0] - 2026-03-27

### Added
- **Cross-host container migration** with zero-downtime
- **Stack migration** — all containers in a compose stack
- **Migration preview** (dry run) with warnings
- Health check verification before stopping source

## [3.4.0] - 2026-03-27

### Added
- **Workflow automation** — IF-THEN rules (CPU high → restart, crash → notify)
- **Dashboard preferences** — per-user widget order and visibility
- **README** completely rewritten with 60+ features

## [3.3.0] - 2026-03-27

### Added
- **Mobile responsive UI** — hamburger menu, touch-friendly buttons, scrollable tables
- **Resource recommendations** — smart analysis with actionable advice
- **Comparison API** — /api/compare returns feature matrix

## [3.2.0] - 2026-03-27

### Added
- **Enhanced log search** — regex, log level filtering (ERROR/WARN/INFO/DEBUG)
- **App template marketplace** — 20 curated one-click templates
- **Watchtower detection** — migration advisory to Docker Dash native updates

## [3.1.0] - 2026-03-27

### Added
- **Scheduled maintenance windows** — cron-based pull/scan/update
- **Smart restart** with exponential backoff and crash-loop detection
- **Public status page** — unauthenticated service status

## [3.0.0] - 2026-03-27

### Added
- **Deploy preview** — check for image updates via digest comparison
- **Safe-pull container update** — Trivy scan before swap, blocks critical CVEs
- **Guided troubleshooting wizard** — 8-step diagnostic for any container

## [2.10.0] - 2026-03-27

### Added
- **Image freshness dashboard** — freshness score based on age + vulnerabilities
- **Audit log analytics** — top users, actions, targets, hourly/daily heatmap

## [2.9.0] - 2026-03-27

### Added
- **Container uptime reports** — uptime %, restarts, hours tracked
- **Resource usage trends** — 7-day linear regression with 24h forecasting
- **Memory exhaustion prediction** — "will exceed limit in N hours"
- **Per-container cost estimation** — weighted CPU+memory share of VPS cost

## [2.8.0] - 2026-03-27

### Added
- **docker run → Compose converter**
- **AI-powered log analysis** — diagnostic prompts for ChatGPT/Claude
- **Traefik/Caddy label generator** — domain + port → ready-to-use labels
- **Tools tab** in System page

## [2.7.0] - 2026-03-27

### Added
- **7 notification channels** — Discord, Slack, Telegram, Ntfy, Gotify, Email, Webhook
- **SSO header authentication** — Authelia, Authentik, Caddy, Traefik support

## [2.6.0] - 2026-03-27

### Added
- **Container Health Score** (0-100) — composite from state, health, restarts, CPU/memory
- **Plain-English container status** — exit codes mapped to human-readable messages
- **Self-reporting resource footprint** — /api/footprint endpoint

## [2.2.0 - 2.5.0] - 2026-03-27

### Added
- **Git integration** — deploy from repos, credentials, webhooks, polling
- **Diff view** — see changes before redeploying
- **Deployment rollback** — revert to any previous deployment
- **Push to Git** — edit compose in UI, commit and push
- **Multi-file compose** — multiple YAML override files
- **Environment variable management** — per-stack overrides with encryption
- **Custom CA certificates** — for self-hosted Git servers
